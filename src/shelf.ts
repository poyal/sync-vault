import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { chunkSize, inventory, safeName } from "./files";
import type { Source } from "./types";

const changed = "원본이 변경되거나 삭제되었습니다. 목록을 새로고침하세요.";
const preparedLifetime = 10 * 60 * 1000;
export function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  return (
    !rel ||
    (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep))
  );
}
const version = (s: import("node:fs").Stats) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
type Prepared = {
  item: string;
  used: number;
  entries?: Source[];
  error?: string;
};
export class Shelf {
  private prepared = new Map<string, Prepared>();
  isServing() {
    const now = Date.now();
    return [...this.prepared.values()].some(p => !p.error && now - p.used <= preparedLifetime);
  }
  constructor(
    readonly root: string,
    private key: Buffer,
  ) {}
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.check(this.root);
  }
  private async check(file: string) {
    const actual = await fs.realpath(file).catch(() => {
      throw Error(changed);
    });
    if (
      path.relative(
        path.resolve(file).normalize("NFC"),
        actual.normalize("NFC"),
      ) !== "" ||
      !inside(this.root, file)
    )
      throw Error("공유 폴더의 일반 파일과 폴더만 가져올 수 있습니다.");
    return fs.lstat(file);
  }
  private token(file: string, stat: import("node:fs").Stats) {
    const body = Buffer.from(
      JSON.stringify([
        path.relative(this.root, file).split(path.sep).join("/"),
        version(stat),
      ]),
    ).toString("base64url");
    return (
      body +
      "." +
      createHmac("sha256", this.key).update(body).digest("base64url")
    );
  }
  private async resolve(id: string) {
    const [body, sig] = z
      .string()
      .min(3)
      .max(18000)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
      .parse(id)
      .split(".");
    const proof = createHmac("sha256", this.key)
      .update(body)
      .digest("base64url");
    if (
      !sig ||
      sig.length !== proof.length ||
      !timingSafeEqual(Buffer.from(sig, "ascii"), Buffer.from(proof))
    )
      throw Error(changed);
    const [rel, stamp] = z
      .tuple([z.string(), z.string()])
      .parse(JSON.parse(Buffer.from(body, "base64url").toString()));
    const file = path.resolve(this.root, rel);
    const stat = await this.check(file);
    if (version(stat) !== stamp || !(stat.isDirectory() || stat.isFile()))
      throw Error(changed);
    return file;
  }
  async list(id = "", offset = 0) {
    const folder = id ? await this.resolve(id) : this.root;
    await this.check(folder);
    const items = (await fs.readdir(folder, { withFileTypes: true }))
      .filter((d) => (d.isFile() || d.isDirectory()) && safeName(d.name))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name, "ko"),
      );
    const page = items.slice(offset, offset + 60);
    const rows = await Promise.all(
      page.map(async (d) => {
        const file = path.join(folder, d.name),
          stat = await this.check(file);
        return {
          id: this.token(file, stat),
          name: d.name.normalize("NFC"),
          dir: stat.isDirectory(),
          size: stat.size,
        };
      }),
    );
    return {
      rows,
      next: offset + page.length < items.length ? offset + page.length : null,
    };
  }
  clear(peer?: string) {
    for (const k of this.prepared.keys())
      if (!peer || k.startsWith(peer + "/")) this.prepared.delete(k);
  }
  async manifest(
    peer: string,
    job: string,
    item: string,
    offset: number,
    guard: () => void,
  ) {
    const key = peer + "/" + job;
    for (const [k, v] of this.prepared)
      if (Date.now() - v.used > preparedLifetime) this.prepared.delete(k);
    let p = this.prepared.get(key);
    if (!p) {
      if (this.prepared.size >= 32)
        throw Error("준비 중인 요청이 많습니다. 잠시 뒤 다시 시도하세요.");
      const file = await this.resolve(item);
      guard();
      p = this.prepared.get(key);
      if (!p) {
        const prep: Prepared = { item, used: Date.now() };
        this.prepared.set(key, prep);
        p = prep;
        const validate = async (f: string) => {
          guard();
          if (this.prepared.get(key) !== prep)
            throw Error("가져오기가 중지되었습니다.");
          await this.check(f);
        };
        void inventory([file], validate)
          .then(async (entries) => {
            await this.resolve(item);
            prep.entries = entries;
          })
          .catch((e) => {
            prep.error =
              e.message === changed
                ? changed
                : "원본 목록을 준비할 수 없습니다. 파일과 공유 상태를 확인하세요.";
          });
      }
    }
    if (p.item !== item || p.error) throw Error(p.error || changed);
    p.used = Date.now();
    if (!p.entries) return { preparing: true };
    const slice = p.entries
      .slice(offset, offset + 40)
      .map(({ name, size, hash, dir }) => ({ name, size, hash, dir }));
    return { entries: slice, total: p.entries.length };
  }
  async release(peer: string, job: string, verify: boolean, guard: () => void) {
    const key = peer + "/" + job,
      prepared = this.prepared.get(key);
    if (!verify) {
      this.prepared.delete(key);
      return;
    }
    if (!prepared?.entries) throw Error("전송을 다시 준비하세요.");
    try {
      await this.resolve(prepared.item);
      for (let i = 0; i < prepared.entries.length; i += 64) {
        guard();
        await Promise.all(
          prepared.entries.slice(i, i + 64).map(async (e) => {
            const s = await this.check(e.source);
            if (
              s.dev !== e.device ||
              s.ino !== e.inode ||
              s.mtimeMs !== e.modified ||
              (!e.dir && s.size !== e.size)
            )
              throw Error(changed);
          }),
        );
      }
    } finally {
      this.prepared.delete(key);
    }
  }
  async part(peer: string, job: string, index: number, offset: number) {
    const prep = this.prepared.get(peer + "/" + job),
      e = prep?.entries?.[index];
    if (!e || e.dir || !prep) throw Error("전송을 다시 준비하세요.");
    prep.used = Date.now();
    const stat = await this.check(e.source);
    if (
      !stat.isFile() ||
      stat.size !== e.size ||
      stat.mtimeMs !== e.modified ||
      offset >= e.size
    )
      throw Error(changed);
    const h = await fs.open(
      e.source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await h.stat();
      if (
        version(opened) !== version(stat) ||
        opened.ino !== e.inode ||
        opened.dev !== e.device ||
        version(await this.check(e.source)) !== version(opened)
      )
        throw Error(changed);
      const bytes = Buffer.allocUnsafe(Math.min(chunkSize, e.size - offset));
      const r = await h.read(bytes, 0, bytes.length, offset);
      if (
        r.bytesRead !== bytes.length ||
        version(await h.stat()) !== version(stat)
      )
        throw Error(changed);
      return { data: bytes.toString("base64") };
    } finally {
      await h.close();
    }
  }
}

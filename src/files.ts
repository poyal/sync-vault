import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Store, writable, volumeRoot, defaults } from "./store";
import {
  uuid,
  type Source,
  type Offer,
  type Outgoing,
  type Incoming,
  type Entry,
  type Stamp,
} from "./types";
import { stampSchema } from "./content";
export const chunkSize = 4 * 1024 ** 2;
const maxEntries = 8000;
export const safeName = (s: string) =>
  s.length > 0 &&
  s.length <= 180 &&
  !/[<>:"\\|?*\u0000-\u001f]/.test(s) &&
  !/[. ]$/.test(s) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s);
export const offerSchema = z
  .object({
    id: z.string().regex(uuid),
    stamp: stampSchema.optional(),
    entries: z
      .array(
        z
          .object({
            name: z.string().max(8192),
            size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            dir: z.boolean(),
            hash: z.string().regex(/^(?:[a-f0-9]{64})?$/),
          })
          .strict(),
      )
      .min(1)
      .max(maxEntries),
  })
  .strict();
export function validateOffer(raw: unknown): Offer {
  const offer = offerSchema.parse(raw),
    seen = new Map<string, boolean>();
  for (const e of offer.entries) {
    const bits = e.name.split("/"),
      k = e.name.normalize("NFC").toLowerCase();
    if (
      !bits.every(safeName) ||
      seen.has(k) ||
      (bits.length > 1 && !seen.get(k.slice(0, k.lastIndexOf("/")))) ||
      (e.dir ? e.size !== 0 || e.hash !== "" : e.hash.length !== 64)
    )
      throw Error("양쪽 OS에서 사용할 수 없는 파일 목록입니다.");
    seen.set(k, e.dir);
  }
  return offer;
}
export async function digest(file: string, check?: (file: string) => Promise<void>) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    if (check) await check(file);
    h.update(b);
  }
  return h.digest("hex");
}
function numberedName(name: string, directory: boolean, number: number) {
  const ext = directory ? "" : path.extname(name);
  return name.slice(0, name.length - ext.length) + " (" + number + ")" + ext;
}
export async function inventory(paths: string[], check?: (file: string) => Promise<void>): Promise<Source[]> {
  const entries: Source[] = [];
  async function add(source: string, name: string) {
    if (entries.length >= maxEntries)
      throw Error("한 작업에는 8,000개까지 넣을 수 있습니다.");
    if (check) await check(source);
    const s = await fs.lstat(source);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
      throw Error("로컬 일반 파일과 폴더만 보낼 수 있습니다.");
    if (!safeName(path.basename(source)))
      throw Error("상대 OS에서 사용할 수 없는 파일명입니다.");
    const dir = s.isDirectory(),
      hash = dir ? "" : await digest(source, check);
    const after = await fs.lstat(source);
    if (
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs ||
      after.ino !== s.ino
    )
      throw Error("읽는 동안 원본이 바뀌었습니다.");
    entries.push({
      source,
      name: name.normalize("NFC"),
      dir,
      hash,
      size: dir ? 0 : s.size,
      modified: s.mtimeMs,
      ...(check ? {inode:s.ino,device:s.dev} : {}),
    });
    if (dir)
      for (const child of (await fs.readdir(source)).sort())
        await add(path.join(source, child), name + "/" + child);
  }
  const roots = [...new Set(paths.map((p) => path.resolve(p)))];
  const canonical = (name: string) => name.normalize("NFC").toLowerCase();
  const reserved = new Set(roots.map((p) => canonical(path.basename(p))));
  const used = new Set<string>();
  for (const file of roots) {
    const base = path.basename(file);
    let name = base;
    if (used.has(canonical(name))) {
      const dir = (await fs.lstat(file)).isDirectory();
      let n = 1;
      do {
        name = numberedName(base, dir, n++);
      } while (reserved.has(canonical(name)) || used.has(canonical(name)));
    }
    used.add(canonical(name));
    await add(file, name);
  }
  validateOffer({ id: randomUUID(), entries: entries.map(publicEntry) });
  return entries;
}
function publicEntry({ name, dir, size, hash }: Source): Entry {
  return { name, dir, size, hash };
}
export function createJob(
  entries: Source[],
  peer: string,
  stamp?: Stamp,
): Outgoing {
  return {
    id: randomUUID(),
    entries,
    peer,
    stamp,
    state: "대기",
    done: 0,
    total: entries.reduce((a, e) => a + e.size, 0),
  };
}
export type Send = (
  id: string,
  route: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<any>;
export async function transmit(
  job: Outgoing,
  send: Send,
  signal: AbortSignal,
  progress: () => void,
) {
  const call = (route: string, body: unknown) =>
    send(job.peer, route, body, signal);
  const offer = {
    id: job.id,
    entries: job.entries.map(publicEntry),
    stamp: job.stamp,
  };
  const result = await call("/offer", offer);
  if (result.status !== "ready") return result.status;
  let finished = 0;
  for (const [index, entry] of job.entries.entries()) {
    signal.throwIfAborted();
    if (entry.dir) continue;
    const route = "/part/" + job.id + "/" + index;
    let { offset, complete } = await call(route + "/status", {});
    if (complete) {
      finished += entry.size;
      job.done = finished;
      continue;
    }
    const src = await fs.open(
      entry.source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await src.stat();
      if (!info.isFile()) throw Error("원본 파일을 열 수 없습니다.");
      if (info.size !== entry.size || info.mtimeMs !== entry.modified) {
        const hash = await digest(entry.source);
        await call(route + "/replace", { size: info.size, hash });
        job.total += info.size - entry.size;
        Object.assign(entry, { size: info.size, modified: info.mtimeMs, hash });
        offset = 0;
        progress();
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.size)
        throw Error("이어받기 위치가 올바르지 않습니다.");
      while (offset < entry.size) {
        signal.throwIfAborted();
        const data = Buffer.allocUnsafe(
          Math.min(chunkSize, entry.size - offset),
        );
        const { bytesRead } = await src.read(data, 0, data.length, offset);
        if (bytesRead !== data.length)
          throw Error("보내는 중 파일이 바뀌었습니다.");
        const ack = await call(route + "/" + offset, data);
        if (ack.offset !== offset + bytesRead)
          throw Error("기록된 전송량이 일치하지 않습니다.");
        offset = ack.offset;
        job.done = finished + offset;
        progress();
      }
      await call(route + "/finish", {});
    } finally {
      await src.close();
    }
    finished += entry.size;
    job.done = finished;
  }
  await call("/finish", { id: job.id });
  return "complete";
}
async function unchangedDirectory(directory: string) {
  const actual = await fs.realpath(directory);
  if (actual === directory) return true;
  if (
    process.platform !== "darwin" ||
    actual.normalize("NFC") !== directory.normalize("NFC")
  ) return false;
  // HFS+ decomposes names. Accept that spelling only along ordinary directories.
  let current = directory;
  while (true) {
    if (!(await fs.lstat(current)).isDirectory()) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

export class Receiver {
  private busy = new Set<string>();
  get active() {
    return this.busy.size;
  }
  async pruneClipboard(current: string[]) {
    const folder = path.join(this.store.home, "clipboard-files");
    let root: string;
    try {
      root = await fs.realpath(folder);
    } catch {
      return;
    }
    const canonical = (f: string) =>
      process.platform === "win32"
        ? path.resolve(f).toLowerCase().normalize("NFC")
        : path.resolve(f).normalize("NFC");
    const keep = new Set(
      await Promise.all(
        current.map(async (f) =>
          canonical(await fs.realpath(f).catch(() => f)),
        ),
      ),
    );
    const old = this.store.state.incoming.filter(
      (j) =>
        j.offer.stamp &&
        j.state === "완료" &&
        j.root === root &&
        j.finished &&
        Date.now() - j.finished > 86400000 &&
        !Object.values(j.paths).some((p) => keep.has(canonical(p))),
    );
    for (const j of old) {
      for (const file of Object.values(j.paths)) {
        if (path.dirname(file) !== root) continue;
        await fs.unlink(file).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
      this.store.state.incoming = this.store.state.incoming.filter(
        (x) => x.id !== j.id,
      );
    }
    if (old.length) this.store.save();
  }
  async cancel(peer: string, id: string) {
    const find = () =>
      this.store.state.incoming.find((j) => j.id === id && j.peer === peer);
    let j = find();
    while (!j && this.busy.has(id)) {
      await new Promise((r) => setTimeout(r, 30));
      j = find();
    }
    if (!j || j.state === "완료") return;
    j.state = "취소";
    this.store.save();
    while (this.busy.has(id)) await new Promise((r) => setTimeout(r, 30));
    if (
      path.dirname(j.staging) === j.root &&
      path.basename(j.staging).startsWith(".sync-vault-") &&
      (await unchangedDirectory(j.root))
    )
      await fs.rm(j.staging, { recursive: true, force: true });
  }
  constructor(
    private store: Store,
    private onFiles: (stamp: Stamp, files: string[]) => Promise<void>,
    private allowed: (peer: string, stamp?: Stamp) => boolean,
  ) {}
  async offer(peer: string, raw: unknown, requested = false) {
    const offer = validateOffer(raw),
      state = this.store.state;
    let job = state.incoming.find((j) => j.id === offer.id);
    if (job) {
      if (
        job.peer !== peer ||
        job.offer.entries.length !== offer.entries.length ||
        job.offer.entries.some(
          (e, i) =>
            e.name !== offer.entries[i].name || e.dir !== offer.entries[i].dir,
        )
      )
        throw Error("전송 정보가 일치하지 않습니다.");
      return {
        status:
          job.state === "완료"
            ? "complete"
            : job.state === "승인 대기"
              ? "pending"
              : job.state === "취소"
                ? "cancelled"
                : "ready",
      };
    }
    if (!this.allowed(peer, offer.stamp))
      throw Error("현재 수신이 중지되었습니다.");
    if (
      offer.stamp &&
      (offer.stamp.origin !== peer ||
        offer.entries.length > state.settings.smallCount ||
        offer.entries.some((e) => e.dir) ||
        offer.entries.reduce((n, e) => n + e.size, 0) >
          state.settings.smallBytes)
    )
      throw Error("자동 파일 공유 범위를 초과했습니다.");
    const folder = offer.stamp
      ? path.join(this.store.home, "clipboard-files")
      : state.settings.receive;
    const root = writable(
      folder,
      !!offer.stamp ||
        (!state.receiveVolume &&
          folder === defaults(this.store.downloads).receive),
    );
    if (!offer.stamp) {
      const volume = volumeRoot(root);
      if (state.receiveVolume && volume !== state.receiveVolume)
        throw Error("선택한 수신 드라이브를 다시 연결하세요.");
      state.receiveVolume = volume;
    }
    const staging = await fs.mkdtemp(path.join(root, ".sync-vault-"));
    const auto =
      requested || !!offer.stamp || state.peers.find((p) => p.id === peer)?.autoAccept;
    job = {
      id: offer.id,
      peer,
      root,
      staging,
      offer,
      state: auto ? "수신 중" : "승인 대기",
      paths: {},
    };
    state.incoming.push(job);
    this.store.save();
    return { status: auto ? "ready" : "pending" };
  }
  async locked<T>(id: string, action: () => Promise<T>) {
    if (this.busy.has(id)) throw Error("같은 작업이 진행 중입니다.");
    this.busy.add(id);
    try {
      return await action();
    } finally {
      this.busy.delete(id);
    }
  }
  get(peer: string, id: string) {
    const job = this.store.state.incoming.find(
      (j) => j.id === id && j.peer === peer,
    );
    if (
      !job ||
      !this.allowed(peer, job.offer.stamp) ||
      !["수신 중", "완료"].includes(job.state)
    )
      throw Error("허용된 전송이 아닙니다.");
    return job;
  }
  async part(peer: string, id: string, i: number, op: string, body: any) {
    return this.locked(id, async () => {
      const j = this.get(peer, id),
        e = j.offer.entries[i];
      if (!e || e.dir || !Number.isSafeInteger(i))
        throw Error("잘못된 파일 번호입니다.");
      if (!(await unchangedDirectory(j.staging)))
        throw Error("임시 폴더가 변경되었습니다.");
      const file = path.join(j.staging, String(i)),
        ready = file + ".verified";
      const complete = await fs.stat(ready).then(
        () => true,
        () => false,
      );
      const offset = await fs.stat(file).then(
        (s) => s.size,
        () => 0,
      );
      j.received ??= {};
      j.received[i] = complete ? e.size : offset;
      if (op === "status")
        return { offset: complete ? e.size : offset, complete };
      if (op === "replace") {
        if (complete || j.offer.stamp)
          throw Error("원본이 변경되었습니다. 다시 복사해 주세요.");
        const { size, hash } = z
          .object({
            size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(body);
        await fs.rm(file, { force: true });
        Object.assign(e, { size, hash });
        this.store.save();
        return {};
      }
      if (op === "finish") {
        if (complete) return {};
        if (offset !== e.size) throw Error("파일 길이가 일치하지 않습니다.");
        if (!offset) {
          const h = await fs.open(file, "a", 0o600);
          await h.close();
        }
        if ((await digest(file)) !== e.hash) {
          await fs.unlink(file);
          throw Error("무결성 검사 실패. 해당 파일을 처음부터 다시 받습니다.");
        }
        this.get(peer, id);
        await fs.rename(file, ready);
        return {};
      }
      if (
        complete ||
        String(offset) !== op ||
        !Buffer.isBuffer(body) ||
        !body.length ||
        body.length > chunkSize ||
        offset + body.length > e.size
      )
        throw Error("전송 위치가 다릅니다.");
      const h = await fs.open(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await h.writeFile(body);
        await h.sync();
      } finally {
        await h.close();
      }
      j.received[i] = offset + body.length;
      return { offset: offset + body.length };
    });
  }
  async finish(peer: string, id: string) {
    return this.locked(id, async () => {
      const j = this.get(peer, id);
      if (j.state === "완료") return {};
      if (
        !(await unchangedDirectory(j.root)) ||
        !(await unchangedDirectory(j.staging))
      )
        throw Error("수신 경로가 바뀌었습니다.");
      const reserved = new Set(
        j.offer.entries.map((e) => e.name.normalize("NFC").toLowerCase()),
      );
      for (const [i, e] of j.offer.entries.entries()) {
        this.get(peer, id);
        if (Object.hasOwn(j.paths, e.name)) continue;
        const parent = e.name.includes("/")
          ? j.paths[e.name.slice(0, e.name.lastIndexOf("/"))]
          : j.root;
        if (!parent || !(await unchangedDirectory(parent)))
          throw Error("대상 폴더를 확인할 수 없습니다.");
        const name = path.posix.basename(e.name);
        for (let n = 0; ; n++) {
          const leaf = n ? numberedName(name, e.dir, n) : name;
          if (
            n &&
            reserved.has(
              path.posix
                .join(path.posix.dirname(e.name), leaf)
                .normalize("NFC")
                .toLowerCase(),
            )
          )
            continue;
          const target = path.join(parent, leaf);
          try {
            if (e.dir) await fs.mkdir(target, { mode: 0o700 });
            else {
              const verified = path.join(j.staging, i + ".verified");
              try {
                await fs.link(verified, target);
              } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "EEXIST") {
                  const [a, b] = await Promise.all([
                    fs.stat(verified, { bigint: true }),
                    fs.lstat(target, { bigint: true }),
                  ]);
                  if (!a.ino || a.dev !== b.dev || a.ino !== b.ino) throw err;
                } else if (["EPERM", "ENOTSUP", "EXDEV"].includes(code || ""))
                  await fs.copyFile(verified, target, constants.COPYFILE_EXCL);
                else throw err;
              }
            }
            Object.defineProperty(j.paths, e.name, {
              value: target,
              enumerable: true,
              configurable: true,
              writable: true,
            });
            this.store.save();
            break;
          } catch (err) {
            if ((err as any).code !== "EEXIST" || n >= 9999) throw err;
          }
        }
      }
      if (j.offer.stamp)
        await this.onFiles(
          j.offer.stamp,
          j.offer.entries.map((e) => j.paths[e.name]),
        );
      j.state = "완료";
      j.finished = Date.now();
      this.store.save();
      await fs.rm(j.staging, { recursive: true, force: true });
      return {};
    });
  }
}

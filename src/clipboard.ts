import { clipboard, ClipboardItem, nativeImage } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { clipSchema, cleanHTML, checkedPng, type Clip } from "./content";
import { newer, type Stamp } from "./types";
import { Store } from "./store";
const mark = "web application/x-sync-vault-origin";
type Snap = { seq: number; flag: number; paths: string[] };
export class Clips {
  locked = false;
  last = -1;
  private child?: ChildProcess;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private restart?: NodeJS.Timeout;
  constructor(
    private tool: string,
    private store: Store,
    private id: string,
    private send: (clip: Clip) => Promise<void>,
    private files: (paths: string[], stamp: Stamp) => Promise<void>,
    private note: (s: string) => void,
  ) {}
  private command(mode: string, input?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const c = execFile(
        this.tool,
        [mode],
        {
          windowsHide: true,
          encoding: "buffer",
          maxBuffer: 40 * 1024 ** 2,
          timeout: 8000,
        },
        (err, out) =>
          err
            ? reject(Error("클립보드 접근 실패. 운영체제 권한을 확인하세요."))
            : resolve(out),
      );
      c.stdin?.on("error", () => {});
      c.stdin?.end(input);
    });
  }
  private async snap(): Promise<Snap> {
    const b = await this.command("inspect");
    if (b.length < 5) throw Error("클립보드 상태를 읽을 수 없습니다.");
    return {
      seq: b.readUInt32LE(0),
      flag: b[4],
      paths: b.subarray(5).toString("utf8").split("\0").filter(Boolean),
    };
  }
  private enqueue<T>(fn: () => Promise<T>) {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch((e) => this.note((e as Error).message));
    return next;
  }
  async start() {
    if (this.stopped || this.child) return;
    try {
      if (this.last < 0) this.last = (await this.snap()).seq;
    } catch (e) {
      this.retryWatch();
      throw e;
    }
    if (this.stopped || this.child) return;
    const c = (this.child = spawn(this.tool, ["watch", String(process.pid)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }));
    createInterface({ input: c.stdout! }).on("line", () => {
      void this.enqueue(() => this.capture()).catch(() => {});
    });
    c.on("error", () => this.note("클립보드 감시를 시작할 수 없습니다."));
    c.on("close", () => {
      if (this.child === c) this.child = undefined;
      this.retryWatch();
    });
  }
  private retryWatch() {
    if (this.stopped || this.restart) return;
    this.restart = setTimeout(() => {
      this.restart = undefined;
      void this.start().catch((e) => this.note(e.message));
    }, 2000);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.restart);
    this.child?.kill();
  }
  get enabled() {
    return !this.locked && !this.store.state.settings.paused && !this.stopped;
  }
  private async capture() {
    const s = await this.snap();
    if (s.seq === this.last) return;
    this.last = s.seq;
    if (s.flag === 2) return;
    if (
      !s.flag &&
      !s.paths.length &&
      this.enabled &&
      (await clipboard.has(mark))
    )
      return;
    const stamp = {
      origin: this.id,
      clock:
        Math.max(this.store.state.stamp.clock, this.store.state.observed || 0) +
        1,
    };
    this.store.state.stamp = stamp;
    this.store.save();
    if (!this.enabled || s.flag === 1) return;
    const config = this.store.state.settings;
    if (s.paths.length) {
      if (config.files)
        void this.files(s.paths, stamp).catch((e) => this.note(e.message));
      return;
    }
    const items = await clipboard.read();
    if ((await this.snap()).seq !== s.seq) return;
    if (items.some((i) => i.types.includes(mark))) return;
    const imgs: Buffer[] = [];
    if (config.image) {
      if (process.platform === "darwin") {
        const raw = await this.command("images");
        for (let o = 0; o < raw.length;) {
          const n = raw.readUInt32LE(o);
          o += 4;
          if (!n || o + n > raw.length) throw Error("이미지 목록 오류");
          imgs.push(checkedPng(raw.subarray(o, o + n)));
          o += n;
        }
      }
      if (!imgs.length)
        for (const item of items) {
          const type = item.types.includes("image/png")
            ? "image/png"
            : item.types.find((t) => t.startsWith("image/"));
          if (!type) continue;
          const blob = await item.getType(type);
          if (!(blob instanceof Blob) || blob.size > 32 * 1024 ** 2)
            throw Error("이미지 크기 초과");
          const raw = Buffer.from(await blob.arrayBuffer());
          imgs.push(
            checkedPng(
              type === "image/png"
                ? raw
                : nativeImage.createFromBuffer(raw).toPNG(),
            ),
          );
        }
    }
    if ((await this.snap()).seq !== s.seq) return;
    if (imgs.length > 1) {
      const folder = path.join(this.store.home, "image-cache", randomUUID());
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const names = [];
      for (const [i, img] of imgs.entries()) {
        const f = path.join(folder, "Image-" + (i + 1) + ".png");
        await fs.writeFile(f, img);
        names.push(f);
      }
      void this.files(names, stamp).catch((e) => this.note(e.message));
      return;
    }
    if (imgs.length) {
      void this.send({
        kind: "image",
        png: imgs[0].toString("base64"),
        stamp,
      }).catch((e) => this.note(e.message));
      return;
    }
    if (!config.text) return;
    let text = "",
      html = "";
    for (const item of items) {
      for (const type of ["text/plain", "text/html"]) {
        if (!item.types.includes(type)) continue;
        const blob = await item.getType(type);
        if (!(blob instanceof Blob) || blob.size > 2 * 1024 ** 2) return;
        if (type === "text/plain")
          text += (text ? "\n" : "") + (await blob.text());
        else html += cleanHTML(await blob.text());
      }
    }
    if ((text || html) && (await this.snap()).seq === s.seq)
      void this.send(
        clipSchema.parse({
          kind: "text",
          text,
          html: html || undefined,
          stamp,
        }),
      ).catch((e) => this.note(e.message));
  }
  private apply(
    stamp: Stamp,
    kind: "text" | "image" | "files",
    fn: () => Promise<void>,
  ) {
    return this.enqueue(async () => {
      await this.capture();
      if (
        !this.enabled ||
        !this.store.state.settings[kind] ||
        !newer(stamp, this.store.state.stamp)
      )
        return;
      await fn();
      this.last = (await this.snap()).seq;
      this.store.state.stamp = stamp;
      this.store.save();
    });
  }
  receive(peer: string, raw: unknown) {
    const c = clipSchema.parse(raw);
    if (c.stamp.origin !== peer) throw Error("클립보드 발신자가 다릅니다.");
    return this.apply(c.stamp, c.kind, async () => {
      if (process.platform === "darwin") {
        const value =
          c.kind === "image"
            ? {
                png: checkedPng(Buffer.from(c.png, "base64")).toString(
                  "base64",
                ),
              }
            : { text: c.text, html: c.html ? cleanHTML(c.html) : undefined };
        await this.command("content", Buffer.from(JSON.stringify(value)));
        return;
      }
      const data: Record<string, Blob> = { [mark]: new Blob([c.stamp.origin]) };
      data[
        'electron application/osclipboard;format="CanUploadToCloudClipboard"'
      ] = new Blob([new Uint8Array(4)]);
      if (c.kind === "image")
        data["image/png"] = new Blob(
          [new Uint8Array(checkedPng(Buffer.from(c.png, "base64")))],
          { type: "image/png" },
        );
      else {
        data["text/plain"] = new Blob([c.text], { type: "text/plain" });
        if (c.html)
          data["text/html"] = new Blob([cleanHTML(c.html)], {
            type: "text/html",
          });
      }
      await clipboard.write([new ClipboardItem(data)]);
    });
  }
  receiveFiles(stamp: Stamp, paths: string[]) {
    return this.apply(stamp, "files", async () => {
      await this.command("files", Buffer.from(paths.join("\0") + "\0"));
    });
  }
  async resetBaseline() {
    await this.enqueue(async () => {
      this.last = (await this.snap()).seq;
    });
  }
  async currentFiles() {
    return (await this.snap()).paths;
  }
  async pruneImages() {
    const root = path.join(this.store.home, "image-cache");
    const folders = await fs.readdir(root, { withFileTypes: true }).catch(e => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const active = new Set(this.store.state.outgoing
      .filter(j => j.state !== "완료" && j.state !== "취소")
      .flatMap(j => j.entries.map(e => path.dirname(e.source))));
    for (const entry of folders) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      if (active.has(dir) || Date.now() - (await fs.stat(dir)).mtimeMs < 86400000) continue;
      // Only cache files created by capture() are eligible for expiry.
      for (const f of await fs.readdir(dir, { withFileTypes: true }))
        if (f.isFile() && /^Image-\d+\.png$/.test(f.name)) await fs.unlink(path.join(dir, f.name));
      await fs.rmdir(dir).catch(e => { if (e.code !== "ENOTEMPTY") throw e; });
    }
  }
}

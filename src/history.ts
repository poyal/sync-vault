import fs from "node:fs/promises";
import path from "node:path";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { z } from "zod";
import { checkedPng, cleanHTML, clipSchema, type Clip } from "./content";

const summary = z.object({
  id: z.string().uuid(),
  time: z.number(),
  kind: z.enum(["text", "image"]),
  preview: z.string().max(160),
  thumb: z.string().max(32000).optional(),
});
type Summary = z.infer<typeof summary>;

export class History {
  private entries: Summary[] = [];
  private queue = Promise.resolve();
  constructor(
    private dir: string,
    private key: Buffer,
    private limit: () => number,
    private thumbnail?: (bytes: Buffer) => string | undefined,
  ) {}
  private async read(file: string) {
    const b = await fs.readFile(path.join(this.dir, file));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      b.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(file));
    decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(b.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  }
  private async write(file: string, value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(file));
    const content = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const target = path.join(this.dir, file),
      temp = target + ".tmp";
    await fs.writeFile(
      temp,
      Buffer.concat([iv, cipher.getAuthTag(), content]),
      { mode: 0o600 },
    );
    await fs.rename(temp, target);
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.entries = summary
        .array()
        .max(50)
        .parse(await this.read("index"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const keep = new Set(this.entries.map((e) => e.id));
    for (const f of await fs.readdir(this.dir))
      if (
        (/^[a-f0-9-]{36}$/.test(f) && !keep.has(f)) ||
        /^(index|[a-f0-9-]{36})\.tmp$/.test(f)
      )
        await fs.unlink(path.join(this.dir, f));
    await this.trim();
  }
  private serial<T>(fn: () => Promise<T>) {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async replace(next: Summary[]) {
    const prev = this.entries;
    await this.write("index", next);
    this.entries = next;
    for (const e of prev)
      if (!next.some((n) => n.id === e.id))
        await fs.rm(path.join(this.dir, e.id), { force: true });
  }
  list() {
    return this.entries.map((e) => ({ ...e }));
  }
  add(raw: Clip, allowed = () => true) {
    return this.serial(async () => {
      if (!allowed()) return;
      const clip = clipSchema.parse(raw);
      let thumb: string | undefined;
      if (clip.kind === "image")
        thumb = this.thumbnail?.(checkedPng(Buffer.from(clip.png, "base64")));
      else if (clip.html) clip.html = cleanHTML(clip.html);
      const entry = {
        id: randomUUID(),
        kind: clip.kind,
        ...(thumb ? { thumb } : {}),
        time: Date.now(),
        preview:
          clip.kind === "image"
            ? "PNG 이미지"
            : (clip.text || clip.html?.replace(/<[^>]+>/g, " ") || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 140),
      };
      await this.write(entry.id, clip);
      if (!allowed()) {
        await fs.unlink(path.join(this.dir, entry.id));
        return;
      }
      await this.replace([entry, ...this.entries].slice(0, this.limit()));
    });
  }
  trim() {
    return this.serial(async () => {
      if (this.entries.length > this.limit())
        await this.replace(this.entries.slice(0, this.limit()));
    });
  }
  remove(id?: string) {
    return this.serial(() =>
      this.replace(
        id === undefined ? [] : this.entries.filter((e) => e.id !== id),
      ),
    );
  }
  get(id: string): Promise<Clip> {
    return this.serial(async () => {
      if (!this.entries.some((e) => e.id === id))
        throw Error("이 클립보드 항목이 만료되었습니다.");
      return clipSchema.parse(await this.read(id));
    });
  }
}

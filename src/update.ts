import fs from "node:fs/promises";
import { createWriteStream, openSync, closeSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash, createPublicKey, verify } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { assetBytes, assetStream, latestRelease } from "./github-release";
const run = promisify(execFile);
const ver = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const asset = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+\.zip$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
});
const schema = z.object({
  format: z.literal("sync-vault-update-v1"),
  version: ver,
  notes: z.string().max(8000),
  platforms: z.record(z.string(), asset),
});
export function verifyManifest(bytes: Buffer, sig: Buffer, key: string) {
  if (
    bytes.length > 65536 ||
    sig.length !== 64 ||
    createPublicKey(key).asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, key, sig)
  )
    throw Error("업데이트 배포 서명이 일치하지 않습니다.");
  return schema.parse(JSON.parse(bytes.toString("utf8")));
}
export function compare(a: string, b: string) {
  const x = ver.parse(a).split(".").map(Number),
    y = ver.parse(b).split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
export class Updater {
  status = "대기";
  notes = "";
  next = "";
  percent = 0;
  ready = false;
  private target?: z.infer<typeof asset>;
  private dir = "";
  private ctrl?: AbortController;
  private downloadUrl = "";
  get busy() { return this.ctrl !== undefined; }
  constructor(
    private home: string,
    private current: string,
    private key: string,
    private changed: () => void,
  ) {}
  async check() {
    if (this.ctrl || this.ready) return;
    if (!this.key) {
      this.status =
        "서명 공개키 미설정 · 새 EXE 또는 DMG로 개별 업데이트하세요.";
      this.changed();
      return;
    }
    this.ctrl = new AbortController();
    this.status = "버전 확인 중";
    this.changed();
    try {
      const signal = AbortSignal.any([
        this.ctrl.signal,
        AbortSignal.timeout(15000),
      ]);

      this.target = undefined;
      this.downloadUrl = "";
      this.next = "";
      this.notes = "";
      const release = await latestRelease(signal);
      this.next = release.version;
      if (compare(release.version, this.current) <= 0) {
        this.status = "최신 버전입니다.";
        return;
      }
      const [manifest, signature] = await Promise.all([
        assetBytes(release.asset("update.json"), 65536, signal),
        assetBytes(release.asset("update.sig", 64), 64, signal),
      ]);
      const signed = verifyManifest(manifest, signature, this.key);
      if (signed.version !== release.version) throw Error("GitHub 태그와 서명된 버전이 다릅니다.");
      this.notes = signed.notes;
      const platform = process.platform + "-" + process.arch;
      const target = signed.platforms[platform];
      if (target) {
        if (target.name !== "SyncVault-" + release.version + "-" + platform + ".zip")
          throw Error("대상 패키지 이름이 다릅니다.");
        this.downloadUrl = release.asset(target.name, target.size);
        this.target = target;
      }
      this.status = this.target
        ? "다운로드 가능"
        : "이 OS의 업데이트가 아직 없습니다.";
    } catch (e) {
      this.status = "확인 실패 · " + (e as Error).message;
      this.target = undefined;
    } finally {
      this.ctrl = undefined;
      this.changed();
    }
  }
  cancel() {
    this.ctrl?.abort();
  }
  async download() {
    if (!this.target || this.ctrl || this.ready)
      throw Error("업데이트를 먼저 확인하세요.");
    const a = this.target;
    this.ctrl = new AbortController();
    this.percent = 0;
    this.status = "다운로드 중";
    this.changed();
    this.dir = path.join(this.home, "updates", randomUUID());
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const hash = createHash("sha256");
      let bytes = 0;
      const self = this;
      const signal = this.ctrl.signal;
      const source = Readable.from(await assetStream(this.downloadUrl, signal));
      const measure = new Transform({
        transform(b, _e, cb) {
          bytes += b.length;
          if (bytes > a.size) {
            cb(Error("크기 초과"));
            return;
          }
          hash.update(b);
          self.percent = Math.floor((bytes / a.size) * 100);
          self.changed();
          cb(null, b);
        },
      });
      await pipeline(
        source,
        measure,
        createWriteStream(path.join(this.dir, "update.zip"), {
          flags: "wx",
          mode: 0o600,
        }),
        { signal: this.ctrl.signal },
      );
      if (bytes !== a.size || hash.digest("hex") !== a.sha256)
        throw Error("설치 파일 무결성 검사 실패");
      this.ready = true;
      this.status = "재시작하여 설치";
    } catch (e) {
      this.status = this.ctrl.signal.aborted ? "다운로드 취소됨" : "다운로드 중단 · " + (e as Error).message;
      await fs.rm(this.dir, { recursive: true, force: true });
    } finally {
      this.ctrl = undefined;
      this.changed();
    }
  }
  async prepare(exe: string, scripts: string) {
    if (!this.ready || !this.target) throw Error("검증된 업데이트가 없습니다.");
    const win = process.platform === "win32",
      target = win ? path.dirname(exe) : path.resolve(exe, "../../..");
    if (!win && target.startsWith("/Volumes/"))
      throw Error("응용 프로그램 폴더에 설치한 뒤 업데이트하세요.");
    const parent = path.dirname(target),
      container = await fs.mkdtemp(path.join(parent, ".syncvault-update-"));
    try {
      const stage = path.join(container, "new");
      await fs.mkdir(stage);
      const archive = path.join(this.dir, "update.zip"),
        h = createHash("sha256");
      for await (const b of (await import("node:fs")).createReadStream(archive))
        h.update(b);
      if (h.digest("hex") !== this.target.sha256)
        throw Error("업데이트 파일이 변경되었습니다.");
      const tar = win
        ? path.join(process.env.SystemRoot!, "System32", "tar.exe")
        : "/usr/bin/tar";
      const { stdout } = await run(tar, ["-tf", archive], {
        maxBuffer: 8 * 1024 ** 2,
        windowsHide: true,
      });
      if (
        stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .some(
            (n) =>
              n.startsWith("/") ||
              n.includes("\\") ||
              n.includes(":") ||
              n.split("/").includes(".."),
          )
      )
        throw Error("설치 경로 오류");
      await run(tar, ["-xf", archive, "-C", stage], { windowsHide: true });
      const replacement = win ? stage : path.join(stage, "Sync Vault.app");
      await fs.access(
        path.join(
          replacement,
          win ? "Sync Vault.exe" : "Contents/MacOS/Sync Vault",
        ),
      );
      const helper = path.join(this.dir, win ? "swap.ps1" : "swap.sh");
      await fs.copyFile(
        path.join(scripts, win ? "swap.ps1" : "swap.sh"),
        helper,
      );
      const ticket = randomUUID();
      const args = [
        String(process.pid),
        target,
        replacement,
        container,
        this.home,
        this.dir,
        ticket,
      ];
      return async () => {
        for (const name of ["state.json", "state.json.bak"])
          await fs
            .copyFile(path.join(this.home, name), path.join(this.dir, name))
            .catch((e) => {
              if (e.code !== "ENOENT") throw e;
            });
        if (win) {
          const launcher = path.join(
            target,
            "resources",
            "native",
            "update-launch.exe",
          );
          await run(launcher, [helper, ...args], {
            cwd: this.dir,
            windowsHide: true,
          });
          const started = path.join(this.dir, "started");
          for (let i = 0; i < 150; i++) {
            if (
              await fs.readFile(started, "utf8").then(
                (v) => v.trim() === ticket,
                () => false,
              )
            ) {
              await fs.writeFile(path.join(this.dir, "commit"), ticket, {
                mode: 0o600,
              });
              return;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          throw Error("설치 도우미가 시작되지 않았습니다.");
        }
        const log = openSync(path.join(this.dir, "install.log"), "a", 0o600);
        try {
          const child = spawn("/bin/sh", [helper, ...args], {
            detached: true,
            stdio: ["ignore", log, log],
            cwd: this.dir,
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          child.unref();
        } finally {
          closeSync(log);
        }
      };
    } catch (error) {
      // Only the private staging directory returned by mkdtemp is removed.
      await fs.rm(container, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

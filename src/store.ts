import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Settings, Peer, Outgoing, Incoming, Pull, Stamp } from "./types";
import { development, product } from "./channel";
export const settingsSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    adapter: z.string().max(200),
    receive: z.string().min(1).max(4096),
    paused: z.boolean(),
    text: z.boolean(),
    image: z.boolean(),
    files: z.boolean(),
    login: z.boolean(),
    updates: z.boolean(),
    smallBytes: z
      .number()
      .int()
      .min(1024)
      .max(128 * 1024 ** 2),
    historyLimit: z.number().int().min(1).max(50).default(10),
    smallCount: z.number().int().min(1).max(500),
  })
  .strict();
export function defaults(downloads: string): Settings {
  return {
    name: os.hostname().slice(0, 60) || "내 컴퓨터",
    adapter: "",
    receive: path.join(downloads, product),
    paused: true,
    text: true,
    image: true,
    files: true,
    login: false,
    updates: !development,
    smallBytes: 32 * 1024 ** 2,
    smallCount: 100,
    historyLimit: 10,
  };
}
export interface State {
  version: 1;
  observed?: number;
  settings: Settings;
  receiveVolume?: string;
  sealed: string;
  peers: Peer[];
  stamp: Stamp;
  outgoing: Outgoing[];
  incoming: Incoming[];
  pulls: Pull[];
  vaultVersion?: number;
  historyKey?: string;
  updateCheck: number;
}
export class Store {
  state: State;
  file: string;
  constructor(
    public home: string,
    public downloads: string,
  ) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    this.file = path.join(home, "state.json");
    this.state = {
      version: 1,
      settings: defaults(downloads),
      sealed: "",
      peers: [],
      stamp: { clock: 0, origin: "" },
      outgoing: [],
      incoming: [],
      pulls: [],
      vaultVersion: 1,
      updateCheck: 0,
    };
    if (fs.existsSync(this.file)) {
      const load = (file: string) => {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data.version !== 1) throw Error("읽을 수 없는 데이터 버전입니다.");
        // Older profiles may still name a LAN distribution folder.
        if (data.settings) delete data.settings.releaseFolder;
        data.settings = settingsSchema.parse(data.settings);
        data.pulls ??= [];
        if (!data.vaultVersion) {
          data.settings.paused = true;
          for (const j of [...data.outgoing, ...data.incoming])
            if (!["완료", "취소"].includes(j.state)) j.state = "취소";
          data.vaultVersion = 1;
        }
        return data;
      };
      try {
        this.state = load(this.file);
      } catch (e) {
        if (!fs.existsSync(this.file + ".bak") || /데이터 버전/.test(String(e)))
          throw e;
        this.state = load(this.file + ".bak");
        fs.copyFileSync(this.file, this.file + ".broken-" + Date.now());
        fs.copyFileSync(this.file + ".bak", this.file);
      }
    }
  }
  save() {
    const tmp = this.file + "." + randomUUID();
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, this.file + ".bak.tmp");
      fs.renameSync(this.file + ".bak.tmp", this.file + ".bak");
    }
    fs.renameSync(tmp, this.file);
  }
}
export function volumeRoot(folder: string) {
  let current = fs.realpathSync(folder);
  const dev = fs.statSync(current).dev;
  for (
    let parent = path.dirname(current);
    parent !== current;
    parent = path.dirname(current)
  ) {
    if (fs.statSync(parent).dev !== dev) break;
    current = parent;
  }
  return current;
}
export function writable(folder: string, create = true) {
  if (!path.isAbsolute(folder)) throw Error("절대 경로를 선택하세요.");
  if (create) fs.mkdirSync(folder, { mode: 0o700, recursive: true });
  if (
    fs.lstatSync(folder).isSymbolicLink() ||
    !fs.statSync(folder).isDirectory()
  )
    throw Error("일반 폴더를 선택하세요.");
  const real = fs.realpathSync(folder),
    probe = path.join(real, ".sync-vault-" + randomUUID());
  fs.closeSync(fs.openSync(probe, "wx", 0o600));
  fs.unlinkSync(probe);
  return real;
}

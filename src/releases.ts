import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { verifyManifest } from "./update";
export const releaseChunk = 512 * 1024;
const requestSchema = z
  .object({
    name: z.string().regex(/^SyncVault-[0-9.]+-(win32-x64|darwin-arm64)\.zip$/),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export class ReleaseFolder {
  constructor(
    private folder: () => string,
    private key: string,
  ) {}
  private async metadata() {
    const folder = this.folder();
    if (!folder || !this.key) throw Error("이 기기는 배포처가 아닙니다.");
    const root = await fs.realpath(folder);
    const read = async (name: string, max: number) => {
      const file = path.join(root, name);
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size > max)
        throw Error("배포 목록 크기가 다릅니다.");
      return fs.readFile(file);
    };
    const [manifest, sig] = await Promise.all([
      read("update.json", 65536),
      read("update.sig", 64),
    ]);
    return {
      root,
      manifest,
      sig,
      value: verifyManifest(manifest, sig, this.key),
    };
  }
  async index() {
    const m = await this.metadata();
    return {
      manifest: m.manifest.toString("base64"),
      sig: m.sig.toString("base64"),
    };
  }
  async part(raw: unknown) {
    const { name, offset } = requestSchema.parse(raw),
      m = await this.metadata();
    const asset = Object.values(m.value.platforms).find((a) => a.name === name);
    if (!asset || offset >= asset.size) throw Error("등록되지 않은 업데이트");
    const file = path.join(m.root, name);
    if ((await fs.realpath(file)) !== file)
      throw Error("배포 경로가 바뀌었습니다.");
    const h = await fs.open(file, "r");
    try {
      const st = await h.stat();
      if (!st.isFile() || st.size !== asset.size)
        throw Error("배포 파일이 변경되었습니다.");
      const data = Buffer.allocUnsafe(
        Math.min(releaseChunk, asset.size - offset),
      );
      const { bytesRead } = await h.read(data, 0, data.length, offset);
      if (bytesRead !== data.length) throw Error("패키지 읽기 실패");
      return { data: data.toString("base64") };
    } finally {
      await h.close();
    }
  }
}
export type PrivateReleases = {
  indexes: () => Promise<{ peer: string; manifest: Buffer; sig: Buffer }[]>;
  part: (
    peer: string,
    name: string,
    offset: number,
    signal: AbortSignal,
  ) => Promise<Buffer>;
};

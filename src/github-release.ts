import { z } from "zod";

export const releasesPage = "https://github.com/poyal/sync-vault/releases";
const latest = "https://api.github.com/repos/poyal/sync-vault/releases/latest";
const releaseSchema = z.object({
  tag_name: z.string().regex(/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    state: z.string(),
    browser_download_url: z.string(),
  })).max(100),
});

async function bytes(body: ReadableStream<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of body) {
    size += part.length;
    if (size > limit) throw Error("GitHub 릴리즈 파일 크기가 한도를 초과했습니다.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export async function latestRelease(signal: AbortSignal) {
  const res = await fetch(latest, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
    signal,
  });
  if (res.status === 404) throw Error("공개된 GitHub 정식 릴리즈를 찾을 수 없습니다.");
  if (!res.ok || !res.body) throw Error("GitHub 릴리즈 조회 실패 · HTTP " + res.status);
  const raw = JSON.parse((await bytes(res.body, 1024 * 1024)).toString("utf8"));
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) throw Error("GitHub 정식 릴리즈 형식이 올바르지 않습니다.");
  const { tag_name, assets } = parsed.data;
  return {
    version: tag_name.replace(/^v/, ""),
    asset(name: string, size?: number) {
      const url = releasesPage + "/download/" + tag_name + "/" + name;
      const found = assets.find(a =>
        a.name === name && a.state === "uploaded" &&
        a.size > 0 && a.browser_download_url === url
      );
      if (!found || (size !== undefined && found.size !== size))
        throw Error("GitHub 릴리즈 파일을 확인하세요 · " + name);
      return url;
    },
  };
}

export async function assetStream(url: string, signal: AbortSignal) {
  // Only the release URL constructed above may initiate a download.
  let next = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(next, { redirect: "manual", signal });
    if (res.ok && res.body) return res.body;
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(res.status) || !location)
      throw Error("GitHub 파일 다운로드 실패 · HTTP " + res.status);
    next = new URL(location, next);
    const allowed = next.origin === "https://release-assets.githubusercontent.com" ||
      next.origin === "https://objects.githubusercontent.com";
    if (next.username || next.password || !allowed)
      throw Error("허용되지 않은 GitHub 다운로드 주소입니다.");
  }
  throw Error("GitHub 파일 다운로드 경로가 너무 깁니다.");
}

export async function assetBytes(url: string, limit: number, signal: AbortSignal) {
  return bytes(await assetStream(url, signal), limit);
}

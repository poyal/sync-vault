import { build, Platform, Arch } from "electron-builder";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const mac = process.platform === "darwin",
  platform = mac ? Platform.MAC : Platform.WINDOWS;
const arch = mac ? Arch.arm64 : Arch.x64;
const project = JSON.parse(await fs.readFile("package.json", "utf8"));
const dev = process.argv.includes("--dev");
const baseVersion = dev ? project.syncVaultDevVersion : project.version;
const candidateIndex = process.argv.indexOf("--qa-candidate");
const candidate = candidateIndex !== -1;
const version = candidate ? process.argv[candidateIndex + 1] : baseVersion;
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  throw Error("검증 후보 버전 x.y.z가 필요합니다.");
const previous = process.argv.includes("--qa-previous");
const target = mac ? "mac-arm64" : "win-x64";
const devDir = path.join("artifacts", "dev", randomUUID(), target);
const qa = previous
  ? {
      extraMetadata: { version: "0.0.9" },
      directories: { output: "artifacts/previous" },
    }
  : candidate
    ? {
        extraMetadata: { version },
        directories: {
          output: path.join("artifacts", "update-candidates", randomUUID()),
        },
      }
    : {};
const files = await build({
  targets: platform.createTarget(
    previous
      ? ["dir"]
      : candidate
        ? ["zip"]
        : dev
          ? [mac ? "dmg" : "nsis"]
          : [mac ? "dmg" : "nsis", "zip"],
    arch,
  ),
  publish: "never",
  config: {
    electronDist: path.resolve("node_modules/electron/dist"),
    icon: "out/icon.png",
    ...qa,
    ...(dev && {
      appId: "io.syncvault.desktop.dev",
      productName: "Sync Vault Dev",
      extraMetadata: { name: "sync-vault-dev", version: version + "-dev" },
      directories: { output: devDir },
      extraResources: [{ from: "artifacts/dev-native", to: "native" }],
      files: [
        "package.json",
        "!dist/**",
        { from: "artifacts/dev-runtime", to: "dist" },
      ],
      artifactName: "SyncVault-Dev-" + version + "-" + target + ".${ext}",
    }),
    ...(mac && {
      mac: {
        ...(process.env.CSC_NAME && { identity: process.env.CSC_NAME }),
        ...(dev && {
          extendInfo: { NSBonjourServices: ["_sync-vault-dev._tcp"] },
        }),
      },
    }),
  },
});
if (dev) {
  const installer = files.find((f) => f.endsWith(mac ? ".dmg" : ".exe"));
  if (!installer) throw Error("개발 설치 파일이 없습니다.");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(installer)) hash.update(bytes);
  const commit =
    process.env.SYNC_VAULT_SOURCE_COMMIT ||
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const source = createHash("sha256");
  for (const file of [
    "package.json",
    "package-lock.json",
    "release-key.pub",
    "scripts/build.mjs",
    "scripts/package.mjs",
    ...(
      await Promise.all(
        ["src", "ui", "native"].map(async (dir) =>
          (await fs.readdir(dir)).sort().map((f) => dir + "/" + f),
        ),
      )
    ).flat(),
  ]) {
    source
      .update(file + "\0")
      .update((await fs.readFile(file, "utf8")).replaceAll("\r\n", "\n"))
      .update("\0");
  }
  const manifest = {
    version,
    commit,
    sourceSha256: source.digest("hex"),
    target,
    file: path.basename(installer),
    bytes: (await fs.stat(installer)).size,
    sha256: hash.digest("hex"),
  };
  await fs.writeFile(
    path.join(devDir, "installer.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(devDir, manifest);
}
for (const name of files.filter((f) => f.endsWith(".zip"))) {
  const target = path.join(
    path.dirname(name),
    "SyncVault-" +
      version +
      "-" +
      (mac ? "darwin-arm64" : "win32-x64") +
      ".zip",
  );
  if (target !== name) await fs.rename(name, target);
}

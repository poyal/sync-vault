import { build, Platform, Arch } from "electron-builder";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const mac = process.platform === "darwin",
  platform = mac ? Platform.MAC : Platform.WINDOWS;
const arch = mac ? Arch.arm64 : Arch.x64;
const version = JSON.parse(await fs.readFile("package.json", "utf8")).version;
const previous = process.argv.includes("--qa-previous");
const dev = process.argv.includes("--dev");
const target = mac ? "mac-arm64" : "win-x64";
const devDir = path.join("artifacts", "dev", randomUUID(), target);
const qa = previous
  ? {
      extraMetadata: { version: "0.0.9" },
      directories: { output: "artifacts/previous" },
    }
  : {};
const files = await build({
  targets: platform.createTarget(
    previous ? ["dir"] : dev ? [mac ? "dmg" : "nsis"] : [mac ? "dmg" : "nsis", "zip"],
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
      files: ["package.json", "!dist/**", { from: "artifacts/dev-runtime", to: "dist" }],
      artifactName: "SyncVault-Dev-" + version + "-" + target + ".${ext}",
      mac: { extendInfo: { NSBonjourServices: ["_sync-vault-dev._tcp"] } },
    }),
  },
});
if (dev) {
  const installer = files.find(f => f.endsWith(mac ? ".dmg" : ".exe"));
  if (!installer) throw Error("개발 설치 파일이 없습니다.");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(installer)) hash.update(bytes);
  const commit = process.env.SYNC_VAULT_SOURCE_COMMIT ||
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = { version, commit, target, file: path.basename(installer),
    bytes: (await fs.stat(installer)).size, sha256: hash.digest("hex") };
  await fs.writeFile(path.join(devDir, "installer.json"), JSON.stringify(manifest, null, 2) + "\n");
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

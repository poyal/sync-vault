import { build, Platform, Arch } from "electron-builder";
import path from "node:path";
import fs from "node:fs/promises";
const mac = process.platform === "darwin",
  platform = mac ? Platform.MAC : Platform.WINDOWS;
const arch = mac ? Arch.arm64 : Arch.x64;
const version = JSON.parse(await fs.readFile("package.json", "utf8")).version;
const previous = process.argv.includes("--qa-previous");
const qa = previous
  ? {
      extraMetadata: { version: "0.0.9" },
      directories: { output: "artifacts/previous" },
    }
  : {};
const files = await build({
  targets: platform.createTarget(
    previous ? ["dir"] : [mac ? "dmg" : "nsis", "zip"],
    arch,
  ),
  publish: "never",
  config: {
    electronDist: path.resolve("node_modules/electron/dist"),
    icon: "out/icon.png",
    ...qa,
  },
});
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

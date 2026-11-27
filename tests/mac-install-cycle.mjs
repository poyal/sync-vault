import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { base, launch, cleanup } from "./desktop-peers.mjs";
if (process.platform !== "darwin" || !process.argv[2])
  throw Error("mac-install-cycle.mjs <DMG>");
const mount = path.join(base, "image"),
  apps = path.join(base, "Applications"),
  installed = path.join(apps, "Sync Vault.app");
const exe = path.join(installed, "Contents/MacOS/Sync Vault");
await fs.mkdir(mount);
await fs.mkdir(apps);
let mounted = false;
try {
  execFileSync(
    "hdiutil",
    [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      path.resolve(process.argv[2]),
    ],
    { stdio: "pipe" },
  );
  mounted = true;
  const copy = () =>
    execFileSync("ditto", [path.join(mount, "Sync Vault.app"), installed]);
  copy();
  execFileSync("codesign", ["--verify", "--deep", "--strict", installed]);
  const one = await launch("Install-cycle", exe);
  const destination = path.join(base, "downloads");
  await one.call("settings", { receive: destination, smallCount: 37 });
  const identity = (await one.state()).local.id;
  await one.app.close();
  await fs.rm(installed, { recursive: true });
  assert.equal(
    await fs.stat(exe).then(
      () => true,
      () => false,
    ),
    false,
  );
  copy();
  const two = await launch("Install-cycle", exe),
    state = await two.state();
  assert.equal(state.version, "0.1.1");
  assert.equal(state.local.id, identity);
  assert.equal(state.settings.receive, await fs.realpath(destination));
  assert.equal(state.settings.smallCount, 37);
  await two.app.close();
  console.log(
    "PASS macOS DMG copy, launch, app removal, reinstall, retained device identity and settings",
  );
} finally {
  if (mounted) execFileSync("hdiutil", ["detach", mount], { stdio: "pipe" });
  await cleanup();
}

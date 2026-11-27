import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { launch, cleanup } from "./desktop-peers.mjs";
const run = promisify(execFile);
assert.ok(process.env.SYNC_VAULT_QA_EXE, "set the installed Dev executable");
try {
  const d = await launch("QA-native-tray");
  assert.equal((await d.state()).product, "Sync Vault Dev");
  const pid = await d.app.evaluate(() => process.pid);
  const visible = () => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  const menu = label => process.platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", "tests/native-tray.ps1", label], { windowsHide: true, timeout: 16000 })
    : run("/usr/bin/osascript", ["tests/native-tray.applescript", String(pid), label], { timeout: 16000 });
  await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await menu("클립보드 공유 재개");
  await expect.poll(async () => (await d.state()).settings.paused).toBe(false);
  assert.equal(await visible(), false);
  await menu("클립보드 공유 일시 중지");
  await expect.poll(async () => (await d.state()).settings.paused).toBe(true);
  await menu("Sync Vault Dev 열기");
  await expect.poll(visible).toBe(true);
  await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const closed = d.app.waitForEvent("close", { timeout: 20000 });
  await Promise.all([closed, menu("종료")]);
  console.log("PASS", process.platform, "system tray menu resume, pause, open, quit");
} finally { await cleanup(); }

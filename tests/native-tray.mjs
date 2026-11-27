import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { launch, cleanup } from "./desktop-peers.mjs";
const run = promisify(execFile);
const callbacks = process.argv.includes("--menu-callbacks");
assert.ok(process.env.SYNC_VAULT_QA_EXE, "set the installed Dev executable");
try {
  const d = await launch("QA-native-tray");
  assert.equal((await d.state()).product, "Sync Vault Dev");
  const pid = await d.app.evaluate(() => process.pid);
  const visible = () => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  if (callbacks) {
    await d.app.evaluate(({ Tray }) => {
      const setMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        globalThis.qaTrayMenu = menu;
        return setMenu.call(this, menu);
      };
    });
    await d.call("settings", { paused: true });
  }
  const menu = async label => {
    if (callbacks) return d.app.evaluate((_electron, name) => {
      const entry = globalThis.qaTrayMenu.items.find(item => item.label === name);
      if (!entry || !entry.enabled) throw Error("메뉴 항목을 사용할 수 없습니다.");
      setImmediate(() => entry.click());
    }, label);
    return process.platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", "tests/native-tray.ps1",
      label, String(pid), "숨겨진 아이콘 표시"], { windowsHide: true, timeout: 16000 })
    : run("/usr/bin/osascript", ["tests/native-tray.applescript", String(pid), label], { timeout: 16000 })
      .catch(async error => {
        const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e",
          "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"], { timeout: 3000 });
        if (stdout.trim() === "false")
          throw Error("BLOCKED: macOS 손쉬운 사용 권한이 없는 세션입니다.", { cause: error });
        throw error;
      });
  };
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
  console.log("PASS", process.platform, callbacks ? "installed menu callbacks" : "system tray icon and menu", "resume, pause, open, quit");
} finally { await cleanup(); }

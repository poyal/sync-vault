import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { launch, cleanup } from "./desktop-peers.mjs";
const run = promisify(execFile);
const callbacks = process.argv.includes("--menu-callbacks");
const boundsOnly = process.argv.includes("--bounds-only");
assert.ok(process.env.SYNC_VAULT_QA_EXE, "set the installed Dev executable");
async function checkTray() {
  const d = await launch("QA-native-tray", process.env.SYNC_VAULT_QA_EXE, { loginStart: boundsOnly });
  assert.equal((await d.state()).product, "Sync Vault Dev");
  const pid = await d.app.evaluate(() => process.pid);
  const visible = () => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  if (callbacks || boundsOnly) {
    await d.app.evaluate(({ Tray }) => {
      const setMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        globalThis.qaTrayMenu = menu;
        globalThis.qaTrayItem = this;
        return setMenu.call(this, menu);
      };
    });
    await d.call("settings", { paused: true });
  }
  if (boundsOnly) {
    assert.equal(await visible(), false);
    const bounds = await d.app.evaluate(({ app, screen }) => {
      const rect = globalThis.qaTrayItem.getBounds();
      return { ...rect, onDisplay: screen.getAllDisplays().some(({ bounds: b }) =>
        rect.width > 0 && rect.height > 0 && rect.x < b.x + b.width && rect.y < b.y + b.height &&
        rect.x + rect.width > b.x && rect.y + rect.height > b.y),
        dockVisible: process.platform === "darwin" && app.dock.isVisible() };
    });
    assert.ok(bounds.onDisplay, "OS 트레이 아이콘이 디스플레이 좌표에 없습니다. " + JSON.stringify(bounds));
    assert.equal(bounds.dockVisible, false);
    console.log("PASS", process.platform, "hidden app, OS tray bounds", bounds.width, bounds.height);
    return;
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
  if (!callbacks && process.platform === "win32") {
    await menu("__OPEN_WINDOW__");
    await expect.poll(visible).toBe(true);
    console.log("PASS win32 Explorer tray icon activation opens the installed app");
    await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  }
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
}
try { await checkTray(); } finally { await cleanup(); }

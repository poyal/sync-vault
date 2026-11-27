import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "sync-vault-tray-"));
const executable = process.env.SYNC_VAULT_QA_EXE || createRequire(import.meta.url)("electron");
const args = [...(process.env.SYNC_VAULT_QA_EXE ? [] : ["."]), "--user-data-dir=" + home];
if (process.platform === "darwin") args.push("--use-mock-keychain");
const env = { ...process.env, SYNC_VAULT_TEST_HOME: home, SYNC_VAULT_TEST_LOOPBACK: "1",
  SYNC_VAULT_QA_STATION: "SyncVaultQA-" + randomUUID() };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const again = () => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { env, stdio: "ignore", windowsHide: true });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(Error("second launch " + code)));
});
try {
  app = await electron.launch({ executablePath: executable, args: [...args, "--sync-vault-login"], env });
  const page = await app.firstWindow();
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length);
  const state = await page.evaluate(() => window.vault.call("state"));
  await expect.poll(() => page.evaluate(async () => (await window.vault.call("state")).local.port)).toBeGreaterThan(0);
  assert.equal(await visible(), 0);
  const port = (await page.evaluate(() => window.vault.call("state"))).local.port;
  for (let i = 0; i < 30; i++) {
    await again();
    await expect.poll(visible).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await visible(), 0);
  }
  // Kill only the renderer belonging to this disposable test instance.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await again();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.length === 1 && windows[0].isVisible() && !windows[0].webContents.isCrashed();
  })).toBe(true);
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    if (wc.isLoading() || wc.isCrashed()) return "";
    return wc.executeJavaScript("window.vault.call('state').then(s => s.local.id)").catch(() => "");
  })).toBe(state.local.id);
  const start = performance.now();
  await app.close();
  app = undefined;
  assert.ok(performance.now() - start <= 10000, "quit exceeded 10 s");
  const listening = await new Promise(resolve => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  assert.equal(listening, false);
  console.log("PASS", process.platform, state.product, "login argument, 30 close/reopen cycles, renderer recovery, quit and port release");
} finally {
  await app?.close().catch(() => {});
  await fs.rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}

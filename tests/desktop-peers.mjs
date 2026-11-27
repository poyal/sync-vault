import { _electron as electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { closeApp } from "./quit.mjs";
const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "sync-vault-journey-"));
const apps = new Set();
const wait = async (f) =>
  expect.poll(f, { timeout: 16000, intervals: [100, 300] }).toBe(true);
async function launch(label, exe = process.env.SYNC_VAULT_QA_EXE, { desktopClipboard = false, configure = true, loginStart = false } = {}) {
  const profile = path.join(base, label),
    env = {
      ...process.env,
      SYNC_VAULT_TEST_HOME: profile,
      SYNC_VAULT_TEST_LOOPBACK:
        process.env.SYNC_VAULT_QA_PHYSICAL === "1" ? "0" : "1",
      SYNC_VAULT_QA_STATION: "SyncVaultQA-" + randomUUID(),
    };
  delete env.ELECTRON_RUN_AS_NODE;
  if (desktopClipboard) delete env.SYNC_VAULT_QA_STATION;
  const app = await electron.launch({
    executablePath: exe || createRequire(import.meta.url)("electron"),
    args: [
      ...(exe ? [] : ["."]),
      ...(loginStart ? ["--sync-vault-login"] : []),
      "--user-data-dir=" + profile,
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ],
    env,
  });
  apps.add(app);
  app.once("close", () => apps.delete(app));
  const page = await app.firstWindow();
  const endpoint = process.env.SYNC_VAULT_QA_PHYSICAL === "1" ? /\d+\.\d+\.\d+\.\d+:\d+/ : /127\.0\.0\.1:\d+/;
  if (loginStart) {
    await expect.poll(() => page.evaluate(async () => {
      const { local } = await window.vault.call("state");
      return local.port > 0 ? local.address + ":" + local.port : "";
    })).toMatch(endpoint);
  } else {
    await expect(page.locator("#myip")).toHaveText(endpoint);
  }
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  const call = (action, v) =>
    page.evaluate(([a, b]) => window.vault.call(a, b), [action, v]);
  const state = () => call("state");
  if (configure) await call("settings", { name: label, paused: true, updates: false });
  return {
    app,
    page,
    call,
    state,
    label,
    profile,
    station: env.SYNC_VAULT_QA_STATION,
  };
}
const nav = (d, tab) =>
  d.page.getByRole("button", { name: tab, exact: true }).click();
async function request(a, b) {
  await a.page.locator('aside [data-page="devices"]').click();
  await b.page.locator('aside [data-page="devices"]').click();
  await a.page
    .locator("#connect")
    .evaluate((el) => (el.parentElement.open = true));
  await a.page
    .locator("#endpoint")
    .fill("127.0.0.1:" + (await b.state()).local.port);
  await a.page.locator("#connect button").click();
  await expect(b.page.locator("#pending")).toContainText(a.label);
}
async function approve(a, b) {
  await request(a, b);
  if ((await a.state()).shelf)
    await a.page.locator('[data-action="pair-confirm"]').click();
  await b.page.locator('[data-action="approve"]').click();
  await wait(async () =>
    (await a.state()).peers.some((p) => p.name === b.label && p.online),
  );
}
async function send(a, b, paths) {
  await nav(a, "전송");
  await a.app.evaluate(({ dialog }, list) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list });
  }, paths);
  await a.page.getByRole("button", { name: "파일 추가", exact: true }).click();
  await a.page
    .getByRole("button", { name: b.label + "에 보내기", exact: true })
    .click();
}
const job = (d, name, state) =>
  wait(async () =>
    (await d.state()).jobs.some((j) => j.name === name && j.state === state),
  );
async function action(d, name, op) {
  await nav(d, "전송");
  await d.page
    .locator("#jobs article")
    .filter({ has: d.page.locator("strong", { hasText: name }) })
    .locator('[data-action="' + op + '"]')
    .click();
}
async function fixture(name, txt) {
  const f = path.join(base, name);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, txt);
  return f;
}
function copyPrivateFiles(station, files) {
  assert.match(station, /^SyncVaultQA-[a-f0-9-]+$/);
  assert.ok(files.length > 0 && files.every(f => path.isAbsolute(f)));
  if (process.platform === "win32") {
    execFileSync(path.resolve("artifacts/os-clipboard/station.exe"), [station, "--local-files", ...files], { windowsHide: true });
  } else {
    const copy = `function run(args) {
      ObjC.import('AppKit');
      const board = $.NSPasteboard.pasteboardWithName(args[0]);
      const urls = $.NSMutableArray.array;
      for (const file of args.slice(1)) urls.addObject($.NSURL.fileURLWithPath(file));
      board.clearContents;
      if (!board.writeObjects(urls)) throw Error('pasteboard');
    }`;
    execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", copy, station, ...files]);
  }
}
async function stopApps() {
  const results = await Promise.allSettled([...apps].map(closeApp));
  const failed = results.find(r => r.status === "rejected");
  if (failed) throw failed.reason;
}
async function cleanup() {
  try { await stopApps(); } finally { await fs.rm(base, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200,
  }); }
}
export {
  base,
  wait,
  launch,
  nav,
  request,
  approve,
  send,
  job,
  action,
  fixture,
  copyPrivateFiles,
  stopApps,
  cleanup,
};

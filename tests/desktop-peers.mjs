import { _electron as electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { closeApp } from "./quit.mjs";
const base = await fs.mkdtemp(path.join(os.tmpdir(), "sync-vault-journey-"));
const apps = new Set();
const wait = async (f) =>
  expect.poll(f, { timeout: 16000, intervals: [100, 300] }).toBe(true);
async function launch(label, exe = process.env.SYNC_VAULT_QA_EXE, { desktopClipboard = false, configure = true } = {}) {
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
      "--user-data-dir=" + profile,
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ],
    env,
  });
  apps.add(app);
  app.once("close", () => apps.delete(app));
  const page = await app.firstWindow();
  await expect(page.locator("#myip")).toHaveText(
    process.env.SYNC_VAULT_QA_PHYSICAL === "1"
      ? /\d+\.\d+\.\d+\.\d+:\d+/
      : /127\.0\.0\.1:\d+/,
  );
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
  await nav(a, "기기");
  await nav(b, "기기");
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
  stopApps,
  cleanup,
};

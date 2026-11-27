// A local stdin/stdout worker. The controller starts its Mac counterpart over SSH.
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { base, cleanup, launch } from "./desktop-peers.mjs";

const [exe, label, mode] = process.argv.slice(2);
const desktop = mode === "desktop";
process.env.SYNC_VAULT_QA_PHYSICAL = "1";
const output = path.join(base, "received");
const app = await launch(label, exe, { desktopClipboard: desktop });
await app.call("settings", { receive: output, paused: true });
let peer, editor, page;
const until = async (predicate, ms) => {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(35);
  }
  throw Error("시간 초과");
};
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}
const commands = {
  async info() { return (await app.state()).local; },
  async discover(name) {
    await app.call("settings", { adapter: "SyncVaultQA-offline" });
    await until(async () => !(await app.state()).local.address, 5000);
    const begin = performance.now();
    await app.call("settings", { adapter: "" });
    await until(async () => (await app.state()).nearby.some(p => p.name === name), 20000);
    return performance.now() - begin;
  },
  async pair(other) { await app.call("pair", { address: other.address, port: other.port }); },
  async approve(id) {
    await until(async () => (await app.state()).pending.some(p => p.id === id), 16000);
    await app.call("approve", id);
  },
  async ready(id) {
    peer = id;
    await until(async () => (await app.state()).peers.some(p => p.id === peer && p.online), 20000);
    await app.call("autoaccept", { id, value: true });
    await app.call("settings", { paused: !desktop, files: false, text: desktop, image: desktop });
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    if (desktop) {
      editor = await electron.launch({ executablePath: createRequire(import.meta.url)("electron"),
        args: [path.resolve("tests/benchmark-editor.cjs"), "--user-data-dir=" + path.join(base, "editor")] });
      page = await editor.firstWindow();
      await page.locator("#edit").focus();
      await page.evaluate(() => document.addEventListener("paste", e => {
        e.preventDefault();
        window.lastPaste = { text: e.clipboardData.getData("text/plain"), html: e.clipboardData.getData("text/html") };
      }));
    }
  },
  async copy(value) {
    await page.locator("#edit").evaluate((el, value) => {
      const bold = document.createElement("b");
      bold.textContent = value;
      el.replaceChildren(bold);
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, value);
    await editor.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy());
  },
  async paste(value) {
    await until(async () => {
      await editor.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
      return page.evaluate(v => window.lastPaste?.text === v && window.lastPaste?.html.includes(v), value);
    }, 5000);
  },
  async prepareFile(name) {
    assert.match(name, /^[a-z0-9-]+\.bin$/);
    const file = path.join(base, name);
    const block = randomBytes(1024 * 1024);
    const handle = await fs.open(file, "wx");
    try {
      for (let i = 0; i < 256; i++) await handle.writeFile(block);
    } finally { await handle.close(); }
    return hashFile(file);
  },
  async sendFile(name) {
    assert.match(name, /^[a-z0-9-]+\.bin$/);
    await app.call("drop", [path.join(base, name)]);
    await app.call("send", peer);
  },
  async received(name) {
    assert.match(name, /^[a-z0-9-]+\.bin$/);
    const f = path.join(output, name);
    await until(() => fs.stat(f).then(s => s.size === 256 * 1024 ** 2, () => false), 180000);
  },
  async sending(name) {
    return (await app.state()).jobs.some(j => j.name === name && j.direction === "보냄" &&
      j.state === "보내는 중" && j.done > 0 && j.done < j.total);
  },
  async verifyFile({ name, hash }) {
    assert.match(name, /^[a-z0-9-]+\.bin$/);
    const f = path.join(output, name);
    assert.equal(await hashFile(f), hash);
    await fs.unlink(f);
  },
  async clearSource(name) {
    assert.match(name, /^[a-z0-9-]+\.bin$/);
    await fs.unlink(path.join(base, name));
  },
};
const reply = value => console.log("SVQA " + JSON.stringify(value));
const pending = new Set();
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, op, value } = JSON.parse(line);
    if (op === "exit") break;
    const task = Promise.resolve().then(() => {
      if (!Object.hasOwn(commands, op)) throw Error("unknown QA operation");
      return commands[op](value);
    }).then(result => reply({ id, result }), error => reply({ id, error: String(error) }));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
} finally {
  await Promise.allSettled(pending);
  await editor?.close();
  await cleanup();
}

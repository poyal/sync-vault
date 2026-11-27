// A local stdin/stdout worker. The controller starts its Mac counterpart over SSH.
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { base, cleanup, copyPrivateFiles, launch } from "./desktop-peers.mjs";

const [exe, label, mode] = process.argv.slice(2);
const desktop = mode === "desktop";
const privateFiles = mode === "private-files";
assert.ok(desktop || privateFiles || mode === "files-only");
process.env.SYNC_VAULT_QA_PHYSICAL = "1";
const output = path.join(base, "received");
const app = await launch(label, exe, { desktopClipboard: desktop, loginStart: privateFiles }).catch(async error => {
  await cleanup();
  throw error;
});
if (privateFiles) {
  assert.match(app.station, /^SyncVaultQA-[a-f0-9-]+$/);
  await app.app.evaluate(({ Notification }) => { Notification.isSupported = () => false; });
}
await app.call("settings", { receive: output, paused: true });
let peer, editor, page, resumeApp;
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
  async info() {
    const state = await app.state();
    return { ...state.local, version: state.version, platform: process.platform,
      arch: process.arch, osRelease: os.release(), product: await app.app.evaluate(({ app }) => app.getName()) };
  },
  async discover(name) {
    await app.call("settings", { adapter: "SyncVaultQA-offline" });
    await until(async () => {
      const state = await app.state();
      return !state.local.address && !state.nearby.some(p => p.name === name);
    }, 5000);
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
    await app.call("settings", { paused: !(desktop || privateFiles), files: privateFiles, text: desktop, image: desktop });
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.app.evaluate(() => {
      globalThis.qaRoutes = { chunks: 0, replies: 0 };
      process.getBuiltinModule("node:diagnostics_channel").channel("http.client.request.start")
        .subscribe(({ request }) => {
          if (/^\/part\/[^/]+\/\d+\/\d+$/.test(request.path)) globalThis.qaRoutes.chunks++;
          if (request.path === "/return/reply") globalThis.qaRoutes.replies++;
        });
    });
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
  async routes() { return app.app.evaluate(() => globalThis.qaRoutes); },
  async copyFile(tag) {
    assert.ok(privateFiles);
    assert.match(tag, /^[a-z0-9-]{1,90}$/);
    const source = path.join(base, tag + ".txt");
    await fs.writeFile(source, tag + "\n한글 😀", { flag: "wx" });
    copyPrivateFiles(app.station, [source]);
  },
  async pastedFile(tag) {
    assert.ok(privateFiles);
    assert.match(tag, /^[a-z0-9-]{1,90}$/);
    const helper = path.join(path.dirname(exe), process.platform === "win32" ? "resources/native/clipboard.exe" : "../Resources/native/clipboard");
    const folder = path.join(app.profile, "clipboard-files");
    await until(async () => {
      const data = execFileSync(helper, ["inspect"], { env: { ...process.env, SYNC_VAULT_QA_STATION: app.station }, windowsHide: true });
      const files = data.subarray(5).toString().split("\0").filter(Boolean);
      if (data[4] !== 2 || files.length !== 1 || path.basename(files[0]) !== tag + ".txt") return false;
      assert.equal(path.dirname(await fs.realpath(files[0])), await fs.realpath(folder));
      assert.equal(await fs.readFile(files[0], "utf8"), tag + "\n한글 😀");
      return true;
    }, 10000);
  },
  async hidden() {
    return app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible()));
  },
  async pauseMacProcess() {
    assert.ok(privateFiles && process.platform === "darwin" && !resumeApp);
    const pid = app.app.process().pid;
    process.kill(pid, "SIGSTOP");
    const timer = setTimeout(() => resumeApp?.(), 2000);
    resumeApp = () => {
      clearTimeout(timer);
      resumeApp = undefined;
      process.kill(pid, "SIGCONT");
    };
    await until(() => execFileSync("/bin/ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" }).includes("T"), 1000);
  },
  async fileStatus(tag) {
    assert.ok(privateFiles);
    const { jobs, peers, notice } = await app.state();
    return { jobs: jobs.filter(j => j.name === tag + ".txt").map(({ state, direction, error }) => ({ state, direction, error })),
      peerOnline: peers.some(p => p.id === peer && p.online), notice };
  },
  async copyWhileLocked(tag) {
    assert.ok(privateFiles);
    const stampClock = async () => JSON.parse(await fs.readFile(path.join(app.profile, "state.json"), "utf8")).stamp.clock;
    await app.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("lock-screen");
      powerMonitor.emit("unlock-screen");
      powerMonitor.emit("lock-screen");
    });
    await delay(350);
    const before = await stampClock();
    try {
      await commands.copyFile(tag);
      await until(async () => (await stampClock()) > before, 5000);
    } finally {
      await app.app.evaluate(({ powerMonitor }) => { powerMonitor.emit("unlock-screen"); });
    }
    // Unlock asynchronously snapshots the OS board before accepting new copies.
    await delay(500);
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
    if (op === "exit") {
      if (value === false) process.exitCode = 1;
      break;
    }
    const task = Promise.resolve().then(() => {
      if (!Object.hasOwn(commands, op)) throw Error("unknown QA operation");
      return commands[op](value);
    }).then(result => reply({ id, result }), error => reply({ id, error: String(error) }));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
} finally {
  resumeApp?.();
  await Promise.allSettled(pending);
  await editor?.close();
  await cleanup();
}

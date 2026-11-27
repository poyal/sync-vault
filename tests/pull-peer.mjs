import { _electron as electron } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReadStream } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { sampleTree } from "./process-sample.mjs";
import { closeApp } from "./quit.mjs";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "sv-pull-")),
  station = "SyncVaultQA-" + randomUUID();
const mac = process.platform === "darwin",
  exe = process.env.SYNC_VAULT_QA_EXE;
let app,
  page,
  helper,
  volumeMounted = false;
const mount = path.join(home, "volume"),
  disk = path.join(home, "disk.dmg");
const call = (a, v) =>
  page.evaluate(([a, v]) => window.vault.call(a, v), [a, v]);
async function until(fn, limit = 20000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("QA 상태 대기 시간 초과");
}
async function launch() {
  const env = {
    ...process.env,
    SYNC_VAULT_TEST_HOME: home,
    SYNC_VAULT_TEST_LOOPBACK:
      process.env.SYNC_VAULT_QA_PHYSICAL === "1" ? "0" : "1",
    SYNC_VAULT_QA_STATION: station,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: exe || createRequire(import.meta.url)("electron"),
    args: [
      ...(exe ? [] : ["."]),
      "--user-data-dir=" + home,
      "--sync-vault-login",
      ...(mac ? ["--use-mock-keychain"] : []),
    ],
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await until(async () => {
    try {
      return (await call("state")).local.port > 0;
    } catch {
      return false;
    }
  });
  const resources = await app.evaluate(({ app }) =>
    app.isPackaged ? process.resourcesPath : null,
  );
  helper = path.join(
    resources || path.resolve("out"),
    "native",
    mac ? "clipboard" : "clipboard.exe",
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  );
  await app.evaluate(({ BrowserWindow, Notification }) => {
    Notification.isSupported = () => false;
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1000, 680);
    w.showInactive();
  });
}
const tools = {
  async init({ label }) {
    await launch();
    await call("settings", {
      name: label,
      receive: path.join(home, "받은 자료"),
      paused: false,
      updates: false,
    });
    const state = await call("state");
    return { ...state.local, version: state.version };
  },
  state: () => call("state"),
  ipc: ({ a, v }) => call(a, v),
  async nav({ p }) {
    await page.locator('aside [data-page="' + p + '"]').click();
  },
  async click({ selector }) {
    await page.locator(selector).first().click();
  },
  async room({ peer, tab }) {
    await tools.nav({ p: "home" });
    await page
      .locator('#home [data-action="enter"][data-value="' + peer + '"]')
      .click();
    if (tab === "folder")
      await page.locator('.switch [data-value="folder"]').click();
  },
  async row({ name, action }) {
    await page
      .locator("#room-items article")
      .filter({ has: page.locator("strong", { hasText: name }) })
      .first()
      .locator('[data-action="' + action + '"]')
      .click();
  },
  async shot({ selector }) {
    const masks = [
      "#myip",
      "#endpoint",
      "#nearby article small",
      "#registered article small",
      "#jobs small",
      "#prefs input[name=receive]",
    ].map((s) => page.locator(s));
    return (
      await (selector ? page.locator(selector) : page).screenshot({
        mask: masks,
        maskColor: "#d9e4dd",
        animations: "disabled",
      })
    ).toString("base64");
  },
  async visible() {
    return app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    );
  },
  async hide() {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
  },
  async show() {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].showInactive(),
    );
  },
  async lock({ on }) {
    await app.evaluate(
      ({ powerMonitor }, on) =>
        powerMonitor.emit(on ? "lock-screen" : "unlock-screen"),
      on,
    );
    await until(async () => (await call("state")).locked === on);
  },
  async fixture({ name, text, dir, count }) {
    const root = (await call("state")).shelf,
      target = path.resolve(root, name);
    assert.ok(target.startsWith(root + path.sep));
    if (dir) {
      await fs.mkdir(target, { recursive: true });
      await fs.mkdir(path.join(target, "빈 폴더"), { recursive: true });
      await fs.writeFile(path.join(target, "요약.txt"), text || "");
    } else await fs.writeFile(target, text || "");
    if (count)
      for (let i = 0; i < count; i += 50)
        await Promise.all(
          Array.from({ length: Math.min(50, count - i) }, (_, j) =>
            fs.writeFile(path.join(target, "표본-" + (i + j) + ".txt"), ""),
          ),
        );
  },
  async large({ name, size }) {
    const file = path.join((await call("state")).shelf, path.basename(name)),
      h = await fs.open(file, "wx");
    try {
      await h.truncate(size);
      await h.write(Buffer.from("SV pull"), 0, 7, size - 7);
    } finally {
      await h.close();
    }
  },
  async hash({ name, source = false }) {
    const file = path.join(
      source ? (await call("state")).shelf : path.join(home, "받은 자료"),
      path.basename(name),
    );
    const hash = createHash("sha256");
    for await (const b of createReadStream(file)) hash.update(b);
    return hash.digest("hex");
  },
  async waitText({ selector, text }) {
    await page.locator(selector).filter({ hasText: text }).first().waitFor();
  },
  async received({ name, text }) {
    const f = path.join(home, "받은 자료", name);
    assert.equal(await fs.readFile(f, "utf8"), text);
    return createHash("sha256")
      .update(await fs.readFile(f))
      .digest("hex");
  },
  async disk({ op }) {
    assert.ok(mac);
    if (op === "mount") {
      await fs.mkdir(mount);
      execFileSync("hdiutil", [
        "create",
        "-size",
        "48m",
        "-fs",
        "HFS+",
        "-volname",
        "SyncVaultQA",
        disk,
      ]);
      execFileSync("hdiutil", [
        "attach",
        "-nobrowse",
        "-mountpoint",
        mount,
        disk,
      ]);
      volumeMounted = true;
      await call("settings", { receive: path.join(mount, "받은 자료") });
      const d = await fs.statfs(mount);
      assert.ok(d.blocks * d.bsize < 64 * 1024 ** 2);
      await fs.writeFile(
        path.join(mount, "filler"),
        Buffer.alloc(d.bavail * d.bsize - 2 * 1024 ** 2, 69),
      );
    }
    if (op === "free") await fs.unlink(path.join(mount, "filler"));
    if (op === "check") {
      const file = path.join(mount, "받은 자료", "공간 시험.bin");
      const s = await fs.stat(file);
      assert.equal(s.size, 8 * 1024 ** 2);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      await call("settings", { receive: path.join(home, "받은 자료") });
      execFileSync("hdiutil", ["detach", mount]);
      volumeMounted = false;
      return hash.digest("hex");
    }
  },
  async missing({ on }) {
    const target = path.join(home, "받은 자료");
    await fs.rename(
      on ? target : target + ".off",
      on ? target + ".off" : target,
    );
  },
  async fileClipboard({ name }) {
    const file = path.join((await call("state")).shelf, name);
    if (mac) {
      const src =
        'function run(a){ObjC.import("AppKit");const p=$.NSPasteboard.pasteboardWithName(a[0]);p.clearContents;p.writeObjects($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(a[1])))}';
      execFileSync("osascript", ["-l", "JavaScript", "-e", src, station, file]);
    } else
      execFileSync(helper, ["qa-files"], {
        input: Buffer.from(file + "\0"),
        windowsHide: true,
        env: { ...process.env, SYNC_VAULT_QA_STATION: station },
      });
  },
  async write({ text = "", html = "", png = "" }) {
    const parts = [
      Buffer.from(text),
      Buffer.from(html),
      Buffer.from(png, "base64"),
    ];
    const input = mac
      ? Buffer.from(JSON.stringify(png ? { png } : { text, html }))
      : Buffer.concat(
          parts.flatMap((b) => {
            const n = Buffer.alloc(4);
            n.writeUInt32LE(b.length);
            return [n, b];
          }),
        );
    execFileSync(helper, ["qa-write"], {
      input,
      env: { ...process.env, SYNC_VAULT_QA_STATION: station },
      windowsHide: true,
    });
  },
  async read() {
    const b = execFileSync(helper, ["read-content"], {
      env: { ...process.env, SYNC_VAULT_QA_STATION: station },
      windowsHide: true,
    });
    let p = 0;
    const fields = Array.from({ length: 3 }, () => {
      let n = b.readUInt32LE(p);
      p += 4;
      const s = b.subarray(p, p + n);
      p += n;
      return s;
    });
    return {
      text: fields[0].toString(),
      html: fields[1].toString(),
      png: fields[2].toString("base64"),
    };
  },
  async restart() {
    await closeApp(app);
    app = undefined;
    await launch();
  },
  async metrics() {
    const root = await app.evaluate(() => process.pid),
      tree = await sampleTree(root);
    return {
      memory: tree.reduce((n, v) => n + v.bytes, 0),
      tree: tree.map((v) => ({ id: v.id, cpuMs: v.cpuMs })),
      visible: await tools.visible(),
    };
  },
  async editor() {
    assert.ok(mac);
    const script =
      'function run(args){ObjC.import("AppKit");$.NSApplication.sharedApplication;const v=$.NSTextView.alloc.initWithFrame($.NSMakeRect(0,0,420,100));v.setRichText(true);if(!v.readSelectionFromPasteboardType($.NSPasteboard.pasteboardWithName(args[0]),$.NSPasteboardTypeHTML))throw Error("paste");const f=v.textStorage.attributeAtIndexEffectiveRange($.NSFontAttributeName,0,null);return JSON.stringify({text:ObjC.unwrap(v.string),bold:!!($.NSFontManager.sharedFontManager.traitsOfFont(f)&2)});}';
    return JSON.parse(
      execFileSync("osascript", ["-l", "JavaScript", "-e", script, station], {
        encoding: "utf8",
      }),
    );
  },
};
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, op, args } = JSON.parse(line);
    if (op === "stop") break;
    try {
      const val = await tools[op](args || {});
      console.log(JSON.stringify({ id, val }));
    } catch (e) {
      console.log(JSON.stringify({ id, error: String(e.stack || e) }));
    }
  }
} finally {
  if (app) await closeApp(app);
  if (volumeMounted) execFileSync("hdiutil", ["detach", mount]);
  await fs.rm(home, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 220,
  });
}

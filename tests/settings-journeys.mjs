import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { launch, approve, fixture, send, action, job, base, cleanup } from "./desktop-peers.mjs";

try {
  const device = await launch("Settings"), peer = await launch("Registered");
  await approve(device, peer);
  const initial = await device.state();
  await device.call("settings", { smallCount: 17 });
  await device.call("defaults");
  assert.equal((await device.state()).settings.smallCount, 100);
  const inbox = path.join(base, "receive");
  const name = "previously-received.txt";
  const received = path.join(inbox, name);
  await device.call("settings", { receive: inbox, name: device.label, paused: true, updates: false });
  await send(peer, device, [await fixture("source/" + name, "이전에 받은 파일")]);
  await job(device, name, "승인 대기");
  await action(device, name, "accept");
  await job(peer, name, "완료");
  const output = path.join(base, "snapshot.png");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
  await device.app.evaluate(({ clipboard, dialog }, { png, output }) => {
    clipboard.read = async () => [];
    globalThis.qaImage = () => [{ types: ["image/png"],
      getType: async () => new Blob([Buffer.from(png, "base64")], { type: "image/png" }) }];
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: output });
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  }, { png, output });
  assert.equal(await device.call("folder"), null);
  await assert.rejects(device.call("save-image"), /PNG 이미지가 없습니다/);
  await device.app.evaluate(({ clipboard }) => { clipboard.read = globalThis.qaImage; });
  await device.call("save-image");
  await assert.rejects(fs.access(output), { code: "ENOENT" });
  await device.app.evaluate(({ dialog }, output) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  }, output);
  await device.call("save-image");
  assert.deepEqual(await fs.readFile(output), Buffer.from(png, "base64"));

  // The fixture supplies both dialog answers; only its own profile is reset.
  await device.call("reset");
  assert.equal((await device.state()).local.id, initial.local.id);
  assert.deepEqual((await device.state()).peers.map(p => p.id), initial.peers.map(p => p.id));
  await device.app.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    app.relaunch = () => {}; // Reopen this same disposable profile under Playwright.
  });
  const exit = device.app.waitForEvent("close", { timeout: 10000 });
  await Promise.all([exit, device.call("reset").catch(e => {
    if (!/closed|destroyed/i.test(e.message)) throw e;
  })]);
  const restarted = await launch("Settings");
  assert.notEqual((await restarted.state()).local.id, initial.local.id);
  assert.deepEqual((await restarted.state()).peers, []);
  assert.equal(await fs.readFile(received, "utf8"), "이전에 받은 파일");
  console.log("PASS defaults, PNG save/cancel/empty clipboard, registration reset cancellation and new identity after confirmation");
} finally { await cleanup(); }

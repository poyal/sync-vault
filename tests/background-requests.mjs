import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { launch, fixture, base, job, cleanup } from "./desktop-peers.mjs";
try {
  const a = await launch("Request-sender"), b = await launch("Request-receiver");
  const left = (await a.state()).local, right = (await b.state()).local;
  const receive = path.join(base, "approved");
  await b.call("settings", { receive });
  // Exercise the app's own Notification and Menu callbacks without posting a real OS toast.
  await b.app.evaluate(({ Notification, Tray, BrowserWindow }) => {
    globalThis.qaNotices = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.qaNotices.push(this); };
    Notification.prototype.close = function () {};
    const setMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.qaMenu = menu;
      return setMenu.call(this, menu);
    };
    BrowserWindow.getAllWindows()[0].close();
  });
  const noticeCount = () => b.app.evaluate(() => globalThis.qaNotices.length);
  const hidden = () => b.app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible());
  const pairing = a.call("pair", { address: right.address, port: right.port });
  await expect.poll(noticeCount).toBe(1);
  assert.equal(await hidden(), true);
  await b.app.evaluate(() => globalThis.qaNotices[0].emit("click"));
  await expect(b.page.locator("#pending")).toContainText(a.label);
  await b.page.locator('[data-action="approve"]').click();
  await pairing;
  await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const f = await fixture("sender/incoming.txt", "수신 승인 후 게시");
  await a.call("drop", [f]); await a.call("send", right.id);
  await job(b, "incoming.txt", "승인 대기");
  await expect.poll(noticeCount).toBe(2);
  await new Promise(r => setTimeout(r, 3200));
  assert.equal(await noticeCount(), 2);
  assert.equal(await hidden(), true);
  await assert.rejects(fs.access(path.join(receive, "incoming.txt")), { code: "ENOENT" });
  await b.app.evaluate(() => globalThis.qaMenu.items.find(i => i.label === "파일 수신 요청 열기").click());
  await expect(b.page.locator("#transfers")).toBeVisible();
  await b.page.locator('#jobs [data-action="accept"]').click();
  await job(a, "incoming.txt", "완료");
  assert.equal(await fs.readFile(path.join(receive, "incoming.txt"), "utf8"), "수신 승인 후 게시");
  await b.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
    // Late clicks for completed or expired requests cannot reopen the window.
    for (const notice of globalThis.qaNotices) notice.emit("click");
  });
  assert.equal(await hidden(), true);
  assert.ok((await b.state()).peers.some(p => p.id === left.id));
  await b.app.evaluate(({ Notification }) => { Notification.isSupported = () => false; });
  await b.page.evaluate(() => {
    window.qaLinks = [];
    window.vault.onRequest(link => window.qaLinks.push(link));
  });
  const names = ["first.txt", "second.txt"];
  for (const name of names) {
    await a.call("drop", [await fixture("sender/" + name, name)]);
    await a.call("send", right.id);
    await job(b, name, "승인 대기");
  }
  const pending = (await b.state()).jobs.filter(j => j.state === "승인 대기");
  assert.equal(pending.length, 2);
  const menuCount = () => b.app.evaluate(() =>
    globalThis.qaMenu.items.filter(i => i.label === "파일 수신 요청 열기").length);
  await expect.poll(menuCount).toBe(2);
  assert.equal(await hidden(), true);
  assert.equal(await noticeCount(), 2);
  for (let i = 0; i < names.length; i++) {
    await b.app.evaluate(() => globalThis.qaMenu.items.find(item => item.label === "파일 수신 요청 열기").click());
    await expect.poll(() => b.page.evaluate(() => window.qaLinks.length)).toBe(i + 1);
    const link = await b.page.evaluate(() => window.qaLinks.at(-1));
    const target = pending.find(j => j.id === link.id);
    assert.equal(link.page, "transfers");
    assert.ok(target, "menu must select a live request");
    pending.splice(pending.indexOf(target), 1);
    const op = i === 0 ? "cancel" : "accept";
    await b.page.locator('#jobs [data-action="' + op + '"][data-value="' + link.id + '"]').click();
    await job(a, target.name, i === 0 ? "취소" : "완료");
    const dest = path.join(receive, target.name);
    if (i === 0) await assert.rejects(fs.access(dest), { code: "ENOENT" });
    else assert.equal(await fs.readFile(dest, "utf8"), target.name);
    await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(menuCount).toBe(1 - i);
  }
  console.log("PASS one notification per request, stale clicks, and two independently resolved tray requests with notifications unavailable");
} finally { await cleanup(); }

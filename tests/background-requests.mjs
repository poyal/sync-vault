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
  console.log("PASS background requests, one notification per request, menu fallback and stale clicks");
} finally { await cleanup(); }

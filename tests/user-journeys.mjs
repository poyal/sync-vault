import { expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {
  base,
  launch,
  request,
  approve,
  nav,
  send,
  job,
  action,
  fixture,
  cleanup,
} from "./desktop-peers.mjs";
try {
  const a = await launch("Peer-A");
  let b = await launch("Peer-B");
  const out = path.join(base, "received"),
    later = path.join(base, "new destination");
  await b.call("settings", { receive: out });
  if (process.env.SYNC_VAULT_JOURNEY_CASE !== "transfer") {
    await request(a, b);
    await b.page.locator('[data-action="deny"]').click();
    await expect(a.page.locator("#notice")).toContainText("거절", {
      timeout: 6500,
    });
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal((await b.state()).pending.length, 0);
    console.log("PASS pairing rejection closed both screens");
  }
  await approve(a, b);
  await expect(a.page.locator("#notice")).toContainText("등록을 완료");
  console.log("PASS explicit pairing after rejection");
  const invalid = await fixture("not-a-directory", "kept");
  await nav(b, "설정");
  await b.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, invalid);
  await b.page.locator("#choose-folder").click();
  await b.page.locator('input[name="name"]').fill("편집 중");
  await b.page.getByRole("button", { name: "변경 저장" }).click();
  await expect(b.page.locator("#notice")).toContainText(/EEXIST|ENOTDIR|폴더/);
  await expect(b.page.locator('input[name="name"]')).toHaveValue("편집 중");
  assert.equal((await b.state()).settings.name, b.label);
  assert.equal((await b.state()).settings.receive, await fs.realpath(out));
  await b.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, out);
  await b.page.locator("#choose-folder").click();
  await b.page.locator('input[name="name"]').fill(b.label);
  await b.page.getByRole("button", { name: "변경 저장" }).click();
  await expect(b.page.locator("#notice")).not.toContainText(/EEXIST|ENOTDIR/);
  console.log(
    "PASS invalid destination preserves saved settings and form draft",
  );
  const f = await fixture("source/한글.txt", "원본 😀");
  await send(a, b, [f]);
  await job(b, "한글.txt", "승인 대기");
  assert.ok(!(await fs.readdir(out)).includes("한글.txt"));
  await b.call("settings", { receive: later });
  await action(b, "한글.txt", "accept");
  await job(a, "한글.txt", "완료");
  assert.equal(
    await fs.readFile(path.join(out, "한글.txt"), "utf8"),
    "원본 😀",
  );
  console.log("PASS manual approval and destination snapshot");
  const c = await fixture("source/cancel.txt", "취소");
  await send(a, b, [c]);
  await job(b, "cancel.txt", "승인 대기");
  await action(b, "cancel.txt", "cancel");
  await job(a, "cancel.txt", "취소");
  assert.deepEqual(await fs.readdir(later), []);
  console.log("PASS receiver declines pending transfer");
  const d = await fixture("source/offline.txt", "취소 후 재접속");
  await send(a, b, [d]);
  await job(b, "offline.txt", "승인 대기");
  await b.app.close();
  await action(a, "offline.txt", "cancel");
  await job(a, "offline.txt", "취소");
  b = await launch("Peer-B");
  await job(b, "offline.txt", "취소");
  assert.deepEqual(await fs.readdir(later), []);
  console.log("PASS offline send cancellation reaches restarted receiver");
  await nav(b, "기기");
  await b.page.locator('[data-action="autoaccept"]').click();
  const x = await fixture("one/report.txt", "첫째"),
    y = await fixture("two/report.txt", "둘째");
  await fs.writeFile(path.join(later, "report.txt"), "기존");
  await send(a, b, [x, y]);
  await job(a, "report.txt", "완료");
  assert.equal(
    await fs.readFile(path.join(later, "report.txt"), "utf8"),
    "기존",
  );
  const got = await Promise.all(
    ["report (1).txt", "report (2).txt"].map((n) =>
      fs.readFile(path.join(later, n), "utf8"),
    ),
  );
  assert.deepEqual(got.sort(), ["첫째", "둘째"].sort());
  console.log("PASS same-name selection and pre-existing file preserved");
  await nav(a, "기기");
  await a.page.locator('[data-action="forget"]').click();
  assert.equal((await a.state()).peers.length, 0);
  assert.equal(
    await fs.readFile(path.join(out, "한글.txt"), "utf8"),
    "원본 😀",
  );
  console.log("PASS unpair preserves completed downloads");
} finally {
  await cleanup();
}

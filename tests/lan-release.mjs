// Run an older Windows client and the Mac publisher on their isolated physical QA profiles.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { base, launch, fixture, cleanup } from "./desktop-peers.mjs";
const win = process.platform === "win32",
  token = process.argv[2];
if (
  !/^[a-z0-9-]{1,20}$/.test(token || "") ||
  process.env.SYNC_VAULT_QA_PHYSICAL !== "1"
)
  throw Error("physical QA run required");
const client = "QA-client-" + token,
  host = "QA-host-" + token,
  wait = (f) =>
    expect.poll(f, { timeout: 90000, intervals: [100, 250] }).toBe(true);
try {
  const d = await launch(win ? client : host);
  if (win) {
    assert.equal((await d.state()).version, "0.1.0");
    await d.app.evaluate(({ dialog }, name) => {
      dialog.showMessageBox = async (_w, o) => ({
        response: o.message === name + " 기기를 등록할까요?" ? 0 : 1,
        checkboxChecked: false,
      });
    }, host);
    const [address, port] = process.argv[3].split(":");
    let lastError = "";
    for (let i = 0; i < 16; i++) {
      try {
        await d.call("pair", { address, port: Number(port) });
      } catch (e) {
        lastError = e.message;
      }
      if ((await d.state()).peers.some((p) => p.name === host)) break;
      await new Promise((r) => setTimeout(r, 850));
    }
    assert.ok(
      (await d.state()).peers.some((p) => p.name === host),
      "Could not reach named host. " + lastError,
    );
    await wait(async () =>
      (await d.state()).peers.some((p) => p.name === host && p.online),
    );
    await d.call("check");
    assert.equal((await d.state()).update.status, "다운로드 가능");
    const first = d.call("download");
    await wait(async () => (await d.state()).update.status === "다운로드 중");
    await d.call("cancel-update");
    await first;
    assert.equal((await d.state()).update.ready, false);
    assert.deepEqual(await fs.readdir(path.join(d.profile, "updates")), []);
    await d.call("download");
    const s = await d.state();
    assert.ok(s.update.ready, s.update.status);
    assert.equal(s.update.next, "0.1.1");
    const f = await fixture("release-ok.txt", "서명 및 파일 검증 완료");
    await d.call("drop", [f]);
    await d.call("send", s.peers.find((p) => p.name === host).id);
    await wait(async () =>
      (await d.state()).jobs.some(
        (j) => j.name === "release-ok.txt" && j.state === "완료",
      ),
    );
    console.log(
      "PASS actual 0.1.0 Windows client cancelled and retried a signed 0.1.1 package from physical Mac",
    );
  } else {
    assert.equal((await d.state()).version, "0.1.1");
    console.log(
      "SERVING",
      (await d.state()).local.address,
      (await d.state()).local.port,
    );
    const inbox = path.join(base, "inbox");
    await d.call("settings", {
      receive: inbox,
      releaseFolder: path.resolve(process.argv[3]),
    });
    await wait(async () =>
      (await d.state()).pending.some((p) => p.name === client),
    );
    await d.page
      .locator("#pending article")
      .filter({ hasText: client })
      .locator('[data-action="approve"]')
      .click();
    await wait(async () =>
      (await d.state()).peers.some((p) => p.name === client),
    );
    await d.call("autoaccept", {
      id: (await d.state()).peers.find((p) => p.name === client).id,
      value: true,
    });
    await wait(async () =>
      (await d.state()).jobs.some(
        (j) => j.name === "release-ok.txt" && j.state === "완료",
      ),
    );
    assert.equal(
      await fs.readFile(path.join(inbox, "release-ok.txt"), "utf8"),
      "서명 및 파일 검증 완료",
    );
    console.log(
      "PASS Mac package publisher received verified completion from real Windows client",
    );
  }
} finally {
  await cleanup();
}

// Run against an isolated, older packaged application and an already signed local feed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import net from "node:net";
const [previous, feed] = process.argv.slice(2);
if (!previous || !feed)
  throw Error("upgrade.mjs <older packaged app directory> <signed feed>");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "sv-upgrade-")),
  profile = path.join(home, "profile"),
  win = process.platform === "win32";
const appRoot = path.join(home, win ? "Sync Vault" : "Sync Vault.app");
await fs.cp(previous, appRoot, { recursive: true, verbatimSymlinks: true });
await fs.mkdir(profile);
const exe = path.join(
    appRoot,
    win ? "Sync Vault.exe" : "Contents/MacOS/Sync Vault",
  ),
  manifest = JSON.parse(
    await fs.readFile(path.join(feed, "update.json"), "utf8"),
  );
const deferred = process.env.SYNC_VAULT_QA_DEFER === "1";
const env = {
  ...process.env,
  SYNC_VAULT_TEST_HOME: profile,
  SYNC_VAULT_TEST_LOOPBACK: "1",
  SYNC_VAULT_QA_STATION: "SyncVaultQA-upgrade-" + path.basename(home),
};
delete env.ELECTRON_RUN_AS_NODE;
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const { port } = listener.address();
await new Promise((resolve) => listener.close(resolve));
if (!win) env.SYNC_VAULT_QA_MOCK_KEYCHAIN = "1";
const previousProcess = spawn(
  exe,
  [
    "--user-data-dir=" + profile,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + port,
    ...(win ? [] : ["--use-mock-keychain"]),
  ],
  { env, stdio: "ignore", detached: true },
);
console.log("Upgrade fixture", home);
let browser;
let page;
for (let i = 0; i < 120 && !page; i++) {
  if (!browser)
    browser = await chromium
      .connectOverCDP("http://127.0.0.1:" + port, { timeout: 1000 })
      .catch(() => undefined);
  page = browser
    ?.contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("file:"));
  if (!page) await new Promise((r) => setTimeout(r, 250));
}
assert.ok(page, "packaged window did not start");
let updatedPID = 0;
let peerFixture;
try {
  await page.locator("#myip").filter({ hasText: /:\d+/ }).waitFor();
  const actual = await page.evaluate(() => window.vault.call("state"));
  const before = JSON.parse(await fs.readFile(path.join(profile, "state.json"), "utf8"));
  assert.notEqual(actual.version, manifest.version);
  await page.evaluate(
    (folder) =>
      window.vault.call("settings", {
        name: "업데이트 보존 QA",
        releaseFolder: folder,
        paused: true,
      }),
    path.resolve(feed),
  );
  await page.evaluate(() => window.vault.call("check"));
  let s = await page.evaluate(() => window.vault.call("state"));
  assert.equal(s.update.status, "다운로드 가능");
  await page.evaluate(() => window.vault.call("download"));
  s = await page.evaluate(() => window.vault.call("state"));
  assert.ok(s.update.ready, s.update.status);
  if (deferred) {
    peerFixture = await import("./desktop-peers.mjs");
    const peer = await peerFixture.launch("Update-peer");
    const receive = path.join(peerFixture.base, "received");
    await peer.call("settings", { receive });
    const name = "defer.txt",
      payload = "업데이트 전 승인한 파일";
    const sender = {
      page,
      label: "업데이트 보존 QA",
      state: () => page.evaluate(() => window.vault.call("state")),
    };
    await peerFixture.approve(peer, sender);
    const source = await peerFixture.fixture(name, payload);
    await page.evaluate(
      ([file, id]) =>
        window.vault
          .call("drop", [file])
          .then(() => window.vault.call("send", id)),
      [source, (await peer.state()).local.id],
    );
    await peerFixture.job(peer, name, "승인 대기");
    await page.evaluate(() => window.vault.call("update-later"));
    await new Promise((r) => setTimeout(r, 2800));
    assert.equal((await sender.state()).version, actual.version);
    assert.equal((await sender.state()).update.later, true);
    await peerFixture.action(peer, name, "accept");
    await peerFixture.job(peer, name, "완료");
    assert.equal(await fs.readFile(path.join(receive, name), "utf8"), payload);
  } else {
    void page.evaluate(() => window.vault.call("update-now")).catch(() => {});
  }
  const transactions = await fs.readdir(path.join(profile, "updates"));
  assert.equal(transactions.length, 1);
  const tx = path.join(profile, "updates", transactions[0]);
  for (let i = 0; i < 240; i++) {
    if (
      await fs.stat(path.join(tx, "failed.txt")).then(
        () => true,
        () => false,
      )
    )
      throw Error("Update rolled back: " + tx);
    if (
      await fs.stat(path.join(tx, "complete")).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok((await fs.readFile(path.join(tx, "healthy"), "utf8")).trim());
  assert.equal(
    await fs.readFile(path.join(tx, "healthy.version"), "utf8"),
    manifest.version,
  );
  updatedPID = Number(await fs.readFile(path.join(tx, "healthy.pid"), "utf8"));
  assert.ok(updatedPID > 0);
  const data = JSON.parse(
    await fs.readFile(path.join(profile, "state.json"), "utf8"),
  );
  assert.equal(data.settings.name, "업데이트 보존 QA");
  assert.equal(data.sealed, before.sealed);
  assert.equal(data.settings.login, before.settings.login);
  assert.equal(data.settings.receive, before.settings.receive);
  if (deferred) assert.ok(data.peers.some(p => p.name === "Update-peer"));
  console.log(
    JSON.stringify({
      from: actual.version,
      to: manifest.version,
      privateFeed: true,
      profilePreserved: true,
      deferredUntilDelivery: deferred,
      healthy: true,
    }),
  );
} finally {
  if (peerFixture) await peerFixture.cleanup();
  await browser?.close().catch(() => {});
  if (previousProcess.exitCode === null) previousProcess.kill();
  if (updatedPID) {
    try {
      process.kill(updatedPID);
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (updatedPID)
    await fs.rm(home, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
}

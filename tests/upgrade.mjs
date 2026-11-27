// Exercise the installed app's GitHub updater in a disposable copy. The optional
// asset directory supplies recorded GitHub responses before a candidate is public.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";

const [previous, version, assets] = process.argv.slice(2);
if (!previous || !/^\d+\.\d+\.\d+$/.test(version))
  throw Error("upgrade.mjs <이전 앱 폴더> <대상 버전> [서명된 GitHub 자산 폴더]");
if (process.platform === "darwin") process.env.SYNC_VAULT_QA_MOCK_KEYCHAIN = "1";
const { base, launch, approve, cleanup, wait } = await import("./desktop-peers.mjs");
const win = process.platform === "win32";
const staged = path.join(base, win ? "Sync Vault" : "Sync Vault.app");
let updatedPid;
try {
  await fs.cp(previous, staged, { recursive: true, verbatimSymlinks: true });
  const client = await launch("Update-client", path.join(staged, win ? "Sync Vault.exe" : "Contents/MacOS/Sync Vault"));
  const peer = await launch("Update-peer");
  await approve(client, peer);
  const inbox = path.join(base, "received");
  await client.call("settings", { receive: inbox });
  const before = await client.state();
  assert.notEqual(before.version, version);
  const settingsFile = path.join(client.profile, "state.json");
  const identity = JSON.parse(await fs.readFile(settingsFile, "utf8")).sealed;
  if (assets) {
    const names = ["update.json", "update.sig", "SyncVault-" + version + "-" + process.platform + "-" + process.arch + ".zip"];
    const files = await Promise.all(names.map(async name => {
      const file = path.resolve(assets, name);
      return { name, file, size: (await fs.stat(file)).size };
    }));
    await client.app.evaluate((_electron, { files, version }) => {
      const fs = process.getBuiltinModule("node:fs");
      const { Readable } = process.getBuiltinModule("node:stream");
      const base = "https://github.com/poyal/sync-vault/releases/download/v" + version + "/";
      globalThis.fetch = async (url) => {
        if (String(url) === "https://api.github.com/repos/poyal/sync-vault/releases/latest")
          return Response.json({ draft: false, prerelease: false, tag_name: "v" + version,
            assets: files.map(f => ({ name: f.name, size: f.size, state: "uploaded", browser_download_url: base + f.name })) });
        const file = files.find(f => String(url) === base + f.name);
        if (!file) throw Error("예상하지 않은 URL");
        return new Response(Readable.toWeb(fs.createReadStream(file.file)));
      };
    }, { files, version });
  }
  const { page } = client;
  await page.locator('aside [data-page="settings"]').click();
  await page.getByRole("button", { name: "앱 정보 · 업데이트" }).click();
  await page.getByRole("button", { name: "지금 확인" }).click();
  await expect(page.locator("#update-status")).toContainText("다운로드 가능", { timeout: 30000 });
  assert.equal((await client.state()).update.next, version);
  await page.getByRole("button", { name: "다운로드", exact: true }).click();
  const install = page.getByRole("button", { name: "전송 완료 후 설치" });
  await expect(install).toBeVisible({ timeout: 300000 });
  const [transaction] = await fs.readdir(path.join(client.profile, "updates"));
  const tx = path.join(client.profile, "updates", transaction);
  const source = await peer.state();
  const file = path.join(source.shelf, "transfer.txt");
  await fs.writeFile(file, "업데이트 전 파일");
  const item = (await client.call("vault-list", { peer: source.local.id })).rows.find(i => i.name === "transfer.txt");
  // Hold only this fixture's source file open request while installation is queued.
  await peer.app.evaluate((_electron, file) => {
    const fs = process.getBuiltinModule("node:fs/promises");
    const open = fs.open.bind(fs);
    const gate = new Promise(resolve => { globalThis.finishUpdateTestTransfer = resolve; });
    fs.open = async (p, ...args) => {
      if (p === file) await gate;
      return open(p, ...args);
    };
  }, file);
  await client.call("vault-get", { peer: source.local.id, id: item.id, name: item.name });
  await install.click();
  await wait(async () => (await client.state()).update.later);
  await delay(1500);
  assert.equal((await client.state()).version, before.version);
  await peer.app.evaluate(() => globalThis.finishUpdateTestTransfer());
  const result = async () => {
    if (await fs.stat(path.join(tx, "failed.txt")).catch(() => false)) return "rollback";
    return await fs.stat(path.join(tx, "complete")).then(() => "complete", () => "waiting");
  };
  await expect.poll(result, { timeout: 145000, intervals: [500] }).not.toBe("waiting");
  assert.equal(await result(), "complete");
  updatedPid = Number(await fs.readFile(path.join(tx, "healthy.pid"), "utf8"));
  assert.ok(Number.isSafeInteger(updatedPid) && updatedPid > 0);
  assert.equal(await fs.readFile(path.join(tx, "healthy.version"), "utf8"), version);
  const saved = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  assert.equal(saved.sealed, identity);
  assert.equal(saved.settings.receive, inbox);
  assert.ok(saved.peers.some(p => p.id === source.local.id));
  assert.equal(await fs.readFile(path.join(inbox, "transfer.txt"), "utf8"), "업데이트 전 파일");
  console.log("PASS", process.platform, assets ? "GitHub fixture" : "GitHub live", before.version, "→", version,
    "전송 완료 후 설치, 실제 재시작, 등록·기기 ID·파일 보존");
} finally {
  if (updatedPid) {
    try { process.kill(updatedPid); } catch (e) { if (e.code !== "ESRCH") throw e; }
    await delay(1000);
  }
  await cleanup();
}

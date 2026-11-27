import { _electron as electron, expect } from "@playwright/test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), "sync-vault-desktop-"));
const executable = process.env.SYNC_VAULT_QA_EXE || require("electron");
const shots = path.resolve("artifacts", "desktop");
await fs.mkdir(shots, { recursive: true });
async function launch() {
  const packaged = !!process.env.SYNC_VAULT_QA_EXE;
  const env = {
    ...process.env,
    SYNC_VAULT_TEST_HOME: home,
    SYNC_VAULT_TEST_LOOPBACK: "1",
    SYNC_VAULT_QA_STATION: "SyncVaultQA-" + randomUUID(),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    executablePath: executable,
    args: [
      ...(packaged ? [] : ["."]),
      "--user-data-dir=" + home,
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ],
    env,
    timeout: 35000,
  });
}
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  await page
    .locator("#myip")
    .filter({ hasText: /:\d+/ })
    .waitFor({ timeout: 20000 });
  await page.screenshot({ path: path.join(shots, "devices.png") });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const name = page.locator("input[name=name]");
  await name.fill("QA 전용 기기");
  await page.getByRole("button", { name: "변경 저장" }).click();
  await page.locator("#selfname").filter({ hasText: "QA 전용 기기" }).waitFor();
  await page.getByRole("button", { name: "앱 정보 · 업데이트" }).click();
  const auto = page.getByLabel("하루 한 번 새 버전 확인");
  await auto.uncheck();
  await expect.poll(() => page.evaluate(async () => (await window.vault.call("state")).settings.updates)).toBe(false);
  await app.evaluate(() => {
    globalThis.fetch = async () => new Response(null, { status: 404 });
  });
  await page.getByRole("button", { name: "지금 확인" }).click();
  await expect(page.locator("#update-status")).toContainText("공개된 GitHub 정식 릴리즈를 찾을 수 없습니다");
  await app.evaluate(({ app }) => {
    globalThis.fetch = async () => Response.json({
      draft: false, prerelease: false, tag_name: "v" + app.getVersion(), assets: [],
    });
  });
  await page.getByRole("button", { name: "지금 확인" }).click();
  await expect(page.locator("#update-status")).toContainText("최신 버전입니다");
  await expect(page.locator("#about-version")).toContainText(await app.evaluate(({ app }) => app.getVersion()));
  const checked = await page.locator("#update-checked").textContent();
  assert.match(checked, /마지막 확인/);
  await page.getByRole("button", { name: "가져오기 내역", exact: true }).click();
  await page.locator("#jobs").waitFor();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.locator("#selfname").filter({ hasText: "QA 전용 기기" }).waitFor();
  await page.locator('aside [data-page="settings"]').click();
  await page.getByRole("button", { name: "앱 정보 · 업데이트" }).click();
  await expect(page.getByLabel("하루 한 번 새 버전 확인")).not.toBeChecked();
  await expect(page.locator("#update-checked")).toHaveText(checked);
  assert.equal(await page.title(), "Sync Vault");
  console.log(
    "PASS · 실행, 설정 저장, About의 GitHub 릴리즈 조회·오류 복구, 자동 확인 설정·확인 시각 재실행 복원",
  );
} finally {
  await app?.close().catch(() => {});
  await fs.rm(home, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

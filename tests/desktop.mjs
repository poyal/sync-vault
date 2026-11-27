import { _electron as electron } from "playwright";
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
  await page.getByRole("button", { name: "지금 확인" }).click();
  await page
    .locator("#update")
    .filter({ hasText: /배포|최신/ })
    .waitFor();
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await page.locator("#dropzone").waitFor();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.locator("#selfname").filter({ hasText: "QA 전용 기기" }).waitFor();
  assert.equal(await page.title(), "Sync Vault");
  console.log(
    "PASS · 실행, 검색 주소, 설정 저장, 사설 배포 확인, 전송 화면, 재실행 복원",
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

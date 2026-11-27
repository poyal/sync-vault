const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

if (!process.versions.electron) {
  const home = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sv-key-store-"));
  try {
    const env = { ...process.env, SYNC_VAULT_TEST_HOME: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = require("node:child_process").spawnSync(require("electron"),
      [__filename, "--user-data-dir=" + home, "--sync-vault-login"], { env, stdio: "inherit", timeout: 15000, windowsHide: true });
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
    assert.ok(fs.existsSync(path.join(home, "verified")), "종료 메뉴 검증 누락");
    console.log("PASS · 키 저장소가 응답하기 전에도 창 없이 트레이 상태 표시 및 종료");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  const { app, BrowserWindow, Tray, safeStorage } = require("electron");
  let menu;
  const install = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function(value) { menu = value; return install.call(this, value); };
  safeStorage.isAsyncEncryptionAvailable = () => {
    setImmediate(() => {
      try {
        assert.equal(BrowserWindow.getAllWindows().length, 0);
        assert.ok(menu.items.some(item => item.label === "기기 키 저장소 확인 중" && !item.enabled));
        const quit = menu.items.find(item => item.label === "종료" && item.enabled);
        assert.ok(quit);
        fs.writeFileSync(path.join(app.getPath("userData"), "verified"), "ok");
        quit.click();
      } catch (error) { console.error(error); app.exit(1); }
    });
    return new Promise(() => {});
  };
  require(path.resolve("dist/main.cjs"));
}

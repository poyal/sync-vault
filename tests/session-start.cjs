const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  for (const scenario of [
    "starts-locked",
    "unlock-during-startup",
    "lock-during-startup",
  ]) {
    const home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sv-session-start-")),
    );
    try {
      const env = {
        ...process.env,
        SYNC_VAULT_SESSION_CASE: scenario,
        SYNC_VAULT_TEST_HOME: home,
        SYNC_VAULT_TEST_LOOPBACK: "1",
        SYNC_VAULT_QA_STATION: "SyncVaultQA-" + randomUUID(),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [
        __filename,
        "--user-data-dir=" + home,
        process.platform === "darwin"
          ? "--use-mock-keychain"
          : "--sync-vault-login",
      ];
      const result = spawnSync(require("electron"), args, {
        env,
        stdio: "inherit",
        timeout: 30000,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      const failure = path.join(home, "failure");
      if (fs.existsSync(failure)) throw Error(fs.readFileSync(failure, "utf8"));
      assert.equal(result.status, 0, scenario);
      assert.ok(fs.existsSync(path.join(home, "verified")), scenario);
      console.log("PASS", process.platform, scenario);
    } finally {
      fs.rmSync(home, {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 150,
      });
    }
  }
} else {
  const { app, dialog, powerMonitor } = require("electron");
  const fail = (error) => {
    fs.writeFileSync(
      path.join(process.env.SYNC_VAULT_TEST_HOME, "failure"),
      String(error.stack || error),
    );
    app.exit(1);
  };
  dialog.showMessageBox = async (...args) => {
    fail(Error(args.at(-1).message));
  };
  const scenario = process.env.SYNC_VAULT_SESSION_CASE;
  let locked = scenario !== "lock-during-startup";
  powerMonitor.getSystemIdleState = () => (locked ? "locked" : "active");
  if (process.platform === "darwin") {
    const original = app.getLoginItemSettings.bind(app);
    app.getLoginItemSettings = (...args) => ({
      ...original(...args),
      wasOpenedAtLogin: true,
    });
  }
  function transition(next) {
    locked = next;
    powerMonitor.emit(next ? "lock-screen" : "unlock-screen");
  }
  app.once("browser-window-created", (_event, window) => {
    if (scenario !== "starts-locked") transition(!locked);
    let shown = false;
    window.on("show", () => {
      shown = true;
    });
    const inspect = async () => {
      const call = (action, value) =>
        window.webContents.executeJavaScript(
          "window.vault.call(" +
            JSON.stringify(action) +
            "," +
            JSON.stringify(value ?? null) +
            ")",
        );
      const until = async (predicate, description) => {
        for (let i = 0; i < 100; ++i) {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw Error(scenario + " " + description);
      };
      await until(async () => (await call("state")).local.port > 0, "LAN 시작");
      const peer = (await call("state")).local.id;
      async function verify(expected) {
        await until(
          async () => (await call("state")).locked === expected,
          "잠금값 " + expected,
        );
        for (const action of ["vault-list", "vault-history"]) {
          if (expected)
            await assert.rejects(call(action, { peer }), /잠겼습니다/);
          else await call(action, { peer });
        }
      }
      await verify(locked);
      transition(false);
      transition(true);
      await verify(true);
      transition(false);
      await verify(false);
      assert.equal(window.isVisible(), false);
      assert.equal(shown, false);
      fs.writeFileSync(
        path.join(process.env.SYNC_VAULT_TEST_HOME, "verified"),
        "ok",
      );
    };
    window.webContents.once("did-finish-load", () => {
      inspect()
        .then(() => app.quit())
        .catch(fail);
    });
  });
  require(path.resolve("dist/main.cjs"));
}

import assert from "node:assert/strict";
import path from "node:path";
import { launch, cleanup } from "./desktop-peers.mjs";

const [stableExe, devExe] = process.argv.slice(2);
assert.ok(stableExe && devExe, "installed-channels.mjs <정식 실행 파일> <개발 실행 파일>");
try {
  const stable = await launch("Stable-profile", stableExe, { configure: false });
  const dev = await launch("Dev-profile", devExe, { configure: false });
  const before = await stable.state();
  const devState = await dev.state();
  assert.equal(await stable.app.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await dev.app.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await stable.app.evaluate(({ app }) => app.getName()), "Sync Vault");
  assert.equal(await dev.app.evaluate(({ app }) => app.getName()), "Sync Vault Dev");
  assert.ok(before.local.id && devState.local.id);
  assert.notEqual(before.local.id, devState.local.id);
  assert.equal(path.basename(before.settings.receive), "Sync Vault");
  assert.equal(path.basename(devState.settings.receive), "Sync Vault Dev");
  assert.equal(devState.settings.paused, true);
  assert.equal(devState.settings.updates, false);
  await dev.call("settings", { name: "Dev-only", updates: true, releaseFolder: dev.profile });
  assert.equal((await dev.state()).settings.updates, false);
  assert.equal((await dev.state()).settings.releaseFolder, "");
  await assert.rejects(dev.call("check"), /개발판/);
  if (process.argv.includes("--login-item")) {
    const registered = () => dev.app.evaluate(({ app }) => app.getLoginItemSettings(
      process.platform === "win32" ? { args: ["--sync-vault-login"] } : {}).openAtLogin);
    assert.equal(await registered(), false, "QA 개발 앱에 이미 로그인 항목이 설정되어 있습니다.");
    try {
      await dev.call("settings", { login: true });
      assert.equal(await registered(), true);
      await dev.call("settings", { login: false });
      assert.equal(await registered(), false);
      console.log("PASS", process.platform, "Dev login item registered with the OS and removed");
    } finally {
      if (await registered()) {
        await dev.app.evaluate(({ app }) => app.setLoginItemSettings({ openAtLogin: false,
          ...(process.platform === "win32" ? { args: ["--sync-vault-login"] } : {}) }));
        assert.equal(await registered(), false);
      }
    }
  }
  for (const [source, other] of [[dev, stable], [stable, dev]]) {
    const destination = await other.state();
    await assert.rejects(source.call("pair", {
      address: destination.local.address, port: destination.local.port,
    }), /업데이트|호환/);
    assert.deepEqual((await source.state()).peers, []);
    assert.deepEqual((await source.state()).pending, []);
  }
  await dev.app.close();
  await stable.app.close();
  const reopened = await launch("Stable-profile", stableExe, { configure: false });
  const after = await reopened.state();
  assert.equal(after.local.id, before.local.id);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.peers, before.peers);
  console.log("PASS", process.platform, "installed stable and Dev side by side, isolated update and pairing, retained stable settings");
} finally { await cleanup(); }

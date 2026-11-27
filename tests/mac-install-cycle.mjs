import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { base, launch, cleanup } from "./desktop-peers.mjs";
if (process.platform !== "darwin" || !process.argv[2])
  throw Error("mac-install-cycle.mjs <DMG> [--dev] [--system-keychain]");
const dev = process.argv.includes("--dev");
const systemKeychain = process.argv.includes("--system-keychain");
if (systemKeychain) {
  assert.ok(dev && process.env.SYNC_VAULT_QA_USER, "전용 QA 콘솔 계정을 지정하세요.");
  assert.equal(os.userInfo().username, process.env.SYNC_VAULT_QA_USER);
  assert.equal((await fs.stat("/dev/console")).uid, process.getuid());
}
const product = dev ? "Sync Vault Dev" : "Sync Vault";
const mount = path.join(base, "image"),
  apps = path.join(base, "Applications"),
  installed = path.join(apps, product + ".app");
const exe = path.join(installed, "Contents/MacOS", product);
await fs.mkdir(mount);
await fs.mkdir(apps);
let mounted = false;
let launchPending = false;
async function normalBoot() {
  const realExe = await fs.realpath(exe);
  let ready = false;
  const profile = path.join(await fs.realpath(base), "launchservices-profile");
  const userDir = "--user-data-dir=" + profile;
  function findPid() {
    const listing = execFileSync("/bin/ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8" });
    for (const line of listing.trim().split("\n")) {
      const [, pid, command] = line.trim().match(/^(\d+)\s+(.*)$/) || [];
      if (command && [realExe, exe].some(p => command.startsWith(p + " ")) && command.includes(userDir)) return Number(pid);
    }
  }
  execFileSync("/usr/bin/open", ["-n", "-g", "--env", "SYNC_VAULT_QA_STATION=SyncVaultQA-" + randomUUID(),
    await fs.realpath(installed), "--args", "--sync-vault-login", userDir]);
  launchPending = true;
  try {
    for (let i = 0; i < 60; i++) {
      const pid = findPid();
      if (pid) {
        const sealed = await fs.readFile(path.join(profile, "state.json"), "utf8")
          .then(s => JSON.parse(s).sealed, () => undefined);
        if (typeof sealed === "string" && sealed.length > 0) {
          const listeners = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          if (listeners.error) throw listeners.error;
          if (listeners.status === 0 && /^n.+:\d+$/m.test(listeners.stdout)) {
            ready = true;
            return sealed;
          }
        }
      }
      await delay(250);
    }
    throw Error("LaunchServices로 실행한 개발판의 키 저장소와 TCP 서비스 준비 시간 초과");
  } finally {
    const pid = findPid();
    if (pid) {
      execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e",
        "function run(a){ObjC.import('AppKit');$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0])).terminate;}", String(pid)]);
      for (let i = 0; i < 40 && findPid() === pid; i++) await delay(100);
      if (findPid() === pid) {
        process.kill(pid, "SIGKILL");
        for (let i = 0; i < 40 && findPid() === pid; i++) await delay(100);
        assert.notEqual(findPid(), pid, "시험 앱 종료 시간 초과");
        launchPending = false;
        if (ready) throw Error("실행한 시험 앱이 정상 종료 요청에 응답하지 않았습니다.");
      }
      launchPending = false;
    }
  }
}
try {
  execFileSync(
    "hdiutil",
    [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      path.resolve(process.argv[2]),
    ],
    { stdio: "pipe" },
  );
  mounted = true;
  const copy = () =>
    execFileSync("ditto", [path.join(mount, product + ".app"), installed]);
  copy();
  execFileSync("codesign", ["--verify", "--deep", "--strict", installed]);
  const originalSeal = systemKeychain ? await normalBoot() : undefined;
  const one = await launch("Install-cycle", exe, { loginStart: dev });
  const destination = path.join(base, "downloads");
  await one.call("settings", { receive: destination, smallCount: 37 });
  const identity = (await one.state()).local.id;
  await one.app.close();
  await fs.rm(installed, { recursive: true });
  assert.equal(
    await fs.stat(exe).then(
      () => true,
      () => false,
    ),
    false,
  );
  copy();
  if (systemKeychain) {
    assert.ok((await normalBoot()) === originalSeal, "재설치 뒤 암호화된 기기 ID 변경");
    console.log("PASS macOS LaunchServices hidden launch and real login Keychain across reinstall");
  }
  const two = await launch("Install-cycle", exe, { loginStart: dev }),
    state = await two.state();
  assert.equal(state.product, product);
  const version = JSON.parse(await fs.readFile("package.json", "utf8")).version;
  assert.equal(state.version, dev ? version + "-dev" : version);
  assert.equal(state.local.id, identity);
  assert.equal(state.settings.receive, await fs.realpath(destination));
  assert.equal(state.settings.smallCount, 37);
  await two.app.close();
  console.log(
    "PASS macOS DMG copy, launch, app removal, reinstall, retained device identity and settings",
  );
} finally {
  if (mounted) execFileSync("hdiutil", ["detach", mount], { stdio: "pipe" });
  if (launchPending) console.error("LaunchServices 앱 종료가 확인되지 않아 시험 폴더를 보존했습니다.", base);
  else await cleanup();
}

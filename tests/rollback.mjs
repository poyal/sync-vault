import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const win = process.platform === "win32";
const swapScript = path.resolve(process.argv[2] || (win ? "ui/swap.ps1" : "ui/swap.sh"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "sv-rollback-"));
const target = path.join(home, win ? "Sync Vault" : "Sync Vault.app");
const container = path.join(home, ".syncvault-update-fixture");
const replacement = win
  ? path.join(container, "new")
  : path.join(container, "new", "Sync Vault.app");
const profile = path.join(home, "profile");
const transaction = path.join(profile, "updates", randomUUID());
const restoredPID = path.join(profile, "restored.pid");
let relaunchPending = false;
try {
  for (const dir of [replacement, transaction])
    await fs.mkdir(dir, { recursive: true });
  // The replacement exits without reporting healthy. The restored app exits normally.
  if (win) {
    await fs.mkdir(target);
    for (const dir of [target, replacement])
      await fs.copyFile(
        "out/native/clipboard.exe",
        path.join(dir, "Sync Vault.exe"),
      );
  } else {
    const contents = path.join(target, "Contents");
    await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
    await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.syncvault.qa.rollback</string>
<key>CFBundleExecutable</key><string>Restored</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`);
    const build = spawnSync("/usr/bin/xcrun", ["clang", "-x", "c", "-", "-o", path.join(contents, "MacOS/Restored")], {
      encoding: "utf8",
      input: `#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *prefix = "--user-data-dir=";
  if (argc != 2 || strncmp(argv[1], prefix, strlen(prefix)) || chdir(argv[1] + strlen(prefix))) return 2;
  FILE *marker = fopen("restored.pid", "wx");
  if (!marker) return 3;
  if (fprintf(marker, "%ld", (long)getpid()) < 0) return 4;
  return fclose(marker) != 0;
}\n`,
    });
    assert.equal(build.status, 0, build.stderr);
    const macOS = path.join(replacement, "Contents", "MacOS");
    await fs.mkdir(macOS, { recursive: true });
    await fs.writeFile(path.join(macOS, "Sync Vault"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
  }
  await fs.writeFile(path.join(target, "previous-version"), "0.0.9");
  await fs.writeFile(
    path.join(profile, "state.json"),
    '{"setting":"broken migration"}',
  );
  await fs.writeFile(
    path.join(transaction, "state.json"),
    '{"setting":"original"}',
  );
  const ticket = randomUUID();
  await fs.writeFile(path.join(transaction, "commit"), ticket);
  relaunchPending = !win;
  const r = win
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          swapScript,
          "-ParentPid",
          "2147483647",
          "-Target",
          target,
          "-Replacement",
          replacement,
          "-Container",
          container,
          "-ProfileRoot",
          profile,
          "-Transaction",
          transaction,
          "-Ticket",
          ticket,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 20000 },
      )
    : spawnSync(
        "/bin/sh",
        [
          swapScript,
          "2147483647",
          target,
          replacement,
          container,
          profile,
          transaction,
          ticket,
        ],
        { encoding: "utf8", timeout: 20000 },
      );
  assert.equal(r.status, 1, r.stderr || String(r.error));
  assert.match(
    await fs.readFile(path.join(transaction, "failed.txt"), "utf8"),
    /rolled back/,
  );
  assert.equal(
    await fs.readFile(path.join(target, "previous-version"), "utf8"),
    "0.0.9",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(profile, "state.json"), "utf8"))
      .setting,
    "original",
  );
  if (!win) {
    // LaunchServices open returns before the restored executable has started.
    const deadline = Date.now() + 20000;
    let pid;
    while (Date.now() < deadline) {
      if (!pid) {
        const marker = await fs.readFile(restoredPID, "utf8").catch(error => {
          if (error.code !== "ENOENT") throw error;
          return "";
        });
        if (/^[1-9]\d*$/.test(marker)) pid = Number(marker);
      }
      if (pid) {
        try { process.kill(pid, 0); } catch (error) {
          if (error.code !== "ESRCH") throw error;
          relaunchPending = false;
          break;
        }
      }
      await delay(100);
    }
    assert.ok(!relaunchPending, "복원된 앱의 기동과 정상 종료를 확인할 수 없습니다.");
    console.log("PASS · LaunchServices로 복원한 앱의 실행과 종료 확인");
  }
  console.log("PASS · 시작 실패 시 이전 프로그램과 설정 복원");
} finally {
  if (relaunchPending) console.error("실행 중일 수 있는 복원 시험 앱을 보존했습니다.", home);
  else await fs.rm(home, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

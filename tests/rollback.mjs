import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const win = process.platform === "win32";
const home = await fs.mkdtemp(path.join(os.tmpdir(), "sv-rollback-"));
const target = path.join(home, win ? "Sync Vault" : "Sync Vault.app");
const container = path.join(home, ".syncvault-update-fixture");
const replacement = win
  ? path.join(container, "new")
  : path.join(container, "new", "Sync Vault.app");
const profile = path.join(home, "profile");
const transaction = path.join(profile, "updates", randomUUID());
try {
  for (const dir of [replacement, transaction])
    await fs.mkdir(dir, { recursive: true });
  // Both test executables exit immediately. No desktop or user clipboard is opened.
  if (win) {
    await fs.mkdir(target);
    for (const dir of [target, replacement])
      await fs.copyFile(
        "out/native/clipboard.exe",
        path.join(dir, "Sync Vault.exe"),
      );
  } else {
    const a = spawnSync(
      "/usr/bin/osacompile",
      ["-o", target, "-e", "return 1"],
      { encoding: "utf8" },
    );
    assert.equal(a.status, 0, a.stderr);
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
  const r = win
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.resolve("ui/swap.ps1"),
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
          path.resolve("ui/swap.sh"),
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
  console.log("PASS · 시작 실패 시 이전 프로그램과 설정 복원");
} finally {
  await fs.rm(home, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

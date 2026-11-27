import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  base,
  launch,
  approve,
  send,
  job,
  action,
  fixture,
  wait,
  cleanup,
} from "./desktop-peers.mjs";
const attachDir = path.join(base, "mounted");
const disk = path.join(base, "test-volume.dmg");
const mac = process.platform === "darwin";
let mounted = false;
async function mount() {
  await fs.mkdir(attachDir, { recursive: true });
  execFileSync(
    "hdiutil",
    ["attach", "-nobrowse", "-mountpoint", attachDir, disk],
    { stdio: "pipe" },
  );
  mounted = true;
}
function detach() {
  execFileSync("hdiutil", ["detach", attachDir], { stdio: "pipe" });
  mounted = false;
}
try {
  if (mac) {
    execFileSync(
      "hdiutil",
      [
        "create",
        "-size",
        "40m",
        "-fs",
        "HFS+",
        "-volname",
        "SyncVaultQA",
        disk,
      ],
      { stdio: "pipe" },
    );
    await mount();
  }
  const a = await launch("Storage-A"),
    b = await launch("Storage-B");
  await approve(a, b);
  const receive = path.join(mac ? attachDir : base, "storage");
  await b.call("settings", { receive });
  const payload = Buffer.alloc(8 * 1024 ** 2, 0x6b),
    src = await fixture("src/resume.bin", payload);
  await send(a, b, [src]);
  await job(b, "resume.bin", "승인 대기");
  if (mac) detach();
  else await fs.rename(receive, receive + ".removed");
  await action(b, "resume.bin", "accept");
  await job(a, "resume.bin", "오류");
  // A new transfer offered while a custom location is absent must not recreate it on another disk.
  const after = await fixture("src/after.txt", "다시 연결");
  await send(a, b, [after]);
  await job(a, "after.txt", "오류");
  assert.equal(
    await fs.stat(receive).then(
      () => true,
      () => false,
    ),
    false,
  );
  if (mac) await mount();
  else await fs.rename(receive + ".removed", receive);
  await action(a, "resume.bin", "retry");
  await job(a, "resume.bin", "완료");
  assert.deepEqual(
    await fs.readFile(path.join(receive, "resume.bin")),
    payload,
  );
  await action(a, "after.txt", "retry");
  await job(b, "after.txt", "승인 대기");
  await action(b, "after.txt", "accept");
  await job(a, "after.txt", "완료");
  console.log(
    "PASS unavailable receive folder, queued and new transfers, reconnect and retry",
  );
  if (mac) {
    const fsInfo = await fs.statfs(attachDir),
      bytes = fsInfo.bavail * fsInfo.bsize;
    assert.ok(
      fsInfo.blocks * fsInfo.bsize < 50 * 1024 ** 2 && bytes > 4 * 1024 ** 2,
    );
    const filler = path.join(attachDir, "qa-filler");
    await fs.writeFile(filler, Buffer.alloc(bytes - 2 * 1024 ** 2, 37));
    const full = await fixture("src/full.bin", payload);
    await send(a, b, [full]);
    await job(b, "full.bin", "승인 대기");
    await action(b, "full.bin", "accept");
    await job(a, "full.bin", "오류");
    assert.equal(
      await fs.stat(path.join(receive, "full.bin")).then(
        () => true,
        () => false,
      ),
      false,
    );
    await fs.unlink(filler);
    await action(a, "full.bin", "retry");
    await job(a, "full.bin", "완료");
    assert.deepEqual(
      await fs.readFile(path.join(receive, "full.bin")),
      payload,
    );
    console.log(
      "PASS real disk-full on 40 MiB image, space reclaimed, retry and byte equality",
    );
  }
  // Source disappears after receiver approval. A retry after replacement must preserve the changed bytes.
  const changed = await fixture("src/changed.txt", "old");
  await send(a, b, [changed]);
  await job(b, "changed.txt", "승인 대기");
  await fs.unlink(changed);
  await action(b, "changed.txt", "accept");
  await job(a, "changed.txt", "오류");
  await fs.writeFile(changed, "달라진 내용");
  await action(a, "changed.txt", "retry");
  await job(a, "changed.txt", "완료");
  assert.equal(
    await fs.readFile(path.join(receive, "changed.txt"), "utf8"),
    "달라진 내용",
  );
  console.log(
    "PASS removed source reselected by retry, updated size and digest",
  );
} finally {
  if (mounted) detach();
  await cleanup();
}

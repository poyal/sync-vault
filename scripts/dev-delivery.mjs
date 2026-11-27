import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const [operation, manifestFile, destination] = process.argv.slice(2);
assert.ok(manifestFile && ["copy", "verify", "clean"].includes(operation),
  "dev-delivery.mjs copy <installer.json> <새 전달 폴더> | verify|clean <installer.json>");
const dir = await fs.realpath(path.dirname(path.resolve(manifestFile)));
assert.equal(path.basename(manifestFile), "installer.json");
const record = JSON.parse(await fs.readFile(path.join(dir, "installer.json"), "utf8"));
assert.ok(["win-x64", "mac-arm64"].includes(record.target));
const ext = record.target === "win-x64" ? ".exe" : ".dmg";
assert.match(record.version, /^\d+\.\d+\.\d+$/);
assert.equal(record.file, "SyncVault-Dev-" + record.version + "-" + record.target + ext);
assert.match(record.commit, /^[0-9a-f]{40}$/);
assert.match(record.sha256, /^[0-9a-f]{64}$/);
async function verify(file) {
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && stat.size === record.bytes, "설치본 크기 불일치");
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  assert.equal(h.digest("hex"), record.sha256, "설치본 해시 불일치");
}
const original = path.join(dir, record.file);
await verify(original);
if (operation === "copy") {
  assert.ok(destination);
  await fs.mkdir(destination); // Refuse to overwrite an earlier delivery.
  const to = path.join(destination, record.file);
  await fs.copyFile(original, to, constants.COPYFILE_EXCL);
  await verify(to);
  await fs.copyFile(path.join(dir, "installer.json"), path.join(destination, "installer.json"), constants.COPYFILE_EXCL);
} else if (operation === "clean") {
  // Remove this exact verified installer only; other builds may share its directory.
  await fs.unlink(original);
}
console.log(operation, record.target, record.sha256);

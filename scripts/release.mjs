import fs from "node:fs";
import path from "node:path";
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  createHash,
} from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.resolve(".release-keys"),
  pub = path.resolve("release-key.pub");
function protect(data, decode = false) {
  const cmd =
    "Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::" +
    (decode ? "Unprotect" : "Protect") +
    "($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  return Buffer.from(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { input: data.toString("base64"), encoding: "utf8", windowsHide: true },
    ),
    "base64",
  );
}
const [op, folder, version, ...archives] = process.argv.slice(2);
if (op === "init") {
  if (
    fs.existsSync(pub) ||
    (fs.existsSync(root) && fs.readdirSync(root).length)
  )
    throw Error("기존 서명키가 있습니다.");
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"),
    der = privateKey.export({ format: "der", type: "pkcs8" });
  fs.writeFileSync(
    path.join(
      root,
      process.platform === "win32" ? "private.dpapi" : "private.der",
    ),
    process.platform === "win32" ? protect(der) : der,
    { mode: 0o600, flag: "wx" },
  );
  fs.writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }), {
    flag: "wx",
  });
} else if (op === "publish") {
  if (!folder || !/^\d+\.\d+\.\d+$/.test(version) || !archives.length)
    throw Error("release.mjs publish <새 로컬 배포 폴더> <버전> <zip 파일...>");
  const target = path.resolve(folder);
  fs.mkdirSync(target, { recursive: true });
  const key = process.env.SYNC_VAULT_SIGNING_FILE
    ? createPrivateKey(fs.readFileSync(process.env.SYNC_VAULT_SIGNING_FILE))
    : createPrivateKey({
        key:
          process.platform === "win32"
            ? protect(fs.readFileSync(path.join(root, "private.dpapi")), true)
            : fs.readFileSync(path.join(root, "private.der")),
        format: "der",
        type: "pkcs8",
      });
  const publicKey = createPublicKey(fs.readFileSync(pub));
  if (!createPublicKey(key).equals(publicKey))
    throw Error("공개키가 일치하지 않습니다.");
  const previousManifest = path.join(target, "update.json");
  const previousSignature = path.join(target, "update.sig");
  let platforms = {};
  let notes = process.env.SYNC_VAULT_RELEASE_NOTES ?? "";
  if (fs.existsSync(previousManifest) || fs.existsSync(previousSignature)) {
    const bytes = fs.readFileSync(previousManifest);
    if (!verify(null, bytes, publicKey, fs.readFileSync(previousSignature)))
      throw Error("기존 통합 목록의 서명이 일치하지 않습니다.");
    const previous = JSON.parse(bytes);
    if (previous.format !== "sync-vault-update-v1" || previous.version !== version)
      throw Error("다른 릴리즈의 배포 폴더입니다.");
    platforms = previous.platforms;
    notes = process.env.SYNC_VAULT_RELEASE_NOTES ?? previous.notes;
  }
  function writeManifest(stem, entries) {
    const bytes = Buffer.from(JSON.stringify({ format: "sync-vault-update-v1", version, notes, platforms: entries }));
    for (const [ext, contents] of [["sig", sign(null, bytes, key)], ["json", bytes]]) {
      const file = path.join(target, stem + "." + ext);
      fs.writeFileSync(file + ".tmp", contents);
      fs.renameSync(file + ".tmp", file);
    }
  }
  for (const file of archives) {
    const name = path.basename(file),
      platform = name.endsWith("-win32-x64.zip")
        ? "win32-x64"
        : name.endsWith("-darwin-arm64.zip")
          ? "darwin-arm64"
          : null;
    if (!platform || name !== "SyncVault-" + version + "-" + platform + ".zip")
      throw Error("파일명에 버전·플랫폼이 필요합니다.");
    const out = path.join(target, name);
    if (path.resolve(file) !== out) fs.copyFileSync(file, out);
    const h = createHash("sha256");
    for await (const block of fs.createReadStream(out)) h.update(block);
    platforms[platform] = {
      name,
      size: fs.statSync(out).size,
      sha256: h.digest("hex"),
    };
    writeManifest("update-" + platform, { [platform]: platforms[platform] });
  }
  writeManifest("update", platforms);
} else throw Error("init 또는 publish를 선택하세요.");

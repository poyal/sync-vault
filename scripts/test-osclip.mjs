import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
if (process.platform !== "win32") throw Error("Windows 테스트입니다.");
const dir = path.resolve("artifacts/os-clipboard");
fs.mkdirSync(dir, { recursive: true });
const vs = execFileSync(
  path.join(
    process.env["ProgramFiles(x86)"],
    "Microsoft Visual Studio/Installer/vswhere.exe",
  ),
  [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ],
  { encoding: "utf8" },
).trim();
fs.writeFileSync(
  path.join(dir, "compile.cmd"),
  '@echo off\r\ncall "' +
    vs +
    '\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul || exit /b 1\r\ncl /nologo /std:c++17 /EHsc /O2 /MT "' +
    path.resolve("tests/station.cpp") +
    '" /Fe:station.exe /link user32.lib\r\n',
);
execFileSync("cmd.exe", ["/d", "/c", "compile.cmd"], {
  cwd: dir,
  stdio: "inherit",
});
const script = path.join(dir, "test.cjs");
await build({
  entryPoints: [
    process.argv.includes("--live") ? "tests/liveclip.ts" : "tests/osclip.ts",
  ],
  outfile: script,
  platform: "node",
  format: "cjs",
  bundle: true,
  external: ["electron"],
});
const id = "SyncVaultQA-" + randomUUID(),
  home = path.join(dir, id);
fs.mkdirSync(home);
const env = {
  ...process.env,
  SYNC_VAULT_QA_STATION: id,
  SYNC_VAULT_QA_HOME: home,
};
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(
  path.join(dir, "station.exe"),
  [id, createRequire(import.meta.url)("electron"), script],
  { env, stdio: "inherit", windowsHide: true },
);
if (r.status !== 0)
  throw Error(
    fs.existsSync(path.join(home, "error.txt"))
      ? fs.readFileSync(path.join(home, "error.txt"), "utf8")
      : "isolated Electron exit " + r.status,
  );
console.log(fs.readFileSync(path.join(home, "result.json"), "utf8"));

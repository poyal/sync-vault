import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
const development = process.argv.includes("--dev");
const out = path.resolve(development ? "artifacts/dev-native" : "out/native");
const dist = development ? "artifacts/dev-runtime" : "dist";
fs.mkdirSync(out, { recursive: true });
if (process.platform === "win32") {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"],
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const vs = execFileSync(
    vswhere,
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
  if (!vs) throw Error("Visual Studio C++ Build Tools가 필요합니다.");
  const src = path.resolve("native/clipboard-win.cpp");
  fs.writeFileSync(
    path.join(out, "compile.cmd"),
    '@echo off\r\ncall "' +
      vs +
      '\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul || exit /b 1\r\ncl /nologo /std:c++17 /utf-8 /EHsc /O2 /MT "' +
      src +
      '" /Fe:clipboard.exe /link user32.lib shell32.lib || exit /b 1\r\ncl /nologo /std:c++17 /utf-8 /EHsc /O2 /MT "' +
      path.resolve("native/update-launch-win.cpp") +
      '" /Fe:update-launch.exe\r\n',
  );
  execFileSync("cmd.exe", ["/d", "/c", "compile.cmd"], {
    cwd: out,
    stdio: "inherit",
  });
  for (const name of [
    "compile.cmd",
    "clipboard-win.obj",
    "update-launch-win.obj",
  ])
    fs.rmSync(path.join(out, name), { force: true });
} else if (process.platform === "darwin") {
  execFileSync(
    "xcrun",
    [
      "clang++",
      "-arch",
      "arm64",
      "-mmacosx-version-min=14.0",
      "-fobjc-arc",
      "-framework",
      "AppKit",
      "-O2",
      "native/clipboard-mac.mm",
      "-o",
      out + "/clipboard",
    ],
    { stdio: "inherit" },
  );
} else throw Error("Windows 또는 Mac에서 빌드하세요.");
await build({
  entryPoints: ["src/main.ts", "src/preload.ts"],
  outdir: dist,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  define: {
    __SYNC_VAULT_DEV__: JSON.stringify(development),
    "process.env.SYNC_VAULT_RELEASE_KEY": JSON.stringify(
      development ? "" : process.env.SYNC_VAULT_RELEASE_KEY ||
        (fs.existsSync("release-key.pub")
          ? fs.readFileSync("release-key.pub", "utf8")
          : ""),
    ),
  },
});
fs.cpSync("ui", path.join(dist, "ui"), { recursive: true });

import { makeIcon } from "./icon.mjs";
makeIcon();

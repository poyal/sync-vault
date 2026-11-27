import fs from "node:fs";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
fs.mkdirSync("artifacts/test", { recursive: true });
await build({
  entryPoints: [
    "tests/core.ts",
    "tests/peer.ts",
    "tests/large.ts",
    "tests/mesh.ts",
  ],
  outdir: "artifacts/test",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  bundle: true,
  format: "cjs",
  target: "node24",
});
const test = spawnSync(
  process.execPath,
  ["--test", "artifacts/test/core.cjs"],
  { stdio: "inherit" },
);
process.exitCode = test.status ?? 1;

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const [configFile, mode] = process.argv.slice(2);
assert.ok(configFile && ["--files-only", "--desktop"].includes(mode),
  "benchmark.mjs <local-config.json> --files-only|--desktop");
const config = JSON.parse(await fs.readFile(configFile, "utf8"));
assert.match(config.macHost, /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
const run = randomUUID().slice(0, 8);
const file = path.resolve("artifacts/performance", "compare-" + run + ".json");
await fs.mkdir(path.dirname(file), { recursive: true });
const report = { run, mode, status: "RUNNING", builds: {}, errors: [] };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const p95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
function worker(side, exe, name) {
  const args = ["tests/benchmark-peer.mjs", exe, name, mode.slice(2)];
  const proc = side === "win" ? spawn(process.execPath, args, { windowsHide: true }) :
    spawn("ssh", ["-o", "BatchMode=yes", config.macHost, "cd " + quote(config.macWorkdir) +
      " && exec " + [config.macNode, ...args].map(quote).join(" ")], { windowsHide: true });
  proc.stderr.pipe(process.stderr);
  let serial = 0, ended = false;
  const pending = new Map();
  const done = new Promise(resolve => proc.once("close", code => {
    ended = true;
    for (const waiter of pending.values()) waiter.reject(Error(side + " exited " + code));
    resolve(code);
  }));
  proc.on("error", err => { for (const waiter of pending.values()) waiter.reject(err); });
  proc.stdin.on("error", err => { for (const waiter of pending.values()) waiter.reject(err); });
  createInterface({ input: proc.stdout }).on("line", line => {
    if (!line.startsWith("SVQA ")) return;
    const { id, result, error } = JSON.parse(line.slice(5));
    const w = pending.get(id);
    if (w) error ? w.reject(Error(side + " " + error)) : w.resolve(result);
  });
  return {
    name,
    async call(op, value) {
      assert.ok(!ended, side + " unavailable");
      const id = ++serial;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(Error(side + " timeout: " + op)), 200000);
          proc.stdin.write(JSON.stringify({ id, op, value }) + "\n");
        });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
    async stop() { if (!ended) proc.stdin.end('{"op":"exit"}\n'); await done; },
  };
}
async function oneCopy(sender, receiver, label) {
  const start = performance.now();
  await sender.call("copy", label);
  await receiver.call("paste", label);
  return performance.now() - start;
}
async function measure(build, executables) {
  const w = worker("win", executables.win, "QA-" + run + "-W");
  const m = worker("mac", executables.mac, "QA-" + run + "-M");
  const stats = report.builds[build] = { discovery: { win: [], mac: [] }, directions: {} };
  try {
    await Promise.all([w.call("info"), m.call("info")]);
    for (let i = 0; i < 20; i++) {
      const [wt, mt] = await Promise.all([w.call("discover", m.name), m.call("discover", w.name)]);
      stats.discovery.win.push(wt); stats.discovery.mac.push(mt);
    }
    const [wi, mi] = await Promise.all([w.call("info"), m.call("info")]);
    await Promise.all([w.call("pair", mi), m.call("approve", wi.id)]);
    await Promise.all([w.call("ready", mi.id), m.call("ready", wi.id)]);
    for (const [direction, sender, receiver] of [["win-to-mac", w, m], ["mac-to-win", m, w]]) {
      const d = stats.directions[direction] = { pasteMs: [], busyPasteMs: [], mibPerSecond: [], timeouts: 0 };
      if (mode === "--desktop") {
        for (let i = 0; i < 100; i++) {
          try { d.pasteMs.push(await oneCopy(sender, receiver, "한글 😀 " + run + "-" + i + direction)); }
          catch (e) { d.timeouts++; report.errors.push(build + "/" + direction + ": " + String(e)); }
        }
      }
      for (let i = 0; i < 3; i++) {
        const name = direction + "-" + i + ".bin";
        const hash = await sender.call("prepareFile", name);
        const start = performance.now();
        await sender.call("sendFile", name);
        let finished = false;
        const received = receiver.call("received", name).then(() => performance.now()).finally(() => { finished = true; });
        const load = async () => {
          let n = 0;
          while (mode === "--desktop" && !finished) {
            if (await sender.call("sending", name)) {
              const ms = await oneCopy(sender, receiver, run + "-" + name + "-" + n++);
              if (await sender.call("sending", name)) d.busyPasteMs.push(ms);
            } else await delay(50);
          }
        };
        const [end] = await Promise.all([received, load()]);
        d.mibPerSecond.push(256 / ((end - start) / 1000));
        await receiver.call("verifyFile", { name, hash });
        await sender.call("clearSource", name);
      }
      await fs.writeFile(file, JSON.stringify(report, null, 2));
    }
  } finally { await Promise.allSettled([w.stop(), m.stop()]); }
}
try {
  for (const build of ["baseline", "candidate"]) await measure(build, config[build]);
  const candidate = report.builds.candidate;
  for (const samples of Object.values(candidate.discovery)) assert.ok(p95(samples) <= 5000, "discovery p95");
  for (const [dir, d] of Object.entries(candidate.directions)) {
    const median = x => x.toSorted((a, b) => a - b)[1];
    assert.ok(median(d.mibPerSecond) >= .8 * median(report.builds.baseline.directions[dir].mibPerSecond), dir + " throughput");
    if (mode === "--desktop") {
      assert.equal(d.pasteMs.length, 100, dir + " paste failures");
      assert.ok(p95(d.pasteMs) <= 1000, dir + " paste p95");
      assert.ok(d.busyPasteMs.length > 0 && p95(d.busyPasteMs) <= 2000, dir + " busy paste p95");
    }
  }
  report.status = "PASS";
} catch (e) { report.status = "FAIL"; report.errors.push(String(e)); throw e; }
finally { await fs.writeFile(file, JSON.stringify(report, null, 2)); console.log(file, report.status); }

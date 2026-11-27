import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const [configFile, mode] = process.argv.slice(2);
const lockOnly = mode === "--private-lock";
const order = lockOnly && !process.argv.includes("--compare-baseline") ? ["candidate"]
  : process.argv.includes("--candidate-first") ? ["candidate", "baseline"] : ["baseline", "candidate"];
const privateFiles = mode === "--private-files" || lockOnly;
assert.ok(configFile && (privateFiles || ["--files-only", "--desktop"].includes(mode)),
  "benchmark.mjs <local-config.json> --files-only|--desktop|--private-files|--private-lock");
const config = JSON.parse(await fs.readFile(configFile, "utf8"));
assert.match(config.macHost, /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
const run = randomUUID().slice(0, 8);
const file = path.resolve("artifacts/performance", "compare-" + run + ".json");
await fs.mkdir(path.dirname(file), { recursive: true });
const report = { run, mode, order, startedAt: new Date().toISOString(), status: "RUNNING", builds: {}, errors: [] };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const p95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
function worker(side, exe, name, build) {
  const workerMode = privateFiles ? "private-files" : mode.slice(2);
  const args = config.sessions && mode !== "--files-only"
    ? ["tests/benchmark-session.mjs", "connect", config.sessions[side], build, name, workerMode]
    : ["tests/benchmark-peer.mjs", exe, name, workerMode];
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
    async stop(success) {
      if (!ended) proc.stdin.end(JSON.stringify({ op: "exit", value: success }) + "\n");
      const code = await done;
      if (success) assert.equal(code, 0, side + " benchmark worker cleanup");
    },
  };
}
async function oneCopy(sender, receiver, label) {
  const start = performance.now();
  if (privateFiles) {
    try {
      await sender.call("copyFile", label);
      await receiver.call("pastedFile", label);
    } catch (error) {
      const diagnostics = await Promise.all([sender.call("fileStatus", label), receiver.call("fileStatus", label)]);
      throw Error(label + ": " + error.message + " " + JSON.stringify(diagnostics));
    }
  } else {
    await sender.call("copy", label);
    await receiver.call("paste", label);
  }
  return performance.now() - start;
}
async function measure(build, executables) {
  const w = worker("win", executables.win, "QA-" + run + "-W", build);
  const m = worker("mac", executables.mac, "QA-" + run + "-M", build);
  const stats = report.builds[build] = { discovery: { win: [], mac: [] }, directions: {} };
  let success = false;
  try {
    const builds = await Promise.all([w.call("info"), m.call("info")]);
    stats.hosts = builds.map(({ version, platform, arch, osRelease, product }) => ({ version, platform, arch, osRelease, product }));
    for (let i = 0; i < (privateFiles ? 1 : 20); i++) {
      const [wt, mt] = await Promise.all([w.call("discover", m.name), m.call("discover", w.name)]);
      stats.discovery.win.push(wt); stats.discovery.mac.push(mt);
      if ((i + 1) % 5 === 0) await fs.writeFile(file, JSON.stringify(report, null, 2));
    }
    console.log(build, "discovery p95 ms", p95(stats.discovery.win).toFixed(1), p95(stats.discovery.mac).toFixed(1));
    const [wi, mi] = await Promise.all([w.call("info"), m.call("info")]);
    await Promise.all([w.call("pair", mi), m.call("approve", wi.id)]);
    await Promise.all([w.call("ready", mi.id), m.call("ready", wi.id)]);
    const directions = [["win-to-mac", w, m], ["mac-to-win", m, w]];
    for (const [direction, sender, receiver] of privateFiles ? directions.reverse() : directions) {
      if (lockOnly) {
        const tag = run + "-" + direction;
        await sender.call("copyWhileLocked", tag);
        await oneCopy(sender, receiver, tag + "-fresh");
        const both = await Promise.all([sender.call("fileStatus", tag), receiver.call("fileStatus", tag)]);
        stats.directions[direction] = { peerOnline: both.every(s => s.peerOnline),
          senderJobs: both[0].jobs, receiverJobs: both[1].jobs,
          lockedCopySkipped: both.every(s => s.jobs.length === 0), freshCopyReceived: true };
        continue;
      }
      const d = stats.directions[direction] = { pasteMs: [], busyPasteMs: [], mibPerSecond: [], routes: [], timeouts: 0 };
      const idle = privateFiles ? (d.fileClipboardMs = []) : d.pasteMs;
      const busy = privateFiles ? (d.busyFileClipboardMs = []) : d.busyPasteMs;
      if (mode !== "--files-only") {
        for (let i = 0; i < 100; i++) {
          const text = (privateFiles ? "" : "한글 😀 ") + run + "-" + direction + "-" + i;
          try { idle.push(await oneCopy(sender, receiver, text)); }
          catch (e) {
            d.timeouts++; report.errors.push(build + "/" + direction + ": " + String(e));
            if (privateFiles) throw e;
          }
        }
        if (privateFiles) console.log(build, direction, "100 file copies, p95 ms", p95(idle).toFixed(1));
      }
      for (let i = 0; i < 3; i++) {
        const name = direction + "-" + i + ".bin";
        const hash = await sender.call("prepareFile", name);
        const [sourceBefore, targetBefore] = await Promise.all([sender.call("routes"), receiver.call("routes")]);
        const start = performance.now();
        await sender.call("sendFile", name);
        let finished = false;
        const received = receiver.call("received", name).then(() => performance.now()).finally(() => { finished = true; });
        const load = async () => {
          let n = 0;
          while (mode !== "--files-only" && !finished) {
            if (await sender.call("sending", name)) {
              const ms = await oneCopy(sender, receiver, run + "-" + name.replace(".bin", "") + "-load-" + n++);
              if (await sender.call("sending", name)) busy.push(ms);
            } else await delay(50);
          }
        };
        const [end] = await Promise.all([received, load()]);
        d.mibPerSecond.push(256 / ((end - start) / 1000));
        const [sourceAfter, targetAfter] = await Promise.all([sender.call("routes"), receiver.call("routes")]);
        const direct = sourceAfter.chunks - sourceBefore.chunks;
        const replies = targetAfter.replies - targetBefore.replies;
        const route = direct === 64 ? "direct" : direct === 0 && replies >= 64 ? "return" : "mixed-or-unknown";
        if (!privateFiles) d.routes.push({ route, directChunks: direct, returnReplies: replies });
        await receiver.call("verifyFile", { name, hash });
        await sender.call("clearSource", name);
      }
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log(build, direction, "MiB/s", d.mibPerSecond.map(n => n.toFixed(1)).join(", "));
    }
    if (privateFiles && !lockOnly) {
      await m.call("pauseMacProcess");
      stats.macProcessResumeCopyMs = await oneCopy(w, m, run + "-mac-resume");
      assert.deepEqual(await Promise.all([w.call("hidden"), m.call("hidden")]), [true, true]);
    }
    success = true;
  } finally {
    const closed = await Promise.allSettled([w.stop(success), m.stop(success)]);
    if (success) for (const result of closed) if (result.status === "rejected") throw result.reason;
  }
}
try {
  for (const build of order) await measure(build, config[build]);
  if (lockOnly) {
    for (const [build, stats] of Object.entries(report.builds)) {
      stats.lockStatus = "PASS";
      for (const [dir, result] of Object.entries(stats.directions)) {
        if (result.peerOnline && result.lockedCopySkipped && result.freshCopyReceived) continue;
        stats.lockStatus = "FAIL";
        report.errors.push(build + "/" + dir + " 잠금 중 복사 " + JSON.stringify(result));
      }
    }
    assert.ok(!report.errors.length, "잠금 시나리오 실패. 빌드별 송수신 기록을 확인하세요.");
  }
  const candidate = report.builds.candidate;
  if (mode === "--desktop")
    for (const [dir, d] of Object.entries(report.builds.baseline.directions))
      assert.equal(d.pasteMs.length, 100, "baseline " + dir + " paste failures");
  for (const samples of Object.values(candidate.discovery)) assert.ok(p95(samples) <= 5000, "discovery p95");
  for (const [dir, d] of Object.entries(candidate.directions)) {
    if (lockOnly) continue;
    const median = x => x.toSorted((a, b) => a - b)[1];
    if (privateFiles) {
      for (const stats of [report.builds.baseline.directions[dir], d]) {
        assert.equal(stats.fileClipboardMs.length, 100, dir + " file copies");
        assert.ok(stats.busyFileClipboardMs.length > 0, dir + " file copy overlapping a large transfer");
      }
      assert.ok(p95(d.fileClipboardMs) <= 5000, dir + " file clipboard p95");
      assert.ok(p95(d.busyFileClipboardMs) <= 8000, dir + " file clipboard p95 under load");
      continue;
    }
    const routes = new Set([...d.routes, ...report.builds.baseline.directions[dir].routes].map(r => r.route));
    assert.ok(routes.size === 1 && !routes.has("mixed-or-unknown"), dir + " requires matching transport paths");
    assert.ok(median(d.mibPerSecond) >= .8 * median(report.builds.baseline.directions[dir].mibPerSecond), dir + " throughput");
    if (mode === "--desktop") {
      assert.equal(d.pasteMs.length, 100, dir + " paste failures");
      assert.ok(p95(d.pasteMs) <= 1000, dir + " paste p95");
      assert.ok(d.busyPasteMs.length > 0 && p95(d.busyPasteMs) <= 2000, dir + " busy paste p95");
    }
  }
  report.status = "PASS";
} catch (e) { report.status = "FAIL"; report.errors.push(String(e)); throw e; }
finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(file, report.status);
}

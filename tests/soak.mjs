import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
const run = promisify(execFile);
const median = a => a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)];

async function sampleTree(root) {
  let processes;
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,HandleCount | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,HandleCount | ConvertTo-Json -Compress";
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    processes = JSON.parse(stdout).map(p => ({ id: p.ProcessId, parent: p.ParentProcessId,
      bytes: Number(p.WorkingSetSize), cpuMs: (Number(p.UserModeTime) + Number(p.KernelModeTime)) / 10000,
      handles: p.HandleCount }));
  } else {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,time="]);
    processes = stdout.trim().split("\n").map(row => {
      const [id, parent, kb, duration] = row.trim().split(/\s+/);
      const seconds = duration.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
      return { id: +id, parent: +parent, bytes: +kb * 1024, cpuMs: seconds * 1000 };
    });
  }
  const ids = new Set([root]);
  for (let count = 0; count !== ids.size;) {
    count = ids.size;
    for (const p of processes) if (ids.has(p.parent)) ids.add(p.id);
  }
  const tree = processes.filter(p => ids.has(p.id));
  assert.ok(tree.some(p => p.id === root), "app exited during sampling");
  return tree;
}

export async function soak(d, peer, receive, base, token) {
  const file = path.resolve("artifacts/performance", token + "-" + process.platform + ".json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const appState = await d.state();
  const report = { platform: process.platform, arch: process.arch, os: os.release(),
    appVersion: appState.version, product: appState.product, startedAt: new Date().toISOString(),
    run: token, status: "RUNNING", samples: [], sent: [], recoveryMs: null };
  const root = d.app.process().pid;
  await d.app.evaluate(({ BrowserWindow, app }) => {
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.qaResidentEvents = [];
    for (const event of ["show", "focus"])
      win.on(event, () => globalThis.qaResidentEvents.push(event));
    win.webContents.on("render-process-gone", (_e, details) => globalThis.qaResidentEvents.push(details.reason));
    app.on("child-process-gone", (_e, details) => {
      if (details.reason !== "clean-exit") globalThis.qaResidentEvents.push(details.reason);
    });
  });
  const send = async n => {
    const name = d.label + "-soak-" + n + ".txt";
    const f = path.join(base, name);
    await fs.writeFile(f, name);
    await d.call("drop", [f]);
    await d.call("send", peer.id);
    report.sent.push(name);
  };
  let previous = [], lastTime = 0, nextWork = 0, interrupted = false, restored = 0;
  const win = process.platform === "win32";
  const start = performance.now();
  try {
    for (let i = 0; i <= 240; i++) {
      await delay(Math.max(0, start + i * 5000 - performance.now()));
      const tree = await sampleTree(root);
      const time = performance.now() - start;
      const cpuMs = tree.reduce((n, p) => n + Math.max(0, p.cpuMs - (previous.find(old => old.id === p.id)?.cpuMs ?? p.cpuMs)), 0);
      const visible = await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible()));
      assert.equal(visible, false, "main window opened while resident");
      report.samples.push({ ms: Math.round(time), bytes: tree.reduce((n, p) => n + p.bytes, 0),
        cpu: i ? 100 * cpuMs / (time - lastTime) : null, count: tree.length,
        handles: win ? tree.reduce((n, p) => n + p.handles, 0) : null });
      previous = tree;
      lastTime = time;
      if (i >= 60 && i < 120 && i % 6 === 0) await send(nextWork++);
      if (i === 120 && win) {
        await d.call("settings", { adapter: "SyncVaultQA-disconnected" });
        const offline = performance.now();
        while ((await d.state()).local.address) {
          assert.ok(performance.now() - offline < 5000, "adapter disconnect timeout");
          await delay(100);
        }
        interrupted = true;
      }
      if (i === 124 && win && interrupted) {
        const began = performance.now();
        await d.call("settings", { adapter: "" });
        while (!(await d.state()).peers.some(p => p.id === peer.id && p.online)) {
          assert.ok(performance.now() - began < 15000, "peer recovery timeout");
          await delay(150);
        }
        await send(nextWork++);
        while (!(await d.state()).jobs.some(j => j.name === report.sent.at(-1) && j.state === "완료")) {
          assert.ok(performance.now() - began < 15000, "post-reconnect transfer timeout");
          await delay(150);
        }
        report.recoveryMs = Math.round(performance.now() - began);
        restored = report.recoveryMs;
      }
      if (i >= 132 && i < 180 && i % 6 === 0) await send(nextWork++);
      if (i % 12 === 0) await fs.writeFile(file, JSON.stringify(report));
    }
    const state = await d.state();
    report.events = await d.app.evaluate(() => globalThis.qaResidentEvents);
    assert.deepEqual(report.events, [], "unrequested window show, focus, or crash");
    for (const name of report.sent) assert.ok(state.jobs.some(j => j.name === name && j.state === "완료"));
    const expected = win ? 18 : 19;
    for (let i = 0; i < expected; i++) {
      const name = peer.name + "-soak-" + i + ".txt";
      assert.equal(await fs.readFile(path.join(receive, name), "utf8"), name);
    }
    const samples = report.samples;
    const initial = samples.slice(48, 60), final = samples.slice(228, 240);
    const idle = [...samples.slice(1, 60), ...samples.slice(181, 241)];
    report.memoryGrowthMiB = (median(final.map(s => s.bytes)) - median(initial.map(s => s.bytes))) / 1048576;
    report.idleCpu = idle.reduce((n, s) => n + s.cpu, 0) / idle.length;
    assert.ok(!win || restored > 0 && restored <= 15000);
    assert.ok(report.memoryGrowthMiB <= 32, "resident memory growth: " + report.memoryGrowthMiB);
    assert.ok(report.idleCpu <= 2, "idle CPU: " + report.idleCpu);
    report.status = "PASS";
  } catch (e) {
    report.status = "FAIL";
    report.error = String(e);
    throw e;
  } finally {
    await fs.writeFile(file, JSON.stringify(report, null, 2));
  }
}

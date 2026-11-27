import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function sampleTree(root) {
  let processes;
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,HandleCount | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,HandleCount | ConvertTo-Json -Compress";
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
    );
    processes = JSON.parse(stdout).map((p) => ({
      id: p.ProcessId,
      parent: p.ParentProcessId,
      bytes: Number(p.WorkingSetSize),
      cpuMs: (Number(p.UserModeTime) + Number(p.KernelModeTime)) / 10000,
      handles: p.HandleCount,
    }));
  } else {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,time="]);
    processes = stdout
      .trim()
      .split("\n")
      .map((row) => {
        const [id, parent, kb, duration] = row.trim().split(/\s+/);
        const seconds = duration
          .split(":")
          .reduce((acc, part) => acc * 60 + Number(part), 0);
        return {
          id: +id,
          parent: +parent,
          bytes: +kb * 1024,
          cpuMs: seconds * 1000,
        };
      });
  }
  const ids = new Set([root]);
  for (let count = 0; count !== ids.size;) {
    count = ids.size;
    for (const p of processes) if (ids.has(p.parent)) ids.add(p.id);
  }
  const tree = processes.filter((p) => ids.has(p.id));
  assert.ok(
    tree.some((p) => p.id === root),
    "app exited during sampling",
  );
  return tree;
}

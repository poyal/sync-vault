// Keep editor and clipboard operations inside a dedicated, logged-in QA desktop.
// Only the local controller's benchmark protocol crosses the socket.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [action, configFile, build, label, mode] = process.argv.slice(2);
const config = JSON.parse(await fs.readFile(configFile, "utf8"));
const sessionMode = config.mode ?? "desktop";
assert.ok(["private-files", "desktop"].includes(sessionMode));
assert.match(config.token, /^[a-f0-9]{64}$/);
assert.ok(process.platform === "win32" ? config.endpoint.startsWith("\\\\.\\pipe\\SyncVaultQA-") : path.isAbsolute(config.endpoint));
function validate(job) {
  assert.ok(["baseline", "candidate"].includes(job.build));
  assert.match(job.label, process.platform === "win32" ? /^QA-[a-f0-9]{8}-W$/ : /^QA-[a-f0-9]{8}-M$/);
  assert.equal(job.mode, sessionMode);
}
if (action === "connect") {
  validate({ build, label, mode });
  const deadline = Date.now() + 10000;
  for (;;) {
    const socket = net.createConnection({ path: config.endpoint, allowHalfOpen: true });
    await once(socket, "connect");
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    socket.write(JSON.stringify({ build, label, mode, token: config.token }) + "\n");
    const { value: status } = await lines.next();
    if (status === "SVQA-SESSION busy" && Date.now() < deadline) {
      socket.destroy();
      await delay(100);
      continue;
    }
    assert.equal(status, "SVQA-SESSION ready", "QA 호스트가 빌드를 시작하지 못했습니다.");
    // Windows named pipes close both directions on EOF. Send the explicit exit
    // command and keep the return path open until the peer reports its status.
    const input = createInterface({ input: process.stdin });
    let sentExit = false;
    input.on("line", line => {
      if (sentExit) return;
      sentExit = JSON.parse(line).op === "exit";
      socket.write(line + "\n");
    });
    input.on("close", () => {
      if (!sentExit && socket.writable) socket.write('{"op":"exit","value":false}\n');
    });
    let exitCode;
    for await (const line of lines) {
      if (line.startsWith("SVQA-SESSION exit ")) exitCode = Number(line.slice("SVQA-SESSION exit ".length));
      else console.log(line);
    }
    sentExit = true;
    input.close();
    socket.destroy();
    assert.ok(Number.isInteger(exitCode), "QA 호스트 연결이 시험 도중 종료됐습니다.");
    process.exitCode = exitCode;
    break;
  }
} else if (action === "host") {
  const actual = os.userInfo();
  assert.equal(actual.username.toLowerCase(), config.qaUser.toLowerCase(), "전용 QA 계정에서 실행하세요.");
  if (sessionMode === "desktop") {
    if (process.platform === "darwin") {
      assert.equal((await fs.stat("/dev/console")).uid, actual.uid, "QA 콘솔 로그인이 필요합니다.");
    } else {
      const check = `Add-Type -Namespace VaultQA -Name Session -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();'
if ((Get-Process -Id $PID).SessionId -ne [VaultQA.Session]::WTSGetActiveConsoleSessionId() -or ![Environment]::UserInteractive) { exit 1 }`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { windowsHide: true });
    }
  }
  let active;
  const completed = new Set();
  let idleTimer;
  const expire = () => { idleTimer = setTimeout(() => server.close(), 120000); };
  const server = net.createServer({ allowHalfOpen: true }, async socket => {
    if (active) { socket.end("SVQA-SESSION busy\n"); return; }
    active = socket;
    clearTimeout(idleTimer);
    socket.setTimeout(10000, () => socket.destroy());
    const release = () => {
      if (active !== socket) return;
      active = undefined;
      if (completed.size === 2) server.close();
      else expire();
    };
    let peer, ended;
    const lines = createInterface({ input: socket });
    try {
      for await (const line of lines) {
        if (!peer) {
          const job = JSON.parse(line);
          if (typeof job.token !== "string" || !/^[a-f0-9]{64}$/.test(job.token) ||
              !timingSafeEqual(Buffer.from(job.token), Buffer.from(config.token))) throw Error("QA 세션 인증 실패");
          validate(job);
          const exe = config[job.build];
          assert.ok(path.isAbsolute(exe) && !completed.has(job.build));
          socket.setTimeout(220000);
          peer = spawn(process.execPath, ["tests/benchmark-peer.mjs", exe, job.label, sessionMode], { windowsHide: true });
          socket.write("SVQA-SESSION ready\n");
          peer.stdout.pipe(socket, { end: false });
          peer.stderr.pipe(process.stderr);
          peer.stdin.on("error", () => socket.end());
          ended = once(peer, "close").then(([code]) => {
            if (code === 0) completed.add(job.build);
            release();
            socket.end("SVQA-SESSION exit " + (code ?? 1) + "\n");
          });
        } else {
          if (JSON.parse(line).op === "exit") {
            peer.stdin.end(line + "\n");
            break;
          }
          peer.stdin.write(line + "\n");
        }
      }
    } catch (error) {
      console.error(error.message);
    } finally {
      peer?.stdin.end();
      try { await ended; } finally {
        release();
        socket.end();
      }
    }
  });
  server.listen(config.endpoint);
  await once(server, "listening");
  if (process.platform === "darwin") await fs.chmod(config.endpoint, 0o660);
  expire();
  console.log("READY", process.platform, sessionMode);
} else {
  throw Error("benchmark-session.mjs host <로컬설정> | connect <로컬설정> <build> <label>");
}

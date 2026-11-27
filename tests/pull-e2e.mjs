import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const dest = process.env.SYNC_VAULT_QA_REPORT,
  host = process.env.SYNC_VAULT_MAC_HOST;
const physical = !!host,
  results = { physical, checks: [], timings: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description, ms = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw Error(description + " 시간 초과");
}
function peer(remote = false) {
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const env = { ...process.env, SYNC_VAULT_QA_PHYSICAL: physical ? "1" : "0" };
  const args = remote
    ? [
        "-o",
        "BatchMode=yes",
        host,
        "cd " +
          quote(env.SYNC_VAULT_MAC_DIR) +
          " && SYNC_VAULT_QA_PHYSICAL=1 SYNC_VAULT_QA_EXE=" +
          quote(env.SYNC_VAULT_MAC_EXE) +
          " " +
          quote(env.SYNC_VAULT_MAC_NODE) +
          " tests/pull-peer.mjs",
      ]
    : ["tests/pull-peer.mjs"];
  const child = spawn(remote ? "ssh" : process.execPath, args, {
    env,
    windowsHide: true,
  });
  child.stderr.on("data", (c) => process.stderr.write(c));
  const jobs = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on("line", (s) => {
    if (!s.startsWith("{")) return;
    const m = JSON.parse(s),
      j = jobs.get(m.id);
    if (j) {
      jobs.delete(m.id);
      clearTimeout(j.timer);
      m.error ? j.reject(Error(m.error)) : j.resolve(m.val);
    }
  });
  const done = new Promise((resolve) =>
    child.on("close", (code) => {
      for (const j of jobs.values()) {
        clearTimeout(j.timer);
        j.reject(Error("시험 프로세스 종료 " + code));
      }
      jobs.clear();
      resolve(code);
    }),
  );
  const call = (op, args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      jobs.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          jobs.delete(id);
          reject(Error("시험 요청 시간 초과 " + op));
        }, 90000),
      });
      child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
    });
  return {
    call,
    ipc: (a, v) => call("ipc", { a, v }),
    async stop() {
      child.stdin.end('{"op":"stop"}\n');
      assert.equal(await done, 0);
    },
  };
}
const A = peer(),
  B = peer(physical);
const capture = async (d, id, selector) => {
  if (dest)
    await fs.writeFile(
      path.join(dest, id + ".png"),
      Buffer.from(await d.call("shot", { selector }), "base64"),
    );
};
const check = (s) => {
  results.checks.push(s);
  console.log("PASS", s);
};
const clipboard = async (d, local, content) => {
  await d.call("write", content);
  return until(
    async () =>
      (await d.ipc("vault-history", { peer: local })).find((r) =>
        content.png ? r.kind === "image" : r.preview === content.text,
      ),
    "클립보드 수집",
  );
};
async function pair(a, b, me, other) {
  await Promise.all([
    a.call("nav", { p: "devices" }),
    b.call("nav", { p: "devices" }),
  ]);
  const start = () =>
    a.ipc("pair", { address: other.address, port: other.port });
  const pending = () =>
    until(
      async () => (await b.call("state")).pending.find((q) => q.id === me.id),
      "등록 요청",
    );
  await start();
  let p = await pending();
  await b.ipc("deny", { id: p.id, attempt: p.attempt });
  await until(async () => !(await a.call("state")).outbound, "거절 반영");
  await start();
  p = await pending();
  await a.ipc("pair-cancel", p.attempt);
  await until(
    async () =>
      !(await b.call("state")).pending.length &&
      !(await a.call("state")).outbound,
    "취소 반영",
  );
  await start();
  const req = await pending(),
    out = (await a.call("state")).outbound;
  assert.equal(out.code, req.code);
  assert.notEqual(req.code, p.code);
  await Promise.all([a.ipc("dismiss"), b.ipc("dismiss")]);
  await Promise.all([
    a.call("waitText", { selector: "#outbound", text: out.code }),
    b.call("waitText", { selector: "#pending", text: req.code }),
  ]);
  await capture(a, "pair-a");
  await capture(b, "pair-b");
  await b.call("click", {
    selector:
      '#pending [data-action="approve"][data-attempt="' + req.attempt + '"]',
  });
  assert.equal((await b.call("state")).peers.length, 0);
  await a.call("click", {
    selector:
      '#outbound [data-action="pair-confirm"][data-value="' +
      req.attempt +
      '"]',
  });
  await until(
    async () =>
      (await a.call("state")).peers.some((p) => p.online && p.compatible) &&
      (await b.call("state")).peers.some((p) => p.online && p.compatible),
    "연결",
  );
  check("등록 거절·취소, 시도별 코드 일치, 양쪽 확인 후 등록");
}
async function transfer(from, to, origin, name, text, dir = false) {
  await from.call("fixture", { name, text, dir });
  await to.call("room", { peer: origin, tab: "folder" });
  await to.call("row", { name, action: "get-item" });
  await until(
    async () => {
      const j = (await to.call("state")).jobs.find((j) => j.name === name);
      if (j?.state === "오류") throw Error(j.error);
      return j?.state === "완료";
    },
    "파일 수신",
    60000,
  );
  return to.call("received", { name: dir ? name + "/요약.txt" : name, text });
}
async function measure(d, peer, folderId, key) {
  const samples = [];
  for (let n = 0; n < 20; n++) {
    const t = performance.now();
    const r = await d.ipc(folderId ? "vault-list" : "vault-history", {
      peer,
      id: folderId || "",
      offset: 0,
    });
    samples.push(performance.now() - t);
    assert.equal(folderId ? r.rows.length : r.length, folderId ? 60 : 10);
  }
  (results.samplesMs ??= {})[key] = samples;
  const sorted = samples.toSorted((a, b) => a - b);
  results.timings[key] = Math.round(sorted[18]);
  assert.ok(sorted[18] <= 1000, key + " p95 " + sorted[18]);
}
try {
  if (dest) await fs.mkdir(dest, { recursive: true });
  const [a, b] = await Promise.all([
    A.call("init", { label: "작업실 PC" }),
    B.call("init", { label: physical ? "스튜디오 Mac" : "편집 PC" }),
  ]);
  results.platforms = [a.os, b.os];
  assert.equal(a.version, b.version);
  results.version = a.version;
  await pair(A, B, a, b);
  await A.call("nav", { p: "home" });
  await A.call("waitText", {
    selector: "#peer-cards .device-card",
    text: "온라인",
  });
  await capture(A, "home-win");
  await B.call("nav", { p: "home" });
  await B.call("waitText", {
    selector: "#peer-cards .device-card",
    text: "온라인",
  });
  await capture(B, "home-other");
  if (process.argv.includes("--large")) {
    const reverse = process.argv.includes("--reverse");
    const [source, receiver, sourceID] = reverse ? [B, A, b.id] : [A, B, a.id];
    const name = "대용량-검증.bin",
      bytes = 5 * 1024 ** 3;
    await source.call("large", { name, size: bytes });
    const item = (
      await receiver.ipc("vault-list", { peer: sourceID })
    ).rows.find((r) => r.name === name);
    const id = await receiver.ipc("vault-get", {
      peer: sourceID,
      id: item.id,
      name,
    });
    const progress = () =>
      receiver.call("state").then((s) => {
        const j = s.jobs.find((j) => j.id === id);
        if (j?.state === "오류") throw Error(j.error);
        return j;
      });
    const half = await until(
      async () => {
        const j = await progress();
        return j.done >= bytes / 2 && j;
      },
      "2.5 GiB",
      600000,
    );
    await source.call("restart");
    await until(
      async () => (await progress()).state === "완료",
      "5 GiB 복구",
      600000,
    );
    const [original, copied] = await Promise.all([
      source.call("hash", { name, source: true }),
      receiver.call("hash", { name }),
    ]);
    assert.equal(original, copied);
    results.large = {
      bytes,
      interruptedAt: half.done,
      sha256: copied,
      sourceOS: reverse ? b.os : a.os,
      receiverOS: reverse ? a.os : b.os,
    };
    check("5 GiB 앱 전송 중 원본 재시작·이어받기·해시 일치");
  } else if (process.argv.includes("--soak")) {
    await Promise.all([A.call("hide"), B.call("hide")]);
    const samples = [],
      start = Date.now();
    results.soak = samples;
    for (let n = 0; n <= 240; n++) {
      await sleep(Math.max(0, start + n * 5000 - Date.now()));
      const metrics = await Promise.all([A.call("metrics"), B.call("metrics")]);
      assert.ok(metrics.every((v) => !v.visible));
      samples.push({ ms: Date.now() - start, metrics });
      if (n % 12 === 0 && dest) {
        await fs.writeFile(
          path.join(dest, "resident-progress.json"),
          JSON.stringify(results),
        );
        if (n % 60 === 0) console.log("숨김 상주 측정", n / 12, "/ 20분");
      }
    }
    for (const i of [0, 1]) {
      const memory = (g) =>
        g.map((v) => v.metrics[i].memory).toSorted((a, b) => a - b)[6];
      const diff = memory(samples.slice(-13)) - memory(samples.slice(0, 13));
      const cpuMs = samples.slice(1).reduce(
        (sum, sample, n) =>
          sum +
          sample.metrics[i].tree.reduce((delta, p) => {
            const previous = samples[n].metrics[i].tree.find(
              (q) => q.id === p.id,
            );
            return (
              delta + (previous ? Math.max(0, p.cpuMs - previous.cpuMs) : 0)
            );
          }, 0),
        0,
      );
      const cpu = (100 * cpuMs) / (samples.at(-1).ms - samples[0].ms);
      (results.resident ??= []).push({
        cpuPercent: cpu,
        memoryDeltaMiB: diff / 1048576,
        samples: samples.length,
      });
    }
    if (dest)
      await fs.writeFile(
        path.join(dest, "resident-progress.json"),
        JSON.stringify(results),
      );
    for (const metric of results.resident)
      assert.ok(
        metric.memoryDeltaMiB <= 32 && metric.cpuPercent <= 2,
        JSON.stringify(metric),
      );
    check("20분 숨김 상주, 평균 CPU와 메모리 변화 기준");
  } else {
    await A.ipc("settings", { historyLimit: 20 });
    await B.ipc("settings", { historyLimit: 5 });
    for (let i = 1; i <= 11; i++)
      await clipboard(A, a.id, { text: "작업 메모 " + i });
    for (let i = 1; i <= 6; i++)
      await clipboard(B, b.id, { text: "교정 메모 " + i });
    const text = "금요일 오후에 원고 검토 😀";
    const rich = await clipboard(A, a.id, {
      text,
      html: "<b>" + text + "</b>",
    });
    const baseline = await B.call("read");
    await B.call("room", { peer: a.id, tab: "history" });
    await capture(B, "history");
    assert.deepEqual(await B.call("read"), baseline);
    await B.call("row", { name: text, action: "copy-item" });
    await until(async () => (await B.call("read")).text === text, "붙여넣기");
    assert.match((await B.call("read")).html, /<b>/);
    if (b.os === "darwin") {
      const pasted = await B.call("editor");
      assert.ok(pasted.text.includes(text) && pasted.bold);
      check("Mac 네이티브 편집 뷰에 서식·이모지 붙여넣기");
    }
    assert.equal((await B.ipc("vault-history", { peer: b.id })).length, 5);
    const png = (await fs.readFile("out/icon.png")).toString("base64");
    const pic = await clipboard(B, b.id, { png });
    await A.call("room", { peer: b.id, tab: "history" });
    await A.call("waitText", {
      selector: "#room-items article",
      text: "PNG 이미지",
    });
    await capture(A, "image");
    await A.ipc("vault-copy", { peer: b.id, id: pic.id });
    assert.equal((await A.call("read")).png, png);
    assert.equal(
      (await A.ipc("vault-history", { peer: a.id })).filter(
        (c) => c.kind === "image",
      ).length,
      0,
    );
    await A.ipc("settings", { historyLimit: 10 });
    assert.equal((await A.ipc("vault-history", { peer: a.id })).length, 10);
    await A.call("restart");
    await until(
      async () => (await A.call("state")).peers.some((p) => p.online),
      "재시작 후 연결",
    );
    assert.equal((await A.ipc("vault-history", { peer: a.id }))[0].id, rich.id);
    check(
      "기기별 보관 수·암호화 기록 재시작·한글/서식/PNG·목록 탐색과 순환 방지",
    );
    await A.call("fixture", { name: "견적서.txt", text: "11월 견적" });
    await A.call("fileClipboard", { name: "견적서.txt" });
    await sleep(500);
    assert.equal((await A.ipc("vault-history", { peer: a.id }))[0].id, rich.id);
    await A.call("fixture", { name: "편집 원고", dir: true, text: "초안" });
    await A.call("hide");
    await B.call("room", { peer: a.id, tab: "folder" });
    await until(
      async () => (await B.ipc("vault-list", { peer: a.id })).rows.length >= 2,
      "폴더",
    );
    await capture(B, "folder");
    await B.call("row", { name: "편집 원고", action: "dir" });
    await B.call("waitText", {
      selector: "#room-items article",
      text: "요약.txt",
    });
    await capture(B, "subfolder");
    await transfer(A, B, a.id, "최종 원고", "하위 폴더 메모", true);
    assert.equal(await A.call("visible"), false);
    await A.call("show");
    await B.call("hide");
    await transfer(B, A, b.id, "답신.txt", "수신했습니다.");
    assert.equal(await B.call("visible"), false);
    await capture(A, "jobs");
    await B.call("show");
    check("두 방향 숨김 전송, 빈 폴더·하위 파일, 복사한 파일 기록 제외");
    await B.call("missing", { on: true });
    const rows = await B.ipc("vault-list", { peer: a.id });
    const item = rows.rows.find((f) => f.name === "견적서.txt");
    const jid = await B.ipc("vault-get", {
      peer: a.id,
      id: item.id,
      name: item.name,
    });
    await until(
      async () =>
        (await B.call("state")).jobs.find((j) => j.id === jid)?.state ===
        "오류",
      "오류",
    );
    await B.call("nav", { p: "transfers" });
    await B.call("waitText", {
      selector: "#jobs article",
      text: "받을 폴더를 사용할 수 없습니다",
    });
    await capture(B, "error");
    await B.call("missing", { on: false });
    await B.ipc("job", { id: jid, op: "retry" });
    await until(
      async () =>
        (await B.call("state")).jobs.find((j) => j.id === jid)?.state ===
        "완료",
      "재시도",
    );
    await B.call("received", { name: item.name, text: "11월 견적" });
    check("수신 폴더 단절·오류 사유·재시도 후 원본 일치");
    const duplicate = await B.ipc("vault-get", {
      peer: a.id,
      id: item.id,
      name: item.name,
    });
    await until(
      async () =>
        (await B.call("state")).jobs.find((j) => j.id === duplicate)?.state ===
        "완료",
      "중복 이름",
    );
    await B.call("received", { name: "견적서 (1).txt", text: "11월 견적" });
    await A.call("fixture", { name: "견적서.txt", text: "새 내용으로 변경" });
    const stale = await B.ipc("vault-get", {
      peer: a.id,
      id: item.id,
      name: item.name,
    });
    await until(
      async () =>
        (await B.call("state")).jobs.find((j) => j.id === stale)?.state ===
        "오류",
      "변경된 원본 차단",
    );
    check("중복 파일 보존·변경된 원본 선택 차단");
    if (b.os === "darwin") {
      const name = "공간 시험.bin";
      await A.call("large", { name, size: 8 * 1024 ** 2 });
      await B.call("disk", { op: "mount" });
      const file = (await B.ipc("vault-list", { peer: a.id })).rows.find(
        (r) => r.name === name,
      );
      const id = await B.ipc("vault-get", { peer: a.id, id: file.id, name });
      await until(
        async () =>
          (await B.call("state")).jobs.find((j) => j.id === id)?.state ===
          "오류",
        "디스크 부족",
      );
      await B.call("disk", { op: "free" });
      await B.ipc("job", { id, op: "retry" });
      await until(
        async () =>
          (await B.call("state")).jobs.find((j) => j.id === id)?.state ===
          "완료",
        "디스크 복구",
      );
      const copied = await B.call("disk", { op: "check" });
      assert.equal(copied, await A.call("hash", { source: true, name }));
      check("Mac HFS+ 한글 수신 폴더에서 공간 부족·확보 후 이어받기 및 SHA-256 일치");
    }
    await B.call("room", { peer: a.id, tab: "history" });
    await A.call("lock", { on: true });
    await until(
      async () =>
        (await B.call("state")).peers.find((p) => p.id === a.id)?.locked,
      "원격 잠금",
    );
    for (const action of ["vault-list", "vault-history", "vault-copy"])
      await assert.rejects(B.ipc(action, { peer: a.id, id: rich.id }));
    await B.call("waitText", { selector: "#room-items .empty", text: "잠김" });
    await capture(B, "lock");
    await A.call("lock", { on: false });
    await until(
      async () =>
        !(await B.call("state")).peers.find((p) => p.id === a.id)?.locked,
      "해제 반영",
    );
    await B.call("lock", { on: true });
    await until(
      async () =>
        (await A.call("state")).peers.find((p) => p.id === b.id)?.locked,
      "반대 방향 잠금",
    );
    for (const [reader, id] of [
      [A, b.id],
      [B, a.id],
      [B, b.id],
    ]) {
      for (const action of ["vault-list", "vault-history", "vault-copy"]) {
        await assert.rejects(
          reader.ipc(action, { peer: id, id: rich.id }),
          /잠겼습니다/,
        );
      }
    }
    await B.call("lock", { on: false });
    await until(
      async () =>
        !(await A.call("state")).peers.find((p) => p.id === b.id)?.locked,
      "반대 방향 해제",
    );
    await B.ipc("vault-history", { peer: a.id });
    await A.ipc("vault-list", { peer: b.id });
    check("양쪽 운영체제 잠금 이벤트에서 로컬·원격의 두 탭 차단·해제");
    await A.call("fixture", { name: "목록 속도 시험", dir: true, count: 1000 });
    const folder = (await B.ipc("vault-list", { peer: a.id })).rows.find(
      (v) => v.name === "목록 속도 시험",
    );
    await measure(B, a.id, null, "historyP95");
    await measure(B, a.id, folder.id, "folderP95");
    await B.ipc("settings", { historyLimit: 10 });
    for (let n = 0; n < 10; n++)
      await clipboard(B, b.id, { text: "검토 " + n });
    await B.call("fixture", { name: "속도 표본", dir: true, count: 1000 });
    const other = (await A.ipc("vault-list", { peer: b.id })).rows.find(
      (v) => v.name === "속도 표본",
    );
    await measure(A, b.id, null, "reverseHistoryP95");
    await measure(A, b.id, other.id, "reverseFolderP95");
    check("양방향 최근 10건·1,000개 파일 첫 페이지 각 20회 p95 ≤ 1초");
    await A.call("nav", { p: "settings" });
    await capture(A, "settings");
    await A.ipc("history-delete", rich.id);
    await assert.rejects(B.ipc("vault-copy", { peer: a.id, id: rich.id }));
    await A.ipc("history-clear");
    assert.deepEqual(await A.ipc("vault-history", { peer: a.id }), []);
    await A.ipc("forget", b.id);
    await assert.rejects(B.ipc("vault-list", { peer: a.id }));
    check("기록 삭제·비우기·등록 해제 후 접근 차단");
  }
  if (dest)
    await fs.writeFile(
      path.join(dest, "results.json"),
      JSON.stringify(results, null, 2),
    );
  console.log(JSON.stringify(results.timings));
} finally {
  await Promise.all([A.stop(), B.stop()]);
}

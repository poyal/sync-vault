import { History } from "../src/history";
import { Shelf } from "../src/shelf";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID, sign, createHash } from "node:crypto";
import { createIdentity, fingerprint } from "../src/identity";
import { Store, writable } from "../src/store";
import { ShareListener, shareRequest, json, readJSON } from "../src/network";
import { Lan, compatible, binary } from "../src/lan";
import {
  Receiver,
  createJob,
  inventory,
  transmit,
  chunkSize,
  digest,
  validateOffer,
} from "../src/files";
import { Updater, compare, verifyManifest, showUpdatedWindow } from "../src/update";
import { latestRelease } from "../src/github-release";
import { checkedPng, cleanHTML } from "../src/content";
import { newer } from "../src/types";
import { ReturnChannel, ReturnChannelInterrupted } from "../src/return-channel";
const tmp = async (t: any) => {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "sv-qa-"));
  t.after(() => fs.rm(p, { recursive: true, force: true }));
  return p;
};
test("a TLS protocol error retries once before the handshake, with the same authenticated peer and no POST replay", async (t) => {
  const client = await createIdentity(),
    server = await createIdentity();
  let delivered = 0;
  const listener = new ShareListener(
    server,
    [client.cert],
    false,
    async (req, res) => {
      assert.deepEqual(await readJSON(req), { file: "QA" });
      json(res, { delivered: ++delivered });
    },
  );
  const endpoint = await listener.listen("127.0.0.1");
  t.after(() => listener.close());
  const original = https.request;
  const request = () =>
    shareRequest(
      client,
      endpoint,
      server.cert,
      "/qa",
      Buffer.from('{"file":"QA"}'),
    );
  let calls = 0,
    failures = 1,
    connected = false,
    code = "EPROTO";
  t.mock.method(https, "request", (options, callback) => {
    calls++;
    assert.ok(options.rejectUnauthorized && options.minVersion === "TLSv1.3");
    assert.deepEqual(options.ca, [server.cert]);
    if (!failures--) return original(options, callback);
    const req = Object.assign(new EventEmitter(), {
      setTimeout() {},
      end() {
        const socket = new EventEmitter();
        req.emit("socket", socket);
        if (connected) socket.emit("secureConnect");
        req.emit(
          "error",
          Object.assign(
            new Error(code === "EPROTO" ? "UNSUPPORTED_PROTOCOL" : code),
            { code },
          ),
        );
        req.emit("close");
      },
    });
    return req;
  });
  assert.deepEqual(await request(), { delivered: 1 });
  assert.equal(calls, 2);
  for (const [afterHandshake, errorCode, expected] of [
    [false, "EPROTO", 2],
    [true, "EPROTO", 1],
    [false, "CERT_HAS_EXPIRED", 1],
  ] as const) {
    connected = afterHandshake;
    code = errorCode;
    failures = 2;
    calls = 0;
    await assert.rejects(request(), { code });
    assert.equal(calls, expected);
  }
  assert.equal(delivered, 1);
});
test("return-channel timeouts and disconnects are distinct from a rejected peer request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const channel = new ReturnChannel();
  const send = () => channel.request("peer", "/vault/part", {}, new AbortController().signal);
  const undelivered = send();
  t.mock.timers.tick(8000);
  await assert.rejects(undelivered, ReturnChannelInterrupted);
  const disconnected = send();
  channel.forget("peer");
  await assert.rejects(disconnected, ReturnChannelInterrupted);
  const rejected = send();
  const { request } = await channel.poll("peer");
  channel.reply("peer", { token: request!.token, ok: false });
  await assert.rejects(rejected, (error: Error) =>
    error instanceof Error && !(error instanceof ReturnChannelInterrupted));
});
test("state survives restart, corruption uses the last complete backup", async (t) => {
  const root = await tmp(t);
  const a = new Store(root, root);
  a.save();
  a.state.settings.name = "QA";
  a.save();
  assert.equal(new Store(root, root).state.settings.name, "QA");
  await fs.writeFile(a.file, "{");
  assert.notEqual(new Store(root, root).state.settings.name, "QA");
  assert.throws(() => writable("relative"));
});
test("only safe portable file trees accepted; basic formatting and alpha image validation", () => {
  const id = randomUUID();
  const f = (name: string, dir = false) => ({
    name,
    dir,
    size: 0,
    hash: dir ? "" : "0".repeat(64),
  });
  assert.throws(() => validateOffer({ id, entries: [f("../x")] }));
  assert.throws(() => validateOffer({ id, entries: [f("a"), f("A")] }));
  assert.throws(() => validateOffer({ id, entries: [f("missing/y")] }));
  assert.throws(() => validateOffer({ id, entries: [f("NUL.txt")] }));
  assert.equal(
    cleanHTML('<table onclick="x"><tr><td>한글😀</td></tr></table>'),
    "<table><tr><td>한글😀</td></tr></table>",
  );
  assert.throws(() => checkedPng(Buffer.alloc(20)));
  assert.ok(newer({ clock: 2, origin: "a" }, { clock: 1, origin: "z" }));
  for (let versions = 0; versions < 8; versions++) {
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++)
        if (a !== b) {
          const old = ["text", "files"],
            latest = ["text", "files", "html"];
          const A = (versions >> a) & 1 ? latest : old,
            B = (versions >> b) & 1 ? latest : old;
          assert.ok(
            compatible(1, B)
              .filter((f) => A.includes(f))
              .includes("files"),
          );
        }
  }
  assert.deepEqual(compatible(2, ["files"]), []);
});
test("portable offers accept 7,999 and 8,000 entries and reject excess or normalized name collisions", () => {
  const entry = (name: string) => ({
    name,
    dir: false,
    size: 0,
    hash: "0".repeat(64),
  });
  const entries = Array.from({ length: 8001 }, (_, i) => entry(String(i)));
  const id = randomUUID();
  for (const n of [7999, 8000])
    assert.equal(
      validateOffer({ id, entries: entries.slice(0, n) }).entries.length,
      n,
    );
  assert.throws(() => validateOffer({ id, entries }));
  assert.throws(() =>
    validateOffer({ id, entries: [entry("é"), entry("e\u0301")] }),
  );
});
test("automatic file receipt enforces exact 32 MiB and 100-file boundaries before creating a job", async (t) => {
  const root = await tmp(t),
    store = new Store(root, root);
  const rx = new Receiver(
    store,
    async () => {},
    () => true,
  );
  const peer = "a".repeat(64);
  const offer = (count: number, bytes: number) => ({
    id: randomUUID(),
    stamp: { origin: peer, clock: 1 },
    entries: Array.from({ length: count }, (_, i) => ({
      name: i + ".dat",
      size: i === 0 ? bytes : 0,
      dir: false,
      hash: "0".repeat(64),
    })),
  });
  const limit = 32 * 1024 ** 2;
  for (const args of [
    [99, limit - 1],
    [100, limit],
  ]) {
    const f = offer(args[0], args[1]);
    assert.equal((await rx.offer(peer, f)).status, "ready");
    await rx.cancel(peer, f.id);
  }
  const count = store.state.incoming.length;
  await assert.rejects(rx.offer(peer, offer(101, 1)), /범위/);
  await assert.rejects(rx.offer(peer, offer(1, limit + 1)), /범위/);
  assert.equal(store.state.incoming.length, count);
});
test("older profiles discard the distribution folder and preserve preferences", async (t) => {
  const home = await tmp(t);
  const profile = new Store(home, home);
  assert.equal(profile.state.settings.updateCheckIntervalHours, 1);
  profile.state.settings.name = "기존 기기";
  profile.save();
  const file = path.join(home, "state.json");
  const legacy = JSON.parse(await fs.readFile(file, "utf8"));
  delete legacy.settings.updateCheckIntervalHours;
  legacy.settings.updates = false;
  legacy.settings.releaseFolder = "old-feed";
  await fs.writeFile(file, JSON.stringify(legacy));
  const migrated = new Store(home, home);
  assert.equal(migrated.state.settings.name, "기존 기기");
  assert.equal(migrated.state.settings.updateCheckIntervalHours, 24);
  assert.equal(migrated.state.settings.updates, false);
  assert.equal(Object.hasOwn(migrated.state.settings, "releaseFolder"), false);
});

test("GitHub stable updates verify the tag, signature, OS, size and downloaded bytes", async (t) => {
  const home = await tmp(t);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const platform = process.platform + "-" + process.arch;
  const scoped = "update-" + platform;
  const name = "SyncVault-0.2.0-" + platform + ".zip";
  const payload = Buffer.from("signed payload");
  const good = { name, size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const manifest = { format: "sync-vault-update-v1", version: "0.2.0", notes: "변경 내역", platforms: { [platform]: good } };
  const base = "https://github.com/poyal/sync-vault/releases/download/v0.2.0/";
  const release = { tag_name: "v0.2.0", draft: false, prerelease: false, assets: ["update.json", "update.sig", name].map((n) => ({
    name: n, state: "uploaded", size: n === name ? payload.length : n === "update.sig" ? 64 : 300, browser_download_url: base + n,
  })) };
  let status = 200, badSignature = false, corrupt = false, pause = false;
  let redirect = "https://release-assets.githubusercontent.com/example";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string, options: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/poyal/sync-vault/releases/latest")
      return Response.json(release, { status });
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (url === base + "update.json" || url === base + scoped + ".json") return new Response(bytes);
    if (url === base + "update.sig" || url === base + scoped + ".sig") return new Response(badSignature ? Buffer.alloc(64) : sign(null, bytes, keys.privateKey));
    if (url === base + name) return Response.redirect(redirect, 302);
    assert.equal(url, "https://release-assets.githubusercontent.com/example");
    if (pause) {
      await new Promise<void>((_, reject) => options.signal!.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
    }
    return new Response(corrupt ? Buffer.alloc(payload.length) : payload);
  });
  const up = new Updater(home, "0.1.1", publicKey, () => {});
  assert.ok(compare("0.10.0", "0.2.0") > 0);
  for (const field of ["draft", "prerelease"] as const) {
    release[field] = true;
    await up.check(); assert.match(up.status, /정식 릴리즈 형식/);
    release[field] = false;
  }
  status = 404; await up.check(); assert.match(up.status, /찾을 수 없/);
  status = 403; await up.check(); assert.match(up.status, /403/);
  status = 200;
  release.tag_name = "v0.1.0"; await up.check(); assert.match(up.status, /최신/);
  assert.equal(requests.some(u => u.startsWith(base)), false);
  release.tag_name = "v0.2.0";
  manifest.version = "0.2.1"; await up.check(); assert.match(up.status, /태그/);
  manifest.version = "0.2.0";
  badSignature = true; await up.check(); assert.match(up.status, /서명/);
  badSignature = false;
  manifest.platforms = {}; await up.check(); assert.match(up.status, /이 OS/);
  manifest.platforms = { [platform]: good };
  const zip = release.assets.pop()!;
  await up.check(); assert.match(up.status, /이 OS/);
  release.assets.push({ ...zip, size: zip.size + 1 });
  await up.check(); assert.match(up.status, /파일을 확인/);
  release.assets[2] = zip;
  await up.check(); assert.equal(up.status, "다운로드 가능"); assert.equal(up.notes, "변경 내역");
  const metadata = (name: string, size: number) => ({ name, size, state: "uploaded", browser_download_url: base + name });
  release.assets.push(metadata(scoped + ".json", 300));
  await up.check(); assert.match(up.status, /확인 실패/);
  release.assets.push(metadata(scoped + ".sig", 64));
  const since = requests.length;
  badSignature = true;
  await up.check(); assert.match(up.status, /서명/);
  assert.equal(requests.slice(since).includes(base + "update.json"), false);
  badSignature = false;
  await up.check(); assert.equal(up.status, "다운로드 가능");
  redirect = "https://example.org/package";
  await up.download(); assert.match(up.status, /허용되지/);
  redirect = "https://release-assets.githubusercontent.com/example";
  corrupt = true; await up.download(); assert.match(up.status, /무결성/);
  corrupt = false; pause = true;
  const previousCount = requests.length;
  const pending = up.download();
  for (let i = 0; i < 100 && !requests.slice(previousCount).includes(redirect); i++)
    await new Promise(r => setTimeout(r, 10));
  assert.ok(requests.slice(previousCount).includes(redirect));
  up.cancel(); await pending; assert.equal(up.status, "다운로드 취소됨");
  assert.deepEqual(await fs.readdir(path.join(home, "updates")), []);
  pause = false; await up.download(); assert.equal(up.ready, true); assert.equal(up.percent, 100);
  const [dir] = await fs.readdir(path.join(home, "updates"));
  assert.deepEqual(await fs.readFile(path.join(home, "updates", dir, "update.zip")), payload);
});
test("manual updates offer only published installers for the requested OS and exact release", async (t) => {
  const root = await tmp(t);
  const base = "https://github.com/poyal/sync-vault/releases/download/v2.0.0/";
  const assets = ["SyncVault-2.0.0-win-x64.exe", "SyncVault-2.0.0-mac-arm64.dmg"].map(name =>
    ({ name, size: 200, state: "uploaded", browser_download_url: base + name }));
  t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.equal(input, "https://api.github.com/repos/poyal/sync-vault/releases/latest");
    return Response.json({ tag_name: "v2.0.0", draft: false, prerelease: false, assets });
  });
  const release = await latestRelease(new AbortController().signal);
  assert.equal(release.installer("win32-x64"), assets[0].browser_download_url);
  assert.equal(release.installer("darwin-arm64"), assets[1].browser_download_url);
  assert.equal(release.installer("darwin-x64"), "");
  const checker = new Updater(root, "0.2.1", "", () => {});
  await checker.check();
  assert.equal(checker.installerUrl, release.installer(process.platform + "-" + process.arch));
  assets[0].browser_download_url = "https://example.org/setup.exe";
  assets[1].state = "new";
  await checker.check();
  assert.equal(checker.installerUrl, "");
  assert.equal(checker.releasePage, "https://github.com/poyal/sync-vault/releases/tag/v2.0.0");
  await assert.rejects(checker.download(), /먼저 확인/);
});
test("release signing preserves each platform's metadata and the 0.2.1 manifest", async (t) => {
  const root = await tmp(t);
  const script = path.resolve("scripts/release.mjs");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyFile = path.join(root, "test-key");
  await fs.writeFile(path.join(root, "release-key.pub"), pub);
  await fs.writeFile(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const manifest = async (stem: string) => verifyManifest(
    await fs.readFile(path.join(root, "stage", stem + ".json")),
    await fs.readFile(path.join(root, "stage", stem + ".sig")), pub);
  const platforms = ["win32-x64", "darwin-arm64"];
  for (const platform of platforms) {
    const zip = "SyncVault-1.2.3-" + platform + ".zip";
    await fs.writeFile(path.join(root, zip), platform);
    execFileSync(process.execPath, [script, "publish", "stage", "1.2.3", zip], {
      cwd: root, env: { ...process.env, SYNC_VAULT_SIGNING_FILE: keyFile }, windowsHide: true,
    });
  }
  const common = await manifest("update");
  for (const platform of platforms) {
    const signed = await manifest("update-" + platform);
    assert.deepEqual(Object.keys(signed.platforms), [platform]);
    assert.deepEqual(signed.platforms[platform], common.platforms[platform]);
    assert.equal(common.platforms[platform].sha256, createHash("sha256").update(platform).digest("hex"));
  }
});
test("a Windows update requests focus only if the user was idle during replacement", () => {
  for (const [idle, acceptsFocus] of [[true, true], [true, false], [false, true]] as const) {
    let focused = false;
    const calls: string[] = [];
    const window = Object.assign(new EventEmitter(), {
      showInactive: () => calls.push("show"),
      focus: () => { calls.push("focus"); focused = acceptsFocus; },
      isFocused: () => focused,
      flashFrame: (on: boolean) => calls.push(on ? "flash" : "stop"),
    });
    showUpdatedWindow(window, 3000, idle ? 4 : 1);
    window.emit("focus");
    assert.deepEqual(calls, ["show", ...(idle ? ["focus"] : []), ...(focused ? [] : ["flash", "stop"])]);
  }
});
test("three independent TLS identities register, communicate in all six directions, reject revoked peers", async (t) => {
  const root = await tmp(t);
  process.env.SYNC_VAULT_TEST_HOME = root;
  process.env.SYNC_VAULT_TEST_LOOPBACK = "1";
  const nodes: Lan[] = [];
  const received = new Map<string, string>();
  t.after(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    delete process.env.SYNC_VAULT_TEST_LOOPBACK;
    delete process.env.SYNC_VAULT_TEST_HOME;
  });
  for (let i = 0; i < 3; i++) {
    const st = new Store(path.join(root, "n" + i), root);
    st.state.settings.name = "QA " + i;
    const node = new Lan(
      st,
      await createIdentity(),
      "0.1.0",
      async (id, r, q) => {
        assert.equal(r, "/clip");
        const data: any = await readJSON(q);
        received.set(i + "-" + id, data.text);
        return { ok: true };
      },
      () => {},
    );
    nodes.push(node);
    await node.poll();
    assert.ok(node.pairPort, node.diagnostics);
  }
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const a = nodes[i],
        b = nodes[j],
        endpoint = { address: "127.0.0.1", port: b.pairPort },
        request = await a.inspect(endpoint);
      if (i === 0 && j === 1) {
        const controller = new AbortController();
        const expired = await a.inspect(endpoint);
        const first = a
          .register(endpoint, expired, controller.signal, () => false)
          .catch(() => {});
        while (!b.pending.has(a.id))
          await new Promise((r) => setTimeout(r, 10));
        b.pending.get(a.id)!.expires = Date.now() - 1;
        assert.throws(() => b.approve(a.id), /만료/);
        await b.poll();
        assert.equal(b.pending.has(a.id), false);
        assert.equal(b.online.has(a.id), false);
        controller.abort();
        await first;
      }
      const p = a.register(endpoint, request, AbortSignal.timeout(15000));
      for (let n = 0; !b.pending.has(a.id) && n < 100; n++)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(b.pending.get(a.id)?.code, request.code);
      b.approve(a.id);
      await p;
    }
  for (const a of nodes)
    for (const b of nodes)
      if (a !== b) {
        const r: any = await a.send(b.id, "/clip", { text: "여섯 방향 😀" });
        assert.ok(r.ok);
      }
  assert.equal(received.size, 6);
  nodes[0].forget(nodes[1].id);
  await assert.rejects(
    nodes[1].send(nodes[0].id, "/clip", { text: "revoked" }),
  );
});
test("mixed files, empty folder, persisted 4 MiB checkpoint, collision and receipt replay", async (t) => {
  const root = await tmp(t),
    src = path.join(root, "원본"),
    home = path.join(root, "home"),
    dest = path.join(root, "받음");
  await fs.mkdir(path.join(src, "빈 폴더"), { recursive: true });
  await fs.writeFile(
    path.join(src, "한 글.bin"),
    Buffer.alloc(chunkSize * 2 + 37, 67),
  );
  await fs.writeFile(path.join(src, "empty.txt"), "");
  const st = new Store(home, root);
  st.state.settings.receive = writable(dest);
  st.state.peers.push({ id: "peer", autoAccept: true } as any);
  st.save();
  const entries = await inventory([src]);
  const job = createJob(entries, "peer");
  let store = st,
    receiver = new Receiver(
      store,
      async () => {},
      () => true,
    );
  let interrupt = true,
    sent = 0;
  const send = async (_peer: string, route: string, body: any) => {
    if (route === "/offer") return receiver.offer("peer", body);
    if (route === "/finish") return receiver.finish("peer", body.id);
    const [, , id, index, op] = route.split("/");
    if (Buffer.isBuffer(body)) {
      if (interrupt && Number(op) >= chunkSize) {
        interrupt = false;
        throw Error("케이블 분리");
      }
      sent += body.length;
    }
    return receiver.part("peer", id, Number(index), op, body);
  };
  await assert.rejects(
    transmit(job, send, new AbortController().signal, () => {}),
    /케이블/,
  );
  store = new Store(home, root);
  receiver = new Receiver(
    store,
    async () => {},
    () => true,
  );
  await fs.mkdir(path.join(dest, "원본"));
  assert.equal(
    await transmit(job, send, new AbortController().signal, () => {}),
    "complete",
  );
  assert.equal(sent, chunkSize * 2 + 37);
  assert.equal(
    await digest(path.join(dest, "원본 (1)", "한 글.bin")),
    entries.find((e) => e.name.endsWith(".bin"))?.hash,
  );
  assert.ok(
    (await fs.stat(path.join(dest, "원본 (1)", "빈 폴더"))).isDirectory(),
  );
  assert.equal(
    await transmit(job, send, new AbortController().signal, () => {}),
    "complete",
  );
  assert.equal((await fs.readdir(dest)).length, 2);
});

test("encrypted per-device clip history survives restart, trims immediately, and removes its ciphertext", async (t) => {
  const dir = await tmp(t),
    key = Buffer.alloc(32, 8),
    stamp = { clock: 1, origin: "a".repeat(64) };
  let limit = 5;
  const h = new History(dir, key, () => limit);
  await h.init();
  await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      h.add({ kind: "text", text: "비공개 원고 " + n, stamp }),
    ),
  );
  assert.equal(h.list().length, 5);
  for (const file of await fs.readdir(dir))
    assert.equal(
      (await fs.readFile(path.join(dir, file))).includes(
        Buffer.from("비공개 원고"),
      ),
      false,
    );
  const restored = new History(dir, key, () => limit);
  await restored.init();
  assert.deepEqual(restored.list(), JSON.parse(JSON.stringify(h.list())));
  const old = h.list().at(-1)!.id;
  limit = 1;
  await restored.trim();
  await assert.rejects(restored.get(old));
  assert.equal((await fs.readdir(dir)).length, 2);
  await restored.remove();
  assert.deepEqual(await fs.readdir(dir), ["index"]);
});
test("shelf pages only its own portable tree and refuses stale selections and redirected folders", async (t) => {
  const tmpDir = await tmp(t),
    root = path.join(tmpDir, "공유"),
    outside = path.join(tmpDir, "private");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "private");
  const s = new Shelf(root, Buffer.alloc(32, 77));
  await s.init();
  await fs.mkdir(path.join(root, "편집"));
  await fs.writeFile(path.join(root, "편집", "본문.txt"), "원고");
  await fs.symlink(
    outside,
    path.join(root, "연결"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const listing = await s.list();
  assert.deepEqual(
    listing.rows.map((e) => e.name),
    ["편집"],
  );
  const child = (await s.list(listing.rows[0].id)).rows[0];
  const decomposed = "한글 메모.txt".normalize("NFD");
  await fs.writeFile(path.join(root, decomposed), "메모");
  assert.ok((await s.list()).rows.some((row) => row.name === "한글 메모.txt"));
  await fs.writeFile(path.join(root, "편집", "본문.txt"), "새 원고");
  await assert.rejects(
    s.manifest("peer", "job", child.id, 0, () => {}),
    /새로고침/,
  );
  await fs.rename(path.join(root, "편집"), path.join(root, "이전"));
  await fs.symlink(
    outside,
    path.join(root, "편집"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(s.list(listing.rows[0].id));
});
test("migration preserves identity, registrations, received files and destination, disables legacy push", async (t) => {
  const home = await tmp(t),
    s = new Store(home, home),
    v = s.state;
  v.settings.receive = path.join(home, "기존 위치");
  v.settings.paused = false;
  v.sealed = "sealed";
  v.peers = [{ id: "registered" } as any];
  v.outgoing = [{ id: "legacy", state: "대기" } as any];
  v.incoming = [
    { id: "done", state: "완료", paths: { memo: "기존 파일" } } as any,
  ];
  delete v.vaultVersion;
  delete (v.settings as any).historyLimit;
  delete (v as any).pulls;
  s.save();
  const current = new Store(home, home).state;
  assert.equal(current.sealed, v.sealed);
  assert.deepEqual(current.peers, v.peers);
  assert.deepEqual(current.incoming, v.incoming);
  assert.equal(current.settings.receive, v.settings.receive);
  assert.equal(current.settings.historyLimit, 10);
  assert.ok(current.settings.paused);
  assert.equal(current.outgoing[0].state, "취소");
  assert.deepEqual(current.pulls, []);
});

test("completed pulls release source slots and verify the original folder before publishing", async (t) => {
  const root = await tmp(t),
    shelf = new Shelf(root, Buffer.alloc(32, 42));
  await shelf.init();
  await fs.mkdir(path.join(root, "원고"));
  const id = (await shelf.list()).rows[0].id;
  const prepare = async (job: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await shelf.manifest("peer", job, id, 0, () => {});
      if (r.entries) return;
      await new Promise((r) => setTimeout(r, 4));
    }
    throw Error("prepare timeout");
  };
  for (let i = 0; i < 36; i++) {
    const job = "job" + i;
    await prepare(job);
    assert.equal(shelf.isServing(), true);
    await shelf.release("peer", job, true, () => {});
    assert.equal(shelf.isServing(), false);
  }
  await prepare("changed");
  await fs.writeFile(path.join(root, "원고", "새 파일"), "변경");
  await assert.rejects(shelf.release("peer", "changed", true, () => {}));
});

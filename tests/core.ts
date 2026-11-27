import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
import { Updater, verifyManifest, compare } from "../src/update";
import { ReleaseFolder } from "../src/releases";
import { checkedPng, cleanHTML } from "../src/content";
import { newer } from "../src/types";
const tmp = async (t: any) => {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "sv-qa-"));
  t.after(() => fs.rm(p, { recursive: true, force: true }));
  return p;
};
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
  const entry = (name: string) => ({ name, dir: false, size: 0, hash: "0".repeat(64) });
  const entries = Array.from({ length: 8001 }, (_, i) => entry(String(i)));
  const id = randomUUID();
  for (const n of [7999, 8000]) assert.equal(validateOffer({ id, entries: entries.slice(0, n) }).entries.length, n);
  assert.throws(() => validateOffer({ id, entries }));
  assert.throws(() => validateOffer({ id, entries: [entry("é"), entry("e\u0301")] }));
});
test("automatic file receipt enforces exact 32 MiB and 100-file boundaries before creating a job", async t => {
  const root = await tmp(t), store = new Store(root, root);
  const rx = new Receiver(store, async () => {}, () => true);
  const peer = "a".repeat(64);
  const offer = (count: number, bytes: number) => ({
    id: randomUUID(), stamp: { origin: peer, clock: 1 },
    entries: Array.from({ length: count }, (_, i) => ({
      name: i + ".dat", size: i === 0 ? bytes : 0, dir: false, hash: "0".repeat(64),
    })),
  });
  const limit = 32 * 1024 ** 2;
  for (const args of [[99, limit - 1], [100, limit]]) {
    const f = offer(args[0], args[1]);
    assert.equal((await rx.offer(peer, f)).status, "ready");
    await rx.cancel(peer, f.id);
  }
  const count = store.state.incoming.length;
  await assert.rejects(rx.offer(peer, offer(101, 1)), /범위/);
  await assert.rejects(rx.offer(peer, offer(1, limit + 1)), /범위/);
  assert.equal(store.state.incoming.length, count);
});
test("private release folder only serves signed platform assets and requested byte range", async (t) => {
  const root = await tmp(t),
    pair = generateKeyPairSync("ed25519"),
    key = pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    name = "SyncVault-0.2.0-win32-x64.zip",
    bytes = Buffer.from("payload");
  const m = Buffer.from(
      JSON.stringify({
        format: "sync-vault-update-v1",
        version: "0.2.0",
        notes: "",
        platforms: {
          "win32-x64": {
            name,
            size: 7,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      }),
    ),
    s = sign(null, m, pair.privateKey);
  await Promise.all([
    fs.writeFile(path.join(root, "update.json"), m),
    fs.writeFile(path.join(root, "update.sig"), s),
    fs.writeFile(path.join(root, name), bytes),
  ]);
  assert.equal(verifyManifest(m, s, key).version, "0.2.0");
  assert.throws(() =>
    verifyManifest(Buffer.concat([m, Buffer.from(" ")]), s, key),
  );
  assert.ok(compare("0.10.0", "0.2.0") > 0);
  const folder = new ReleaseFolder(() => root, key);
  assert.ok((await folder.index()).sig);
  assert.equal(
    Buffer.from(
      (await folder.part({ name, offset: 3 })).data,
      "base64",
    ).toString(),
    "load",
  );
  await assert.rejects(folder.part({ name: "../state.json", offset: 0 }));
});
test("updater rejects a damaged package, non-target platform and downgrade", async (t) => {
  const home = await tmp(t),
    keys = generateKeyPairSync("ed25519");
  const pub = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const platform = process.platform + "-" + process.arch;
  const good = Buffer.from("valid"),
    broken = Buffer.from("wrong");
  const asset = {
    name: "SyncVault-0.2.0-" + platform + ".zip",
    size: good.length,
    sha256: createHash("sha256").update(good).digest("hex"),
  };
  let version = "0.2.0",
    platforms = { [platform]: asset };
  const updates = new Updater(home, "0.1.0", "", pub, () => {}, {
    indexes: async () => {
      const manifest = Buffer.from(
        JSON.stringify({
          format: "sync-vault-update-v1",
          version,
          notes: "",
          platforms,
        }),
      );
      return [
        { peer: "test", manifest, sig: sign(null, manifest, keys.privateKey) },
      ];
    },
    part: async () => broken,
  });
  await updates.check();
  assert.equal(updates.status, "다운로드 가능");
  await updates.download();
  assert.equal(updates.ready, false);
  assert.match(updates.status, /무결성/);
  assert.deepEqual(await fs.readdir(path.join(home, "updates")), []);
  platforms = { "different-arch": asset };
  await updates.check();
  assert.match(updates.status, /이 OS/);
  version = "0.0.1";
  platforms = { [platform]: asset };
  await updates.check();
  assert.match(updates.status, /최신/);
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

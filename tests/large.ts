import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createIdentity, fingerprint } from "../src/identity";
import { ShareListener, readJSON, json, shareRequest } from "../src/network";
import { Store, writable } from "../src/store";
import { binary } from "../src/lan";
import {
  Receiver,
  createJob,
  chunkSize,
  inventory,
  transmit,
  digest,
} from "../src/files";
async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sync-vault-5g-")),
    size = 5 * 1024 ** 3;
  const available = await fs.statfs(home);
  if (available.bavail * available.bsize < size * 2 + 1024 ** 3)
    throw Error("11 GiB 이상의 빈 공간이 필요합니다.");
  const source = path.join(home, "fixture.bin"),
    file = await fs.open(source, "wx");
  await file.truncate(size);
  await file.write(Buffer.from("Sync Vault 5 GiB"), 0, 16, size - 16);
  await file.close();
  const client = await createIdentity(),
    server = await createIdentity(),
    id = fingerprint(client.cert);
  const st = new Store(path.join(home, "app"), home);
  st.state.settings.receive = writable(path.join(home, "received"));
  st.state.peers = [{ id, autoAccept: true } as any];
  st.save();
  let store = st,
    rx = new Receiver(
      st,
      async () => {},
      () => true,
    );
  const listener = new ShareListener(
    server,
    [client.cert],
    false,
    async (req, res, peer) => {
      const r = req.url || "";
      let result;
      if (r === "/offer") result = await rx.offer(peer.id, await readJSON(req));
      else if (r === "/finish") {
        const v: any = await readJSON(req);
        result = await rx.finish(peer.id, v.id);
      } else {
        const m = /^\/part\/([a-f0-9-]+)\/(\d+)\/(\w+)$/.exec(r)!;
        result = await rx.part(
          peer.id,
          m[1],
          +m[2],
          m[3],
          /^\d/.test(m[3]) ? await binary(req) : await readJSON(req),
        );
      }
      json(res, result);
    },
  );
  const endpoint = await listener.listen("127.0.0.1"),
    start = performance.now();
  let sent = 0,
    broke = false,
    peak = 0;
  try {
    const job = createJob(await inventory([source]), id);
    const send = async (_id: string, r: string, b: any, s?: AbortSignal) => {
      if (Buffer.isBuffer(b) && !broke && sent >= size / 2) {
        broke = true;
        throw Error("QA disconnect");
      }
      const result = await shareRequest(
        client,
        endpoint,
        server.cert,
        r,
        Buffer.isBuffer(b) ? b : Buffer.from(JSON.stringify(b)),
        s,
        Buffer.isBuffer(b),
      );
      if (Buffer.isBuffer(b)) sent += b.length;
      peak = Math.max(peak, process.memoryUsage.rss());
      return result;
    };
    await assert.rejects(
      transmit(job, send, new AbortController().signal, () => {}),
      /QA disconnect/,
    );
    const checkpoint = sent;
    store = new Store(st.home, home);
    rx = new Receiver(
      store,
      async () => {},
      () => true,
    );
    assert.equal(
      await transmit(job, send, new AbortController().signal, () => {}),
      "complete",
    );
    assert.equal(sent, size);
    assert.equal(
      await digest(path.join(st.state.settings.receive, "fixture.bin")),
      job.entries[0].hash,
    );
    const report = {
      bytes: sent,
      checkpoint,
      elapsedMs: Math.round(performance.now() - start),
      peakRSS: peak,
      hash: job.entries[0].hash,
    };
    console.log(JSON.stringify(report));
    await fs.mkdir("artifacts/test", { recursive: true });
    await fs.writeFile(
      "artifacts/test/large.json",
      JSON.stringify(report, null, 2),
    );
  } finally {
    await listener.close();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 4 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

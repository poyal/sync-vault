import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store, writable } from "../src/store";
import { fingerprint } from "../src/identity";
import { Lan, binary } from "../src/lan";
import { readJSON } from "../src/network";
import { Receiver, createJob, inventory, transmit } from "../src/files";
async function main() {
  const [home, local, other, run] = process.argv.slice(2),
    root = path.join(home, run);
  const keys = JSON.parse(
      await fs.readFile(path.join(home, "identity.json"), "utf8"),
    ),
    cert = await fs.readFile(path.join(home, "other-public.pem"), "utf8"),
    id = fingerprint(cert);
  const store = new Store(root, root);
  store.state.settings.name = "Sync Vault QA " + process.platform;
  store.state.settings.receive = writable(path.join(root, "in"));
  store.state.peers = [
    {
      id,
      cert,
      name: "QA",
      autoAccept: true,
      seen: 0,
      endpoint: { address: other, port: 49513 },
    },
  ];
  store.save();
  const rx = new Receiver(
    store,
    async () => {},
    () => true,
  );
  let got = false,
    clips = 0;
  const lan = new Lan(
    store,
    keys,
    "0.1.0",
    async (peer, r, q) => {
      if (r === "/clip") {
        const b: any = await readJSON(q);
        assert.equal(b.text, "한글 클립보드 😀");
        clips++;
        return {};
      }
      if (r === "/offer") return rx.offer(peer, await readJSON(q));
      if (r === "/finish") {
        const b: any = await readJSON(q);
        await rx.finish(peer, b.id);
        got = true;
        return {};
      }
      const m = /^\/part\/([a-f0-9-]+)\/(\d+)\/(\w+)$/.exec(r)!;
      return rx.part(
        peer,
        m[1],
        +m[2],
        m[3],
        /^\d/.test(m[3]) ? await binary(q) : await readJSON(q),
      );
    },
    () => {},
    { address: local, port: 49513 },
  );
  const delay = (n: number) => new Promise((r) => setTimeout(r, n));
  try {
    lan.start();
    for (let i = 0; i < 240 && !lan.available(id); i++) await delay(250);
    assert.ok(lan.available(id), lan.diagnostics);
    await delay(5000);
    const times = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await lan.send(id, "/clip", { text: "한글 클립보드 😀" });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const folder = path.join(root, "테스트-" + randomUUID().slice(0, 8));
    await fs.mkdir(path.join(folder, "빈 폴더"), { recursive: true });
    for (let i = 0; i < 100; i++)
      await fs.writeFile(
        path.join(folder, "파일 " + i + ".bin"),
        Buffer.alloc(i === 0 ? 5 * 1024 ** 2 : i, 65),
      );
    const job = createJob(await inventory([folder]), id);
    assert.equal(
      await transmit(
        job,
        (...args) => lan.send(...args),
        new AbortController().signal,
        () => {},
      ),
      "complete",
    );
    for (let i = 0; i < 240 && !got; i++) await delay(250);
    assert.ok(got);
    assert.equal(clips, 100);
    const report = {
      os: process.platform,
      files: 100,
      emptyFolders: 1,
      sent: job.done,
      receivedClips: clips,
      p95TransmissionMs: times[94],
      discovered: lan.nearby.has(id),
    };
    await fs.writeFile(
      path.join(root, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    await delay(4000);
  } finally {
    await lan.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

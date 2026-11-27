import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {
  base,
  launch,
  approve,
  wait,
  fixture,
  stopApps,
  cleanup,
} from "./desktop-peers.mjs";
const [oldApp, newApp] = process.argv.slice(2);
if (!oldApp || !newApp)
  throw Error("mixed-versions.mjs <0.1.0 executable> <0.1.1 executable>");
try {
  for (let mask = 0; mask < 8; mask++) {
    const peers = [];
    for (let i = 0; i < 3; i++) {
      const newer = !!(mask & (1 << i)),
        p = await launch("QA-" + mask + "-" + i, newer ? newApp : oldApp);
      assert.equal((await p.state()).version, newer ? "0.1.1" : "0.1.0");
      p.receive = path.join(base, "in-" + mask + "-" + i);
      await p.call("settings", { receive: p.receive });
      peers.push(p);
    }
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) await approve(peers[i], peers[j]);
    for (const p of peers) {
      const s = await p.state();
      for (const other of s.peers)
        await p.call("autoaccept", { id: other.id, value: true });
      await wait(
        async () =>
          (await p.state()).peers.filter((x) => x.online).length === 2,
      );
    }
    for (const from of peers)
      for (const to of peers) {
        if (from === to) continue;
        const name = from.label + "-" + to.label + ".txt",
          bytes = Buffer.from("조합 😀 " + name);
        const file = await fixture("source/" + name, bytes);
        await from.call("drop", [file]);
        await from.call("send", (await to.state()).local.id);
        await wait(async () =>
          (await from.state()).jobs.some(
            (j) => j.name === name && j.state === "완료",
          ),
        );
        assert.deepEqual(await fs.readFile(path.join(to.receive, name)), bytes);
      }
    console.log(
      "PASS",
      mask.toString(2).padStart(3, "0"),
      "6/6 real packaged transfers",
    );
    await stopApps();
  }
} finally {
  await cleanup();
}

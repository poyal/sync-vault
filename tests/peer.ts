// Physical LAN acceptance fixture. Only the pre-provisioned QA certificate is trusted.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createIdentity, fingerprint } from "../src/identity";
import { ShareListener, shareRequest, readJSON, json } from "../src/network";
import { binary } from "../src/lan";
import { Store, writable } from "../src/store";
import { Receiver, inventory, createJob, transmit } from "../src/files";
async function main() {
  const [mode, home, address, portText] = process.argv.slice(2);
  if (!path.isAbsolute(home)) throw Error("absolute QA directory required");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if (mode === "init") {
    const k = await createIdentity();
    await fs.writeFile(path.join(home, "identity.json"), JSON.stringify(k), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.writeFile(path.join(home, "peer-public.pem"), k.cert);
    return;
  }
  const keys = JSON.parse(
      await fs.readFile(path.join(home, "identity.json"), "utf8"),
    ),
    cert = await fs.readFile(path.join(home, "other-public.pem"), "utf8"),
    peer = fingerprint(cert);
  if (mode === "serve") {
    const st = new Store(home, home);
    st.state.settings.receive = writable(path.join(home, "received"));
    st.state.peers = [{ id: peer, autoAccept: true } as any];
    st.save();
    const rx = new Receiver(
      st,
      async () => {},
      () => true,
    );
    const srv = new ShareListener(
      keys,
      [cert],
      false,
      async (req, res, remote) => {
        if (remote.id !== peer) throw Error("Unexpected peer");
        const route = req.url || "";
        let result: any;
        if (route === "/offer")
          result = await rx.offer(peer, await readJSON(req, 8 * 1024 ** 2));
        else if (route === "/finish") {
          const b: any = await readJSON(req);
          result = await rx.finish(peer, b.id);
        } else if (route === "/ping") {
          const b: any = await readJSON(req);
          result = { echo: b.text };
        } else {
          const m = /^\/part\/([a-f0-9-]+)\/(\d+)\/(\w+)$/.exec(route);
          if (!m) throw Error("route");
          result = await rx.part(
            peer,
            m[1],
            +m[2],
            m[3],
            /^\d/.test(m[3]) ? await binary(req) : await readJSON(req),
          );
        }
        json(res, result);
      },
    );
    console.log(JSON.stringify(await srv.listen(address, +portText)));
    const stop = setTimeout(() => void srv.close(), 10 * 60000);
    stop.unref();
    return;
  }
  const endpoint = { address, port: +portText };
  const send = (_id: string, r: string, b: any, s?: AbortSignal) =>
    shareRequest(
      keys,
      endpoint,
      cert,
      r,
      Buffer.isBuffer(b) ? b : Buffer.from(JSON.stringify(b)),
      s,
      Buffer.isBuffer(b),
    );
  const times = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now(),
      text = "한글 / 😀 " + i;
    const r: any = await send(peer, "/ping", { text });
    if (r.echo !== text) throw Error("echo");
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const src = path.join(home, "fixture-" + randomUUID().slice(0, 8));
  await fs.mkdir(path.join(src, "빈 폴더"), { recursive: true });
  for (let i = 0; i < 100; i++)
    await fs.writeFile(
      path.join(src, "파일 " + i + ".bin"),
      Buffer.alloc(i === 0 ? 5 * 1024 ** 2 : i, 65),
    );
  const j = createJob(await inventory([src]), peer);
  const result = await transmit(
    j,
    send,
    new AbortController().signal,
    () => {},
  );
  if (result !== "complete") throw Error(result);
  console.log(
    JSON.stringify({
      status: result,
      entries: j.entries.length,
      bytes: j.done,
      p95RoundTripMs: times[94],
    }),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

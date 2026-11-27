import { app, clipboard, ClipboardItem, nativeImage } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Clips } from "../src/clipboard";
import { Lan } from "../src/lan";
import { Store } from "../src/store";
import { fingerprint } from "../src/identity";
import { readJSON } from "../src/network";
import { clipSchema, type Clip } from "../src/content";

const env = process.env,
  home = env.SYNC_VAULT_QA_HOME!,
  station = env.SYNC_VAULT_QA_STATION!;
const win = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await sleep(75);
  }
  throw Error("실기기 클립보드 대기 시간 초과");
}
async function main() {
  if (
    !home ||
    !station?.startsWith("SyncVaultQA-") ||
    !env.SYNC_VAULT_QA_IDENTITY
  )
    throw Error("isolated QA clipboard and profile required");
  app.setPath("userData", home);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const keys = JSON.parse(
    await fs.readFile(
      path.join(env.SYNC_VAULT_QA_IDENTITY, "identity.json"),
      "utf8",
    ),
  );
  const cert = await fs.readFile(
    path.join(env.SYNC_VAULT_QA_IDENTITY, "other-public.pem"),
    "utf8",
  );
  const peer = fingerprint(cert),
    store = new Store(home, home);
  const address = env.SYNC_VAULT_QA_LOCAL!,
    other = env.SYNC_VAULT_QA_OTHER!;
  store.state.peers = [
    {
      id: peer,
      cert,
      name: "QA",
      autoAccept: true,
      seen: 0,
      endpoint: { address: other, port: 49517 },
    },
  ];
  const received: Clip[] = [];
  let localCopies = 0,
    note = "";
  const lan = new Lan(
    store,
    keys,
    "0.1.0",
    async (id, route, req) => {
      assert.equal(route, "/clip");
      const c = clipSchema.parse(await readJSON(req));
      await clips.receive(id, c);
      received.push(c);
      return {};
    },
    () => {},
    { address, port: 49517 },
  );
  const native = path.resolve(
    "out/native",
    win ? "clipboard.exe" : "clipboard",
  );
  const clips = new Clips(
    native,
    store,
    lan.id,
    async (c) => {
      localCopies++;
      await lan.send(peer, "/clip", c);
    },
    async () => {},
    (s) => {
      note = s;
    },
  );
  const expected = "실기기 한글 😀";
  const boardData = (type: string) =>
    Buffer.from(
      execFileSync(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `function run(a){ObjC.import('AppKit');return ObjC.unwrap($.NSPasteboard.pasteboardWithName(a[0]).dataForType(a[1]).base64EncodedStringWithOptions(0));}`,
          station,
          type,
        ],
        { encoding: "utf8" },
      ).trim(),
      "base64",
    );
  try {
    // Only Windows watches for local writes. The Mac explicitly reads its named test board.
    // This keeps Electron from querying the Mac user's general pasteboard.
    if (win) await clips.start();
    else await clips.resetBaseline();
    lan.start();
    await until(() => lan.available(peer));
    await sleep(2500);
    if (win) {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([expected], { type: "text/plain" }),
          "text/html": new Blob(["<b>" + expected + "</b>"], {
            type: "text/html",
          }),
        }),
      ]);
      await until(() => received.some((c) => c.kind === "text"));
      const items = await clipboard.read(),
        text = await items[0].getType("text/plain"),
        html = await items[0].getType("text/html");
      assert.equal(await text.text(), expected);
      assert.match(await html.text(), /<b>실기기 한글 😀<\/b>/);
      const input = nativeImage.createFromBitmap(
        Buffer.from([0, 0, 255, 255, 0, 0, 0, 0]),
        { width: 2, height: 1 },
      );
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([new Uint8Array(input.toPNG())], {
            type: "image/png",
          }),
        }),
      ]);
      await until(() => received.some((c) => c.kind === "image"));
      const pictures = await clipboard.read(),
        image = await pictures[0].getType("image/png");
      const output = nativeImage.createFromBuffer(
        Buffer.from(await image.arrayBuffer()),
      );
      assert.deepEqual(output.toBitmap(), input.toBitmap());
      await sleep(1000);
      assert.equal(localCopies, 2, note);
    } else {
      for (const kind of ["text", "image"] as const) {
        await until(() => received.some((c) => c.kind === kind));
        const stamp = { origin: lan.id, clock: store.state.stamp.clock + 1 };
        if (kind === "text") {
          const text = boardData("public.utf8-plain-text").toString(),
            html = boardData("public.html").toString();
          assert.equal(text, expected);
          assert.match(html, /<b>실기기 한글 😀<\/b>/);
          await lan.send(peer, "/clip", { kind, stamp, text, html });
        } else {
          const data = boardData("public.png");
          assert.deepEqual(
            nativeImage.createFromBuffer(data).toBitmap(),
            Buffer.from([0, 0, 255, 255, 0, 0, 0, 0]),
          );
          await lan.send(peer, "/clip", {
            kind,
            stamp,
            png: data.toString("base64"),
          });
        }
      }
    }
    const result = {
      platform: process.platform,
      text: true,
      html: true,
      alphaPNG: true,
      received: received.length,
      localCopies,
    };
    await fs.writeFile(path.join(home, "result.json"), JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    clips.stop();
    await lan.stop();
  }
}
main()
  .then(() => app.exit(0))
  .catch(async (e) => {
    console.error(e);
    if (home)
      await fs.writeFile(path.join(home, "error.txt"), String(e.stack || e));
    app.exit(1);
  });

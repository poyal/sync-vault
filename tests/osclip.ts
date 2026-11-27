import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  nativeImage,
} from "electron";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store";
import { Clips } from "../src/clipboard";
async function main() {
  const station = process.env.SYNC_VAULT_QA_STATION,
    home = process.env.SYNC_VAULT_QA_HOME;
  if (
    process.platform !== "win32" ||
    !home ||
    !station?.startsWith("SyncVaultQA-")
  )
    throw Error("private Windows station required");
  app.setPath("userData", home);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const store = new Store(home, home),
    self = "1".repeat(64),
    peer = "2".repeat(64),
    sent: any[] = [];
  let error = "";
  const clips = new Clips(
    path.resolve("out/native/clipboard.exe"),
    store,
    self,
    async (c) => {
      sent.push(c);
    },
    async () => {},
    (s) => {
      error = s;
    },
  );
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("clipboard event timeout " + error);
  };
  try {
    await clips.start();
    await new Promise((r) => setTimeout(r, 300));
    const item = (data: Record<string, Blob>) => new ClipboardItem(data);
    await clipboard.write([
      item({
        "text/plain": new Blob(["한글\t😀"], { type: "text/plain" }),
        "text/html": new Blob(["<b>한글</b>"], { type: "text/html" }),
      }),
    ]);
    await wait(() => sent.some((c) => c.kind === "text"));
    assert.equal(sent.at(-1).text, "한글\t😀");
    assert.match(sent.at(-1).html, /<b>한글<\/b>/);
    const image = nativeImage.createFromBitmap(
      Buffer.from([0, 0, 255, 255, 0, 0, 0, 0]),
      { width: 2, height: 1 },
    );
    const png = image.toPNG();
    await clipboard.write([
      item({
        "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }),
      }),
    ]);
    await wait(() => sent.some((c) => c.kind === "image"));
    const fresh = {
      ...sent.at(-1),
      stamp: { clock: store.state.stamp.clock + 1, origin: peer },
    };
    await clips.receive(peer, fresh);
    const parts = await clipboard.read();
    const out = await parts
      .find((i) => i.types.includes("image/png"))!
      .getType("image/png");
    const bitmap = nativeImage
      .createFromBuffer(Buffer.from(await out.arrayBuffer()))
      .toBitmap();
    assert.equal(bitmap[3], 255);
    assert.equal(bitmap[7], 0);
    const count = sent.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sent.length, count);
    const plain = (value: string) => new Blob([value], { type: "text/plain" });
    for (const mode of ["paused", "locked", "private"]) {
      store.state.settings.paused = mode === "paused";
      clips.locked = mode === "locked";
      const start = store.state.stamp.clock;
      const data: Record<string, Blob> = {
        "text/plain": plain("격리 " + mode),
      };
      if (mode === "private")
        data[
          'electron application/osclipboard;format="CanIncludeInClipboardHistory"'
        ] = new Blob([new Uint8Array(4)]);
      await clipboard.write([item(data)]);
      await wait(() => store.state.stamp.clock > start);
      assert.equal(sent.length, count, mode);
    }
    clips.locked = false;
    store.state.settings.paused = false;
    await clipboard.write([item({ "text/plain": plain("공유 재개") })]);
    await wait(() => sent.length === count + 1);
    assert.equal(sent.at(-1).text, "공유 재개");
    const editor = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await editor.loadURL(
      "data:text/html,<meta charset=utf-8><div contenteditable=true id=edit></div>",
    );
    editor.webContents.focus();
    await editor.webContents
      .executeJavaScript(`const edit=document.querySelector("#edit");edit.focus();let pasted=null;edit.addEventListener("paste",async e=>{
      const c=e.clipboardData,f=c.files[0];
      pasted={text:c.getData("text/plain"),html:c.getData("text/html"),png:f?Array.from(new Uint8Array(await f.arrayBuffer())):null};
    });true;`);
    const paste = async () => {
      await editor.webContents.executeJavaScript(
        "pasted=null;edit.focus();true",
      );
      editor.webContents.paste();
      for (let i = 0; i < 80; i++) {
        const data = await editor.webContents.executeJavaScript("pasted");
        if (data) return data;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("Chromium paste event timeout");
    };
    const other = "3".repeat(64);
    const clock = store.state.stamp.clock + 1;
    const textClip = (origin: string, text: string) => ({
      kind: "text",
      text,
      html: "<b>" + text + "</b>",
      stamp: { origin, clock },
    });
    await clips.receive(other, textClip(other, "동시 복사 승자"));
    await clips.receive(peer, textClip(peer, "오래된 항목"));
    const rich = await paste();
    assert.equal(rich.text, "동시 복사 승자");
    assert.match(rich.html, /<b>동시 복사 승자<\/b>/);
    await clips.receive(peer, {
      ...fresh,
      stamp: { origin: peer, clock: clock + 1 },
    });
    const pastedImage = await paste();
    assert.deepEqual(
      nativeImage.createFromBuffer(Buffer.from(pastedImage.png)).toBitmap(),
      image.toBitmap(),
    );
    editor.destroy();
    const root = path.join(home, "image-cache"), stale = path.join(root, randomUUID()),
      referenced = path.join(root, randomUUID()), recent = path.join(root, randomUUID());
    for (const dir of [stale, referenced, recent]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "Image-1.png"), png);
    }
    const old = new Date(Date.now() - 2 * 86400000);
    await fs.utimes(stale, old, old);
    await fs.utimes(referenced, old, old);
    store.state.outgoing.push({
      id: randomUUID(), peer, state: "대기", error: "", done: 0, total: png.length,
      entries: [{ name: "Image-1.png", source: path.join(referenced, "Image-1.png"),
        modified: old.getTime(), size: png.length, hash: "", dir: false }],
    });
    await clips.pruneImages();
    await assert.rejects(fs.access(stale), { code: "ENOENT" });
    for (const dir of [recent, referenced]) assert.deepEqual(await fs.readFile(path.join(dir, "Image-1.png")), png);
    await fs.writeFile(
      path.join(home, "result.json"),
      JSON.stringify({
        text: true,
        html: true,
        transparentPNG: true,
        echoes: 0,
        pausedLockedPrivateExcluded: true,
        chromiumPaste: true,
        concurrentStampOrder: true,
        expiredCachePrunedWithActiveFilesRetained: true,
      }),
    );
    app.exit(0);
  } finally {
    clips.stop();
  }
}
main().catch(async (e) => {
  if (process.env.SYNC_VAULT_QA_HOME)
    await fs.writeFile(
      path.join(process.env.SYNC_VAULT_QA_HOME, "error.txt"),
      String(e.stack || e),
    );
  app.exit(1);
});

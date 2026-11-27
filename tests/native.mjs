import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
const tool = path.resolve(
  "out/native",
  process.platform === "win32" ? "clipboard.exe" : "clipboard",
);
const env = {
  ...process.env,
  SYNC_VAULT_QA_STATION: "SyncVaultQA-" + randomUUID(),
};
const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sv-clipboard-"));
const files = Array.from({ length: 10 }, (_, i) =>
  path.join(folder, "한 글 " + i + ".txt"),
);
const owner = spawn(tool, ["watch", String(process.pid)], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(owner.exitCode, null, "private station failed");
  for (const f of files) await fs.writeFile(f, "내용");
  const args = { env, windowsHide: true };
  execFileSync(tool, ["files"], {
    ...args,
    input: Buffer.from(files.join("\0") + "\0"),
  });
  const data = execFileSync(tool, ["inspect"], args);
  assert.equal(data[4], 2);
  assert.deepEqual(
    data
      .subarray(5)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((f) => f.normalize("NFC")),
    files.map((f) => f.normalize("NFC")),
  );
  if (process.platform === "darwin") {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64",
    );
    const script = `function run(args){
      ObjC.import('AppKit');
      const p=$.NSPasteboard.pasteboardWithName(args[0]);
      const bytes=$.NSData.alloc.initWithBase64EncodedStringOptions(args[1],0);
      const items=$.NSMutableArray.array;
      for(let i=0;i<2;i++){const item=$.NSPasteboardItem.alloc.init;item.setDataForType(bytes,$.NSPasteboardTypePNG);items.addObject(item)}
      p.clearContents;p.writeObjects(items);
    }`;
    execFileSync("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      script,
      env.SYNC_VAULT_QA_STATION,
      png.toString("base64"),
    ]);
    const result = execFileSync(tool, ["images"], args);
    let offset = 0;
    for (let i = 0; i < 2; i++) {
      const n = result.readUInt32LE(offset);
      offset += 4;
      assert.deepEqual(result.subarray(offset, offset + n), png);
      offset += n;
    }
    assert.equal(offset, result.length);
    const readType = (type) =>
      execFileSync(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `function run(args){ ObjC.import('AppKit');return ObjC.unwrap($.NSPasteboard.pasteboardWithName(args[0]).dataForType(args[1]).base64EncodedStringWithOptions(0)); }`,
          env.SYNC_VAULT_QA_STATION,
          type,
        ],
        { encoding: "utf8" },
      ).trim();
    const text = "한글 😀";
    const html = "<b>한글</b>";
    execFileSync(tool, ["content"], {
      ...args,
      input: JSON.stringify({ text, html }),
    });
    assert.equal(
      Buffer.from(readType("public.utf8-plain-text"), "base64").toString(),
      text,
    );
    assert.equal(
      Buffer.from(readType("public.html"), "base64").toString(),
      html,
    );
    execFileSync(tool, ["content"], {
      ...args,
      input: JSON.stringify({ png: png.toString("base64") }),
    });
    assert.equal(readType("public.png"), png.toString("base64"));
    assert.equal(execFileSync(tool, ["inspect"], args)[4], 2);
    console.log(
      "PASS · AppKit 한국어·HTML·PNG 기록 및 독립 PNG 두 장 원본 보존",
    );
  }
  console.log(
    "PASS · 격리된 OS 클립보드에 파일 10개 기록, 원격 복사 표식 검증",
  );
} finally {
  owner.kill();
  await fs.rm(folder, { recursive: true, force: true });
}

import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  base,
  launch,
  nav,
  fixture,
  action,
  cleanup,
} from "./desktop-peers.mjs";
const token = process.argv[2];
if (
  !/^[a-z0-9-]{1,22}$/.test(token || "") ||
  process.env.SYNC_VAULT_QA_PHYSICAL !== "1"
)
  throw Error("named physical run required");
const win = process.platform === "win32",
  self = "QA-" + token + (win ? "-W" : "-M"),
  remote = "QA-" + token + (win ? "-M" : "-W");
const wait = (f) =>
  expect.poll(f, { timeout: 65000, intervals: [250] }).toBe(true);
try {
  const d = await launch(self),
    receive = path.join(base, "in");
  await d.call("settings", { receive });
  console.log(
    "LISTENING",
    (await d.state()).local.address,
    (await d.state()).local.port,
    (await d.state()).diagnostic,
  );
  let discovered = false;
  await expect
    .poll(
      async () => {
        const state = await d.state();
        discovered = state.nearby.some((p) => p.name === remote);
        return discovered;
      },
      { timeout: 20000 },
    )
    .toBe(true)
    .catch(() => {});
  const status = await d.state();
  console.log(
    "DISCOVERY",
    discovered,
    status.local.address,
    status.diagnostic,
    status.nearby.map((p) => ({
      name: p.name.startsWith("QA-") ? p.name : "other",
      address: p.endpoint.address,
    })),
  );
  if (!discovered && !process.env.SYNC_VAULT_QA_DIRECT)
    throw Error("automatic discovery timeout");
  if (win) {
    await d.app.evaluate(({ dialog }, name) => {
      dialog.showMessageBox = async (_window, opts) => ({
        response: opts.message === name + " 기기를 등록할까요?" ? 0 : 1,
        checkboxChecked: false,
      });
    }, remote);
    if (discovered) {
      await d.page
        .locator("#nearby article")
        .filter({ hasText: remote })
        .locator('[data-action="pair"]')
        .click();
    } else {
      await d.page
        .locator("#connect")
        .evaluate((el) => (el.parentElement.open = true));
      await d.page.locator("#endpoint").fill(process.env.SYNC_VAULT_QA_DIRECT);
      await d.page.locator("#connect button").click();
    }
  } else {
    await wait(async () =>
      (await d.state()).pending.some((p) => p.name === remote),
    );
    await d.page
      .locator("#pending article")
      .filter({ hasText: remote })
      .locator('[data-action="approve"]')
      .click();
  }
  await wait(async () =>
    (await d.state()).peers.some((p) => p.name === remote && p.online),
  );
  console.log("REGISTERED", remote);
  await d.call("settings", {
    paused: false,
    text: false,
    image: false,
    files: true,
  });
  const files = [
    await fixture("one/report.txt", self + " 첫째"),
    await fixture("two/report.txt", self + " 둘째"),
  ];
  await nav(d, "전송");
  await d.app.evaluate(({ dialog }, list) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list });
  }, files);
  await d.page.getByRole("button", { name: "파일 추가", exact: true }).click();
  await d.page
    .getByRole("button", { name: remote + "에 보내기", exact: true })
    .click();
  await wait(async () =>
    (await d.state()).jobs.some(
      (j) => j.direction === "받음" && j.state === "승인 대기",
    ),
  );
  await d.page.locator('#jobs [data-action="accept"]').click();
  await wait(
    async () =>
      (await d.state()).jobs.filter((j) => j.state === "완료").length === 2,
  );
  assert.equal(
    await fs.readFile(path.join(receive, "report.txt"), "utf8"),
    remote + " 첫째",
  );
  assert.equal(
    await fs.readFile(path.join(receive, "report (1).txt"), "utf8"),
    remote + " 둘째",
  );
  console.log(
    "PASS",
    process.platform,
    "packaged LAN discovery, fresh pairing, concurrent two-way manual transfer and bytes",
  );
  const localFiles = await Promise.all(
    ["a", "b"].map((n) => fixture(self + "-" + n + ".txt", self + n)),
  );
  async function checkAuto() {
    const helper = path.resolve(
      "out/native",
      win ? "clipboard.exe" : "clipboard",
    );
    let paths = [];
    await wait(async () => {
      const data = execFileSync(helper, ["inspect"], {
        env: { ...process.env, SYNC_VAULT_QA_STATION: d.station },
        windowsHide: true,
      });
      paths = data.subarray(5).toString().split("\0").filter(Boolean);
      return (
        data[4] === 2 &&
        paths.length === 2 &&
        paths.every((f) => path.basename(f).startsWith(remote + "-"))
      );
    });
    for (const [i, name] of ["a", "b"].entries()) {
      assert.equal(await fs.readFile(paths[i], "utf8"), remote + name);
      assert.equal(
        path.dirname(await fs.realpath(paths[i])),
        await fs.realpath(path.join(d.profile, "clipboard-files")),
      );
    }
  }
  if (win) {
    execFileSync(
      path.resolve("artifacts/os-clipboard/station.exe"),
      [d.station, "--local-files", ...localFiles],
      { windowsHide: true },
    );
    await checkAuto();
  } else {
    await checkAuto();
    const jxa = `function run(a){ObjC.import('AppKit');const b=$.NSPasteboard.pasteboardWithName(a[0]);const items=$.NSMutableArray.array;for(const p of a.slice(1))items.addObject($.NSURL.fileURLWithPath(p));b.clearContents;if(!b.writeObjects(items))throw Error('pasteboard');}`;
    execFileSync("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      jxa,
      d.station,
      ...localFiles,
    ]);
    await wait(async () =>
      (await d.state()).jobs.some(
        (j) => j.name === path.basename(localFiles[0]) && j.state === "완료",
      ),
    );
  }
  console.log(
    "PASS",
    process.platform,
    "two automatic clipboard files, OS pasteboard paths and original byte contents",
  );
  await new Promise((r) => setTimeout(r, 2000));
} finally {
  await cleanup();
}

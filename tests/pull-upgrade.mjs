import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { launch, approve, job, wait, base, cleanup } from "./desktop-peers.mjs";
import { closeApp } from "./quit.mjs";

const previous = process.argv[2];
assert.ok(previous, "pull-upgrade.mjs <0.1.x 정식 실행 파일>");
try {
  const first = await launch("원본", previous),
    second = await launch("수신", previous);
  assert.equal((await first.state()).shelf, undefined);
  const receive = path.join(base, "수신 위치");
  await second.call("settings", { receive });
  await fs.writeFile(path.join(receive, "보존.txt"), "이미 받은 자료");
  await approve(first, second);
  const firstId = (await first.state()).local.id,
    secondId = (await second.state()).local.id;
  await closeApp(second.app);

  const upgraded = await launch("수신");
  assert.equal((await upgraded.state()).local.id, secondId);
  await wait(async () =>
    (await upgraded.state()).peers.some(
      (p) => p.id === firstId && p.online && !p.compatible,
    ),
  );
  await upgraded.page.locator('aside [data-page="home"]').click();
  await expect(upgraded.page.locator("#peer-cards")).toContainText(
    "상대 앱 업데이트 필요",
  );
  for (const action of ["vault-history", "vault-list"])
    await assert.rejects(
      upgraded.call(action, { peer: firstId }),
      /업데이트 필요/,
    );
  assert.equal((await upgraded.state()).settings.receive, receive);

  await closeApp(first.app);
  const source = await launch("원본");
  assert.equal((await source.state()).local.id, firstId);
  await wait(async () =>
    (await upgraded.state()).peers.some(
      (p) => p.id === firstId && p.compatible && p.online,
    ),
  );
  await wait(async () =>
    (await source.state()).peers.some(
      (p) => p.id === secondId && p.compatible && p.online,
    ),
  );
  const name = "갱신 후 자료.txt";
  await fs.writeFile(path.join((await source.state()).shelf, name), "A → B");
  const file = (await upgraded.call("vault-list", { peer: firstId })).rows.find(
    (r) => r.name === name,
  );
  assert.ok(file);
  await upgraded.call("vault-get", { peer: firstId, id: file.id, name });
  await job(upgraded, name, "완료");
  assert.equal(await fs.readFile(path.join(receive, name), "utf8"), "A → B");
  assert.equal(
    await fs.readFile(path.join(receive, "보존.txt"), "utf8"),
    "이미 받은 자료",
  );
  console.log(
    "PASS 0.1.x 실제 등록 프로필 두 개를 순차 갱신, 구버전 안내와 차단·기기 ID 및 수신 파일 보존·재등록 없는 가져오기",
  );
} finally {
  await cleanup();
}

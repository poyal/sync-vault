import fs from "node:fs/promises";
import assert from "node:assert/strict";
const groups = JSON.parse(await fs.readFile("tests/feature-coverage.json", "utf8"));
const source = await fs.readFile("src/main.ts", "utf8");
const implemented = new Set(Array.from(source.matchAll(/action === "([a-z-]+)"/g), m => m[1]));
const listed = groups.flatMap(g => g.actions);
assert.equal(new Set(listed).size, listed.length, "중복 IPC 동작");
assert.deepEqual(new Set(listed), implemented, "제품 IPC와 기능별 검증 목록의 차이");
for (const group of groups) {
  assert.ok(group.tests.length && group.desktop.length, group.feature);
  for (const file of group.tests) await fs.access("tests/" + file);
}
console.log("기능 " + groups.length + "개 영역, IPC 동작 " + listed.length + "개에 대한 검증 경로 확인");

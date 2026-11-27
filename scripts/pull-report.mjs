import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const [shots, output, largePath, residentPath, extraPath] =
  process.argv.slice(2);
assert.ok(
  shots && output,
  "pull-report.mjs <화면 폴더> <출력.html> [5GiB 결과.json] [상주 결과.json] [추가 확인.json]",
);
const load = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const run = await load(path.join(shots, "results.json"));
assert.deepEqual(run.platforms, ["win32", "darwin"]);
const largeRun = largePath ? await load(largePath) : null;
const large = largeRun?.large;
const osLabel = { win32: "Windows", darwin: "Mac" };
const largeRoute =
  large?.sourceOS && large?.receiverOS && large.sourceOS !== large.receiverOS
    ? osLabel[large.sourceOS] + "에서 " + osLabel[large.receiverOS] + "로"
    : "Windows 시험 프로필 두 개 사이에서";
const residentRun = residentPath ? await load(residentPath) : null;
const resident = residentRun?.resident;
const extraChecks = extraPath ? await load(extraPath) : [];
assert.ok(
  Array.isArray(extraChecks) &&
    extraChecks.every((check) => typeof check === "string"),
);
const date = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "long",
  timeZone: "Asia/Seoul",
}).format((await fs.stat(path.join(shots, "results.json"))).mtime);
const h = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const groups = [
  [
    "devices",
    "홈과 기기",
    "홈에서 상대 기기의 이름을 누르면 그 기기의 클립보드와 공유 폴더를 열 수 있습니다.",
    [
      [
        "home-win",
        "Windows 홈",
        "Windows",
        "작업실 PC에서 같은 LAN의 스튜디오 Mac을 찾았습니다. 홈에서 내 기기와 연결된 기기를 구분할 수 있습니다.",
      ],
      [
        "home-other",
        "Mac 홈",
        "Mac",
        "Mac에서도 같은 구조로 Windows PC를 엽니다. 홈은 온라인 상태와 기기 이름을 보여 줍니다.",
      ],
    ],
  ],
  [
    "pairing",
    "처음 연결",
    "두 화면의 확인 코드를 비교하고 각각 한 번씩 확인합니다. 한쪽만 확인한 시점에는 등록 목록이 비어 있음을 검사했습니다.",
    [
      [
        "pair-a",
        "요청한 기기",
        "Windows",
        "기기 연결에서 Mac을 선택한 뒤 Windows에 표시된 화면입니다. 취소 후 새로 요청하면 확인 코드가 달라집니다.",
      ],
      [
        "pair-b",
        "요청받은 기기",
        "Mac",
        "Mac에도 같은 코드가 표시됐습니다. Mac과 Windows에서 각각 ‘코드가 같아요’를 누른 뒤 연결됐습니다.",
      ],
    ],
  ],
  [
    "clips",
    "클립보드 가져오기",
    "원본 기기에 최근 복사 항목을 모아 두고, 받는 사람이 고른 항목만 내 클립보드에 씁니다.",
    [
      [
        "history",
        "텍스트·서식",
        "Mac",
        "Windows에서 복사한 한글과 이모지를 Mac에서 선택했습니다. 목록만 보는 동안 Mac 클립보드는 그대로였고, 선택한 뒤 네이티브 편집 뷰에 붙여넣자 굵은 글씨와 이모지가 유지됐습니다.",
      ],
      [
        "image",
        "이미지",
        "Windows",
        "Mac에서 복사한 PNG가 미리보기로 보입니다. Windows에서 가져온 PNG를 원본과 바이트 단위로 대조했습니다.",
      ],
      [
        "settings",
        "기기별 보관 수",
        "Windows",
        "원본 기기의 설정에서 1~50건을 지정합니다. Windows에서 20건을 10건으로 줄인 뒤 재시작했고 최신 항목이 복원됐습니다. 다른 Mac에는 별도 한도를 적용했습니다.",
      ],
    ],
  ],
  [
    "files",
    "공유 폴더 가져오기",
    "Finder나 탐색기에서 내 전용 공유 폴더에 자료를 넣으면, 등록된 상대가 원하는 파일 또는 폴더를 선택해 저장할 수 있습니다.",
    [
      [
        "folder",
        "파일과 폴더",
        "Mac",
        "Mac에서 창을 닫아 둔 Windows 작업실 PC의 공유 폴더를 열었습니다. ‘폴더 열기’로 안을 살펴보거나 ‘가져오기’로 전체를 받을 수 있습니다.",
      ],
      [
        "subfolder",
        "하위 폴더",
        "Mac",
        "편집 원고 안의 빈 폴더와 본문 파일입니다. 폴더를 통째로 가져온 뒤 수신 경로에서 하위 파일의 내용을 확인했습니다.",
      ],
      [
        "jobs",
        "가져오기 완료",
        "Windows",
        "반대 방향으로 Mac의 답신.txt를 Windows에서 가져왔습니다. Mac 창은 전송 내내 숨겨져 있었고 수신 파일이 원본과 일치했습니다.",
      ],
    ],
  ],
  [
    "recovery",
    "오류와 잠금",
    "저장 위치가 사라지면 내역에서 오류 원인을 확인할 수 있습니다. 원본 기기를 잠그면 열어 둔 공유 화면의 내용도 사라집니다.",
    [
      [
        "error",
        "저장 위치 복구",
        "Mac",
        "Mac의 시험 수신 폴더를 옮겨 오류를 유도했습니다. 폴더를 복원하고 실패 항목을 재시도해 파일을 받았습니다. 별도 48 MiB 시험 디스크에서도 공간을 확보한 후 이어받았습니다.",
      ],
      [
        "lock",
        "잠금 상태",
        "Mac",
        "Windows 시험 앱에 OS 잠금 이벤트를 전달했습니다. Mac 화면의 미리보기가 닫혔고 파일 목록·기록·복사 요청이 모두 차단됐습니다.",
      ],
    ],
  ],
];
const style = `
:root {
  font-family:
    Inter, "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
  color: #15352a;
  background: #f7f8f2;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  line-height: 1.7;
  word-break: keep-all;
  overflow-wrap: anywhere;
}
a {
  color: inherit;
}
button {
  font: inherit;
  cursor: pointer;
}
button:focus-visible,
a:focus-visible {
  outline: 3px solid #bd762a;
  outline-offset: 3px;
}
.wrap {
  width: min(1130px, 92%);
  margin: auto;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-block: 13px;
}
.bar b {
  font-size: 19px;
}
.bar button,
.tabs button,
dialog button {
  border: 1px solid #bfccc0;
  border-radius: 6px;
  padding: 6px 12px;
  color: inherit;
  background: white;
  font-weight: 650;
}
.hero {
  background: #173e32;
  color: #f5faef;
  padding-block: 42px;
  border-bottom: 5px solid #a4c895;
}
.hero .wrap {
  display: grid;
  grid-template-columns: 0.85fr 1.1fr;
  align-items: center;
  gap: 45px;
}
.hero h1 {
  font-size: clamp(39px, 4.3vw, 64px);
  line-height: 1.17;
  letter-spacing: -0.065em;
  margin: 8px 0 14px;
}
.hero .sub {
  font-size: 17px;
  color: #e1ebd9;
}
.meta {
  font-size: 13px;
  color: #cee3be;
  font-weight: 650;
}
.hero img {
  width: 100%;
  height: auto;
  border: 6px solid #aec9b5;
  border-radius: 9px;
  display: block;
}
.body-grid {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  gap: 45px;
  padding-block: 48px;
}
.rail {
  position: sticky;
  top: 16px;
  align-self: start;
}
.rail strong {
  font-size: 13px;
}
.rail a {
  display: block;
  text-decoration: none;
  border-left: 2px solid #cdd9ce;
  padding: 6px 11px;
  font-size: 14px;
}
.rail a:hover {
  background: #e6eee4;
}
.chapter {
  padding-bottom: 32px;
  margin-bottom: 38px;
  border-bottom: 1px solid #cad7cb;
  scroll-margin-top: 20px;
}
h2 {
  margin: 0 0 7px;
  font-size: clamp(24px, 2.5vw, 34px);
  letter-spacing: -0.05em;
}
.desc {
  margin: 0 0 15px;
  color: #465d50;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}
.tabs button[aria-selected="true"] {
  background: #23573e;
  color: #fff;
}
.panel {
  background: white;
  border: 1px solid #c4d2c4;
  border-radius: 9px;
  overflow: hidden;
  margin: 0;
}
.canvas {
  padding: clamp(8px, 2vw, 22px);
  background: #e6ede4;
  text-align: center;
}
.zoom-button {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: zoom-in;
  max-width: 100%;
  line-height: 0;
}
.canvas img {
  max-width: 100%;
  max-height: 440px;
  height: auto;
  width: auto;
}
.panel figcaption {
  padding: 13px 18px;
}
.panel figcaption strong {
  display: block;
}
.panel figcaption p {
  margin: 3px 0;
  color: #4b6055;
  font-size: 14px;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin-block: 14px;
}
th,
td {
  border-bottom: 1px solid #cbd6c9;
  text-align: left;
  padding: 7px 9px;
}
th {
  background: #e5ece0;
}
.scope {
  border-left: 3px solid #85a879;
  padding-left: 14px;
  color: #41594b;
}
.end {
  border-top: 1px solid #ccd7c9;
  padding: 15px 0;
  margin-top: 24px;
  font-size: 13px;
}
dialog {
  padding: 12px;
  border: 1px solid #819985;
  border-radius: 8px;
  max-width: 96vw;
  max-height: 94vh;
  color: inherit;
}
dialog button {
  display: block;
  margin: 0 0 8px auto;
}
dialog img {
  max-width: 90vw;
  max-height: 78vh;
}
dialog::backdrop {
  background: #102820d9;
}
[hidden] {
  display: none !important;
}
@media (max-width: 760px) {
  .hero .wrap,
  .body-grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .rail {
    position: static;
  }
  .rail a {
    display: inline-block;
    padding: 3px 7px;
  }
  .hero {
    padding-block: 25px;
  }
  .body-grid {
    padding-block: 22px;
  }
  .panel figcaption {
    padding: 10px;
  }
  .metrics {
    overflow-x: auto;
  }
  th,
  td {
    padding: 5px;
    font-size: 13px;
  }
}
@media print {
  .rail,
  .tabs,
  .bar button,
  dialog {
    display: none !important;
  }
  .body-grid,
  .hero .wrap {
    display: block;
  }
  .hero {
    color: #152f22;
    background: white;
    padding: 0;
  }
  .hero .sub,
  .meta {
    color: #34523f;
  }
  .hero figure {
    display: none;
  }
  .hero h1 {
    font-size: 32px;
  }
  .wrap {
    width: 100%;
  }
  .panel[hidden],
  .panel {
    display: block !important;
    break-inside: avoid;
    margin: 10px 0;
  }
  .canvas img {
    max-height: 220px;
  }
  .canvas {
    padding: 4px;
  }
  .chapter {
    padding-bottom: 12px;
    margin-bottom: 15px;
  }
}
`;
const cache = new Map();
async function picture(id, label) {
  if (!cache.has(id))
    cache.set(
      id,
      (await fs.readFile(path.join(shots, id + ".png"))).toString("base64"),
    );
  return (
    '<button class="zoom-button" aria-label="' +
    h(label) +
    ' 확대"><img src="data:image/png;base64,' +
    cache.get(id) +
    '" alt="' +
    h(label) +
    '"></button>'
  );
}
const chapters = [];
for (const [id, title, desc, steps] of groups) {
  const tabs = [],
    panels = [];
  for (const [i, [file, label, os, detail]] of steps.entries()) {
    const k = id + "-" + i;
    tabs.push(
      '<button id="tab-' +
        k +
        '" role="tab" aria-controls="p-' +
        k +
        '" aria-selected="' +
        !i +
        '">' +
        h(label) +
        "</button>",
    );
    panels.push(
      '<div id="p-' +
        k +
        '" role="tabpanel" aria-labelledby="tab-' +
        k +
        '" class="panel"><figure style="margin:0"><div class="canvas">' +
        (await picture(file, label + " · " + os)) +
        "</div><figcaption><strong>" +
        h(label + " · " + os) +
        "</strong><p>" +
        h(detail) +
        "</p></figcaption></figure></div>",
    );
  }
  chapters.push(
    '<section class="chapter" id="' +
      id +
      '"><h2>' +
      h(title) +
      '</h2><p class="desc">' +
      h(desc) +
      '</p><div class="tabs" role="tablist" aria-label="' +
      h(title) +
      '">' +
      tabs.join("") +
      "</div>" +
      panels.join("") +
      "</section>",
  );
}
const t = run.timings;
const timings =
  '<div class="metrics"><table><thead><tr><th>조회하는 기기</th><th>최근 10건</th><th>파일 1,000개 중 첫 60개</th></tr></thead><tbody><tr><td>Mac에서 Windows 열기</td><td>' +
  t.historyP95 +
  " ms</td><td>" +
  t.folderP95 +
  " ms</td></tr><tr><td>Windows에서 Mac 열기</td><td>" +
  t.reverseHistoryP95 +
  " ms</td><td>" +
  t.reverseFolderP95 +
  " ms</td></tr></tbody></table></div>";
function enableReportControls() {
  for (const group of document.querySelectorAll(".tabs")) {
    const tabs = [...group.querySelectorAll('[role="tab"]')];
    function select(index) {
      tabs.forEach((tab, position) => {
        const active = index === position;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden =
          !active;
      });
    }
    select(0);
    tabs.forEach((tab, index) => {
      tab.onclick = () => select(index);
      tab.onkeydown = (event) => {
        const target = {
          ArrowRight: (index + 1) % tabs.length,
          ArrowLeft: (index + tabs.length - 1) % tabs.length,
          Home: 0,
          End: tabs.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        select(target);
        tabs[target].focus();
      };
    });
  }
  const dialog = document.querySelector("dialog");
  for (const button of document.querySelectorAll(".zoom-button")) {
    button.onclick = () => {
      const source = button.querySelector("img");
      const enlarged = dialog.querySelector("img");
      enlarged.src = source.src;
      enlarged.alt = source.alt;
      dialog.showModal();
    };
  }
  dialog.querySelector("button").onclick = () => dialog.close();
  document.querySelector("#print").onclick = () => window.print();
}
const javascript = "(" + enableReportControls.toString() + ")();";
const soak = resident
  ? "<p><b>" +
    h(residentRun.version || "0.2.0-dev") +
    " 상주 측정</b> · 창을 닫은 두 기기를 5초마다 20분 관찰했습니다. 첫 1분과 마지막 1분의 메모리 중앙값 차이와 논리 코어 하나 기준 평균 CPU입니다. 기준은 CPU 2% 이하, 메모리 증가 32 MiB 이하입니다.</p><table><tr><th>기기</th><th>표본</th><th>유휴 CPU</th><th>메모리 변화</th></tr>" +
    resident
      .map(
        (v, i) =>
          "<tr><td>" +
          ["Windows", "Mac"][i] +
          "</td><td>" +
          v.samples +
          "</td><td>" +
          v.cpuPercent.toFixed(2) +
          "%</td><td>" +
          v.memoryDeltaMiB.toFixed(2) +
          " MiB</td></tr>",
      )
      .join("") +
    "</table>"
  : "";
const html =
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sync Vault · 기기별 가져오기</title><style>' +
  style +
  '</style></head><body><header class="wrap bar"><b>Sync Vault</b><button id="print">전체 인쇄</button></header><main><section class="hero"><div class="wrap"><div><div class="meta">' +
  h(run.version || "0.2.0-dev") +
  " · " +
  h(date) +
  '</div><h1>기기별 공유 공간</h1><p class="sub">홈에서 상대 기기를 열고 필요한 클립보드 기록이나 파일을 가져옵니다.</p><div class="meta">Windows 11 × macOS · 실제 앱 화면 ' +
  cache.size +
  '장</div></div><figure style="margin:0">' +
  (await picture("home-win", "Windows 홈 화면")) +
  '</figure></div></section><div class="body-grid wrap"><nav class="rail" aria-label="보고서 목차"><strong>기능별 화면</strong>' +
  groups.map((g) => '<a href="#' + g[0] + '">' + h(g[1]) + "</a>").join("") +
  '<a href="#checks">검증과 측정</a></nav><div>' +
  chapters.join("") +
  '<section id="checks"><h2>검증과 측정</h2><p>같은 LAN에서 각 방향을 20회 측정했습니다. 표의 값은 앱에서 목록 요청을 시작해 응답을 받을 때까지의 95백분위 시간입니다. 목표는 1초 이내입니다.</p>' +
  timings +
  soak +
  (large
    ? "<p><b>" +
      h(largeRun.version || "0.2.0-dev") +
      " 대용량 시험</b> · " +
      h(largeRoute) +
      " 5 GiB 파일을 가져오던 중 " +
      (large.interruptedAt / 1024 ** 3).toFixed(2) +
      " GiB 지점에서 원본 앱을 재시작했습니다. 완료 후 SHA-256이 일치했습니다. <code>" +
      h(large.sha256.slice(0, 16)) +
      "…</code></p>"
    : "") +
  "<ul>" +
  [...run.checks, ...extraChecks].map((c) => "<li>" + h(c) + "</li>").join("") +
  '</ul><p class="scope">별도 앱 프로필과 OS 시험용 클립보드를 사용했습니다. Mac 시험은 모의 키체인을 썼습니다. 잠금 검증은 두 실기기에서 앱에 OS 잠금 이벤트를 전달해 진행했습니다. 전용 QA 계정의 실제 잠금·해제와 로그아웃·재로그인은 미확인입니다.</p></section></div></div></main><footer class="wrap end">Sync Vault · Windows x64 / Mac ARM64</footer><dialog aria-label="화면 확대"><button>닫기</button><img alt=""></dialog><script>' +
  javascript +
  "</script></body></html>";
await fs.writeFile(output, html);
console.log(cache.size + "장의 화면을 " + output + "에 저장했습니다.");

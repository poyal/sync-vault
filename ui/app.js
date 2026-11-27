const api = window.vault,
  $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let model,
  page = "devices",
  dirty = false,
  localError = "",
  loading = false,
  again = false;
const button = (title, action, value = "", cls = "") =>
  '<button class="' +
  cls +
  '" data-action="' +
  esc(action) +
  '" data-value="' +
  esc(value) +
  '">' +
  esc(title) +
  "</button>";
const empty = (s) => '<div class="empty">' + esc(s) + "</div>";
const row = (name, detail, tools = "") =>
  '<article class="panel row"><div><strong>' +
  esc(name) +
  "</strong><small>" +
  esc(detail) +
  '</small></div><div class="tools">' +
  tools +
  "</div></article>";
const size = (b) =>
  b >= 1073741824
    ? (b / 1073741824).toFixed(2) + " GiB"
    : b >= 1048576
      ? (b / 1048576).toFixed(1) + " MiB"
      : b >= 1024
        ? Math.round(b / 1024) + " KiB"
        : b + " B";
async function call(action, v) {
  try {
    const r = await api.call(action, v);
    localError = "";
    return r;
  } catch (e) {
    localError = String(e.message).replace(/^.*?Error: /, "");
    return null;
  } finally {
    void refresh();
  }
}
async function refresh() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    model = await api.call("state");
    render();
  } catch (e) {
    localError = e.message;
  } finally {
    loading = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}
function nav(p) {
  page = p;
  document
    .querySelectorAll("main section")
    .forEach((s) => (s.hidden = s.id !== p));
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.page === p));
  if (model) render();
}
function render() {
  const m = model,
    el = $("#notice"),
    n = localError || m.notice;
  el.hidden = !n;
  document.title = m.product;
  $("#brand").textContent = m.product;
  el.innerHTML = n ? button("닫기", "dismiss") + esc(n) : "";
  $("#selfname").textContent = m.settings.name;
  $("#myip").textContent = m.local.address
    ? m.local.address + ":" + m.local.port
    : "연결 대기";
  if (page === "devices") {
    $("#registered").innerHTML =
      m.peers
        .map((p) =>
          row(
            p.name,
            (p.online
              ? p.compatible
                ? "연결됨"
                : "버전 확인 필요"
              : "오프라인") +
              " · " +
              p.endpoint.address +
              (p.version ? " · v" + p.version : "") +
              (p.seen
                ? " · 마지막 연결 " + new Date(p.seen).toLocaleTimeString("ko")
                : ""),
            button(
              p.autoAccept ? "자동 수락 켜짐" : "파일마다 수락",
              "autoaccept",
              p.id,
            ) + button("해제", "forget", p.id),
          ),
        )
        .join("") ||
      empty(
        "등록한 기기가 없습니다. 다른 컴퓨터에서도 Sync Vault를 열고 아래에서 등록하세요.",
      );
    $("#nearby").innerHTML =
      m.nearby
        .map((p) =>
          row(
            p.name,
            p.endpoint.address + ":" + p.endpoint.port,
            button(
              "등록",
              "pair",
              p.endpoint.address + ":" + p.endpoint.port,
              "primary",
            ),
          ),
        )
        .join("") || empty("주변에서 새 기기를 기다리고 있습니다.");
    $("#pending").innerHTML = m.pending
      .map((p) =>
        row(
          p.name + "의 등록 요청",
          "양쪽 확인값을 대조하세요 · " + p.code,
          button("승인", "approve", p.id, "primary") +
            button("거절", "deny", p.id),
        ),
      )
      .join("");
    $("#diagnostic").textContent = [
      m.diagnostic,
      "발견 " + m.nearby.length + "대",
      "등록 " + m.peers.length + "대",
      "연결 " + m.peers.filter((p) => p.online).length + "대",
    ].join(" · ");
  }
  if (page === "transfers") {
    $("#selection").innerHTML = m.pick.length
      ? row(
          m.pick.slice(0, 3).join(", ") +
            (m.pick.length > 3 ? " 외 " + (m.pick.length - 3) + "개" : ""),
          m.preparing ? "원본 해시 확인 중" : "받을 기기를 선택하세요.",
          m.peers
            .map((p) => button(p.name + "에 보내기", "send", p.id, "primary"))
            .join("") + button("비우기", "clear"),
        )
      : "";
    $("#jobs").innerHTML =
      m.jobs
        .map(
          (j) =>
            '<article class="panel"><div class="row"><strong>' +
            esc(j.name) +
            (j.count > 1 ? " 외 " + (j.count - 1) + "개" : "") +
            '</strong><span class="badge">' +
            esc(j.direction + " · " + j.state) +
            "</span></div><small>" +
            esc(
              (m.peers.find((p) => p.id === j.peer)?.name ||
                "등록 해제된 기기") +
                " · " +
                (j.done === undefined ? "" : size(j.done) + " / ") +
                size(j.total),
            ) +
            "</small>" +
            (j.total && j.done !== undefined
              ? '<progress max="' +
                Number(j.total) +
                '" value="' +
                Number(j.done) +
                '"></progress>'
              : "") +
            '<div class="tools">' +
            (j.direction === "받음" && j.state === "승인 대기"
              ? button("수락", "accept", j.id, "primary")
              : "") +
            (j.direction === "보냄" && ["오류", "재연결 대기"].includes(j.state)
              ? button("실패 항목 재시도", "retry", j.id)
              : "") +
            (!["완료", "취소"].includes(j.state)
              ? button("취소", "cancel", j.id)
              : "") +
            (j.direction === "받음" && j.state === "완료"
              ? button("저장 위치 열기", "open", j.id)
              : "") +
            "</div>" +
            esc(j.error) +
            "</article>",
        )
        .join("") || empty("아직 주고받은 파일이 없습니다.");
  }
  if (page === "settings") {
    const f = $("#prefs").elements;
    if (!dirty) {
      for (const k of ["name", "receive", "smallCount"])
        f[k].value = m.settings[k];
      f.mib.value = m.settings.smallBytes / 1048576;
      f.adapter.innerHTML =
        '<option value="">자동 선택</option>' +
        m.adapters
          .map(
            (a) =>
              '<option value="' +
              esc(a.name) +
              '">' +
              esc(a.name + " · " + a.address) +
              "</option>",
          )
          .join("");
      f.adapter.value = m.settings.adapter;
      for (const k of ["login", "updates", "text", "image", "files", "paused"])
        f[k].checked = m.settings[k];
    }
    $("#release-location").textContent =
      m.settings.releaseFolder || "배포 중지됨";
    const u = m.update;
    f.updates.disabled = m.development;
    $("#release-location").closest("details").hidden = m.development;
    if (m.development) {
      $("#update").textContent = "개발판은 새 개발 설치본으로 갱신하세요.";
      return;
    }
    $("#update").innerHTML =
      "<strong>Sync Vault " +
      esc(m.version) +
      "</strong><p>" +
      esc(u.status) +
      (u.next ? " · " + esc(u.next) : "") +
      (u.later ? " · 전송 완료 후 적용 예정" : "") +
      "</p><small>" +
      esc(u.notes) +
      '</small><div class="tools">' +
      button("지금 확인", "check") +
      (u.status === "다운로드 가능" || u.status.startsWith("다운로드 중단")
        ? button("다운로드", "download")
        : "") +
      (u.status === "다운로드 중"
        ? button("다운로드 취소 (" + u.percent + "%)", "cancel-update")
        : "") +
      (u.ready
        ? button("전송 완료 후 설치", "update-later") +
          button("지금 재시작", "update-now")
        : "") +
      "</div>";
  }
}
async function pairAt(value) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value.trim());
  if (!m) {
    localError = "기기에 표시된 IP:포트를 입력하세요.";
    render();
    return;
  }
  await call("pair", { address: m[1], port: Number(m[2]) });
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.page) {
    nav(b.dataset.page);
    return;
  }
  const a = b.dataset.action,
    v = b.dataset.value;
  if (!a) return;
  if (a === "dismiss") {
    localError = "";
    await call(a);
    return;
  }
  if (a === "pair") {
    await pairAt(v);
    return;
  }
  if (a === "autoaccept") {
    const p = model.peers.find((p) => p.id === v);
    await call(a, { id: v, value: !p.autoAccept });
    return;
  }
  if (["retry", "accept", "cancel", "open"].includes(a)) {
    await call("job", { id: v, op: a });
    return;
  }
  if (a === "defaults") dirty = false;
  b.disabled = true;
  try {
    await call(a, v);
  } finally {
    b.disabled = false;
  }
});
$("#connect").onsubmit = (e) => {
  e.preventDefault();
  void pairAt($("#endpoint").value);
};
$("#prefs").oninput = () => (dirty = true);
$("#prefs").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements,
    s = {
      name: f.name.value,
      receive: f.receive.value,
      adapter: f.adapter.value,
      smallCount: Number(f.smallCount.value),
      smallBytes: Number(f.mib.value) * 1048576,
    };
  for (const k of ["login", "updates", "text", "image", "files", "paused"])
    s[k] = f[k].checked;
  const saved = await call("settings", s);
  if (saved !== null) {
    dirty = false;
    void refresh();
  }
};
$("#choose-folder").onclick = async () => {
  const folder = await call("folder");
  if (folder) {
    dirty = true;
    $("#prefs").elements.receive.value = folder;
  }
};
const zone = $("#dropzone");
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());
zone.ondragover = (e) => {
  e.preventDefault();
  zone.classList.add("hover");
};
zone.ondragleave = () => zone.classList.remove("hover");
zone.ondrop = async (e) => {
  e.preventDefault();
  zone.classList.remove("hover");
  try {
    await api.drop([...e.dataTransfer.files]);
  } catch (err) {
    localError = err.message;
  }
  await refresh();
};
$("#release-folder").onclick = async () => {
  const folder = await call("folder");
  if (folder) await call("settings", { releaseFolder: folder });
};
$("#release-off").onclick = () => call("settings", { releaseFolder: "" });
api.listen(refresh);
api.onRequest(async ({ page, id }) => {
  if (!["devices", "transfers"].includes(page)) return;
  nav(page);
  await refresh();
  const action = page === "devices" ? "approve" : "accept";
  const target = document.querySelector('[data-action="' + action + '"][data-value="' + CSS.escape(id) + '"]');
  target?.scrollIntoView({ block: "center" });
  target?.closest("article")?.setAttribute("tabindex", "-1");
  target?.closest("article")?.focus({ preventScroll: true });
});
void refresh();

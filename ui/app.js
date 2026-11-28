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
  page = "home",
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
  if (page !== p) localError = "";
  if (p !== "room") clearRoom();
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
  if (page === "home") renderHome(m);
  if (page === "room") renderRoom(m);
  if (page === "devices") {
    $("#outbound").innerHTML = m.outbound ? pairing(m.outbound, true) : "";
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
            button("열기", "enter", p.id) + button("해제", "forget", p.id),
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
    $("#pending").innerHTML = m.pending.map((p) => pairing(p, false)).join("");
    $("#diagnostic").textContent = [
      m.diagnostic,
      "발견 " + m.nearby.length + "대",
      "등록 " + m.peers.length + "대",
      "연결 " + m.peers.filter((p) => p.online).length + "대",
    ].join(" · ");
  }
  if (page === "transfers") {
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
            (j.item && ["오류", "재연결 대기"].includes(j.state)
              ? button("실패 항목 재시도", "retry", j.id)
              : "") +
            (!["완료", "취소"].includes(j.state)
              ? button("취소", "cancel", j.id)
              : "") +
            (j.direction === "받음" && j.state === "완료"
              ? button("저장 위치 열기", "open", j.id)
              : "") +
            "</div>" +
            (j.location ? "<small>" + esc(j.location) + "</small>" : "") +
            esc(j.error) +
            "</article>",
        )
        .join("") || empty("아직 주고받은 파일이 없습니다.");
  }
  if (page === "settings") {
    const f = $("#prefs").elements;
    if (!dirty) {
      for (const k of ["name", "receive", "historyLimit"])
        f[k].value = m.settings[k];
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
      for (const k of ["login", "text", "image", "paused"])
        f[k].checked = m.settings[k];
    }
  }
  if (page === "about") {
    const u = m.update;
    $("#about-product").textContent = m.product;
    $("#about-version").textContent = "현재 버전 " + m.version;
    $("#dev-update").hidden = !m.development;
    $("#stable-update").hidden = m.development;
    if (m.development) return;
    $("#auto-update").checked = m.settings.updates;
    $("#update-interval").value = String(m.settings.updateCheckIntervalHours);
    $("#update-interval").disabled = !m.settings.updates;
    $("#update-checked").textContent = u.checkedAt
      ? "마지막 확인 " + new Date(u.checkedAt).toLocaleString("ko-KR")
      : "아직 확인하지 않았습니다.";
    const downloading = u.status === "다운로드 중";
    const retry = u.status === "다운로드 취소됨" || u.status.startsWith("다운로드 중단");
    const status = u.status === "대기" ? "GitHub에서 새 정식 버전을 확인할 수 있습니다." : u.status;
    $("#update-status").textContent = [
      status, u.next && "공개 버전 " + u.next,
      downloading && u.percent + "%", u.later && "전송 완료 후 설치 예정",
    ].filter(Boolean).join(" · ");
    $("#update-notes").textContent = u.notes;
    $("#update-notes").hidden = !u.notes;
    $("#update-progress").hidden = !downloading;
    $("#update-progress").value = u.percent;
    const check = $('#update [data-action="check"]');
    check.disabled = u.busy || u.ready;
    check.textContent = u.status === "버전 확인 중" ? "확인 중…" : "지금 확인";
    const download = $('#update [data-action="download"]');
    download.hidden = u.status !== "다운로드 가능" && !retry;
    download.textContent = retry ? "다시 다운로드" : "다운로드";
    $('#update [data-value="installer"]').hidden = !u.hasInstaller;
    $('#update [data-value="notes"]').hidden = !u.hasReleasePage;
    const manual = $("#manual-install");
    manual.hidden = !u.hasInstaller;
    if (u.hasInstaller) manual.textContent = m.local.os === "darwin"
      ? "메뉴 막대에서 Sync Vault를 종료한 뒤 DMG의 앱을 응용 프로그램 폴더에 대치하세요."
      : "트레이에서 Sync Vault를 종료한 뒤 받은 EXE를 실행하세요.";
    $('#update [data-action="cancel-update"]').hidden = !downloading;
    $('#update [data-action="update-later"]').hidden = !u.ready || u.later;
    $('#update [data-action="update-now"]').hidden = !u.ready;
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
  if (await roomAction(a, v, b)) return;
  if (a === "approve" || a === "deny") {
    const p = model.pending.find((p) => p.id === v);
    if (p) await call(a, { id: v, attempt: b.dataset.attempt });
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
      historyLimit: Number(f.historyLimit.value),
    };
  for (const k of ["login", "text", "image", "paused"])
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
$("#auto-update").onchange = (e) => call("settings", { updates: e.target.checked });
const interval = $("#update-interval");
for (let hours = 1; hours <= 24; hours++) interval.add(new Option(hours + "시간마다", String(hours)));
interval.onchange = () => call("settings", { updateCheckIntervalHours: Number(interval.value) });
api.listen(refresh);
api.onPrivacy((peer) => {
  if (page === "room" && (!peer || peer === roomPeer)) {
    clearRoom();
    $("#room-tools").replaceChildren();
    void refresh();
  }
});
api.onRequest(async ({ page, id }) => {
  if (!["devices", "transfers"].includes(page)) return;
  nav(page);
  await refresh();
  const action = page === "devices" ? "approve" : "accept";
  const target = document.querySelector(
    '[data-action="' + action + '"][data-value="' + CSS.escape(id) + '"]',
  );
  target?.scrollIntoView({ block: "center" });
  target?.closest("article")?.setAttribute("tabindex", "-1");
  target?.closest("article")?.focus({ preventScroll: true });
});
void refresh();

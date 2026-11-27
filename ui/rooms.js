let roomPeer = "",
  roomTab = "history",
  crumbs = [],
  roomRows = [],
  nextPage = null;
let roomEpoch = 0,
  fetched = 0,
  fetching = false,
  roomMessage = "";
function clearRoom() {
  ++roomEpoch;
  roomRows = [];
  nextPage = null;
  roomMessage = "";
  fetched = 0;
  fetching = false;
  const items = document.getElementById("room-items");
  if (items) items.replaceChildren();
}
const osName = (os) =>
  ({ win32: "Windows", darwin: "Mac" })[os] || "기기 정보 대기";
const stateName = (p) =>
  !p.online
    ? "오프라인"
    : !p.compatible
      ? "상대 앱 업데이트 필요"
      : p.locked
        ? "잠김"
        : "온라인";
function pairing(p, out) {
  const controls = out
    ? (p.confirmed
        ? ""
        : button("코드가 같아요", "pair-confirm", p.attempt, "primary")) +
      button("취소", "pair-cancel", p.attempt)
    : (p.confirmed
        ? ""
        : '<button class="primary" data-action="approve" data-value="' +
          esc(p.id) +
          '" data-attempt="' +
          esc(p.attempt) +
          '">코드가 같아요</button>') +
      '<button data-action="deny" data-value="' +
      esc(p.id) +
      '" data-attempt="' +
      esc(p.attempt) +
      '">취소</button>';
  return (
    '<article class="pair-card"><strong>' +
    esc(p.name) +
    "</strong><p>" +
    (p.confirmed
      ? "상대 기기 확인 대기 중"
      : "두 화면의 코드가 같은지 확인하세요.") +
    '</p><div class="pair-code">' +
    esc(p.code) +
    '</div><div class="tools">' +
    controls +
    "</div></article>"
  );
}
function deviceCard(id, name, os, status, local = false) {
  return (
    '<button class="device-card ' +
    (local ? "local-device" : "") +
    '" data-action="enter" data-value="' +
    esc(id) +
    '"><span class="computer" aria-hidden="true"></span><span class="device-copy"><small>' +
    esc(osName(os)) +
    "</small><strong>" +
    esc(name) +
    "</strong><small>" +
    esc(status) +
    '</small></span><span class="chevron" aria-hidden="true">›</span></button>'
  );
}
function renderHome(m) {
  $("#home-requests").innerHTML = m.pending.length
    ? row(
        "기기 연결 요청",
        m.pending.map((p) => p.name).join(", "),
        '<button data-page="devices">코드 확인</button>',
      )
    : "";
  $("#local-card").innerHTML = deviceCard(
    m.local.id,
    m.settings.name,
    m.local.os,
    m.locked ? "잠김" : "내 공유 공간",
    true,
  );
  $("#peer-cards").innerHTML =
    [...new Set(m.peers.map((p) => osName(p.os)))]
      .map(
        (os) =>
          '<div class="device-group"><h3>' +
          esc(os) +
          '</h3><div class="cards">' +
          m.peers
            .filter((p) => osName(p.os) === os)
            .map((p) =>
              deviceCard(
                p.id,
                p.name,
                p.os,
                stateName(p) +
                  (p.online || !p.seen
                    ? ""
                    : " · " + new Date(p.seen).toLocaleString("ko")),
              ),
            )
            .join("") +
          "</div></div>",
      )
      .join("") ||
    empty("연결한 기기가 없습니다. 기기 연결에서 주변 기기를 찾아보세요.");
}
function blocked(m) {
  if (m.locked) return "이 기기의 화면이 잠겼습니다.";
  if (roomPeer === m.local.id) return "";
  const p = m.peers.find((p) => p.id === roomPeer);
  if (!p) return "등록이 해제된 기기입니다.";
  return stateName(p) === "온라인" ? "" : stateName(p);
}
async function fetchRoom(more = false) {
  if (page !== "room" || document.hidden || fetching || blocked(model)) return;
  const rev = roomEpoch;
  fetching = true;
  try {
    const folder = roomTab === "folder";
    const result = await api.call(folder ? "vault-list" : "vault-history", {
      peer: roomPeer,
      id: crumbs.at(-1)?.id || "",
      offset: more ? nextPage : 0,
    });
    if (rev !== roomEpoch || page !== "room" || blocked(model)) return;
    roomRows = folder
      ? more
        ? roomRows.concat(result.rows)
        : result.rows
      : result;
    nextPage = folder ? result.next : null;
    roomMessage = "";
  } catch (e) {
    if (rev === roomEpoch) {
      roomRows = [];
      nextPage = null;
      roomMessage = String(e.message).replace(/^.*?Error: /, "");
    }
  } finally {
    if (rev === roomEpoch) {
      fetching = false;
      fetched = Date.now();
      if (page === "room") drawRoom();
    }
  }
}
function drawRoom() {
  const mine = roomPeer === model.local.id,
    folder = roomTab === "folder",
    error = blocked(model);
  const text = error || roomMessage;
  $("#room-items").innerHTML = text
    ? empty(text)
    : roomRows
        .map((r) => {
          if (folder)
            return row(
              r.name,
              r.dir ? "폴더" : size(r.size),
              (r.dir ? button("폴더 열기", "dir", r.id) : "") +
                (!mine ? button("가져오기", "get-item", r.id, "primary") : ""),
            );
          const preview = row(
            r.preview || "서식 있는 텍스트",
            (r.kind === "image" ? "이미지" : "텍스트") +
              " · " +
              new Date(r.time).toLocaleString("ko"),
            button("내 클립보드에 복사", "copy-item", r.id, "primary") +
              (mine ? button("삭제", "delete-item", r.id) : ""),
          );
          return r.thumb
            ? preview.replace(
                "<strong>",
                '<img class="clip-thumb" alt="클립보드 이미지 미리보기" src="data:image/png;base64,' +
                  esc(r.thumb) +
                  '"><strong>',
              )
            : preview;
        })
        .join("") + (nextPage !== null ? button("더 보기", "more") : "") ||
      empty(
        fetching
          ? "불러오는 중…"
          : folder
            ? "이 폴더는 비어 있습니다."
            : "공개된 클립보드 기록이 없습니다.",
      );
  $("#room-tools").innerHTML = error
    ? ""
    : folder
      ? '<div class="row"><strong>' +
        esc(["공유 폴더", ...crumbs.map((c) => c.name)].join(" / ")) +
        '</strong><div class="tools">' +
        (crumbs.length ? button("상위 폴더", "up-dir") : "") +
        (mine ? button("폴더 위치 열기", "shelf-open") : "") +
        "</div></div>"
      : mine
        ? '<div class="row"><span>최근 ' +
          model.settings.historyLimit +
          "건 · " +
          (model.settings.paused ? "기록 일시 중지" : "기록 공유 중") +
          '</span><div class="tools">' +
          button(
            model.settings.paused ? "기록 공유 켜기" : "일시 중지",
            "toggle-history",
          ) +
          button("기록 수 설정", "limit-settings") +
          (roomRows.length ? button("기록 비우기", "clear-history") : "") +
          "</div></div>"
        : "";
}
function renderRoom(m) {
  const p = m.peers.find((p) => p.id === roomPeer),
    mine = roomPeer === m.local.id;
  $("#room-name").textContent = mine ? m.settings.name : p?.name || "기기";
  $("#room-os").textContent =
    (mine ? "이 기기" : "등록한 기기") +
    " · " +
    osName(mine ? m.local.os : p?.os);
  for (const b of document.querySelectorAll(".switch button"))
    b.setAttribute("aria-pressed", String(b.dataset.value === roomTab));
  if (blocked(m)) {
    if (roomRows.length || fetching || fetched) clearRoom();
    drawRoom();
    return;
  }
  drawRoom();
  if (!fetched) void fetchRoom();
}
async function roomAction(a, v, b) {
  if (a === "enter") {
    clearRoom();
    roomPeer = v;
    roomTab = "history";
    crumbs = [];
    nav("room");
    return true;
  }
  if (a === "tab" || a === "reload-room" || a === "dir" || a === "up-dir") {
    if (a === "tab") {
      roomTab = v;
      crumbs = [];
    }
    if (a === "dir") {
      const item = roomRows.find((r) => r.id === v);
      if (!item) return true;
      crumbs.push(item);
    }
    if (a === "up-dir") crumbs.pop();
    clearRoom();
    renderRoom(model);
    return true;
  }
  if (a === "more") {
    await fetchRoom(true);
    return true;
  }
  if (a === "limit-settings") {
    nav("settings");
    $("#prefs").elements.historyLimit.focus();
    return true;
  }
  if (a === "get-item" || a === "copy-item") {
    const item = roomRows.find((r) => r.id === v);
    if (!item) return true;
    b.disabled = true;
    const result = await call(a === "get-item" ? "vault-get" : "vault-copy", {
      peer: roomPeer,
      id: v,
      name: item.name,
    });
    if (result !== null) {
      if (a === "get-item") nav("transfers");
      else {
        localError = "내 클립보드에 복사했습니다.";
        render();
      }
    }
    b.disabled = false;
    return true;
  }
  if (a === "delete-item" || a === "clear-history" || a === "toggle-history") {
    if (
      a === "clear-history" &&
      !window.confirm("이 기기의 클립보드 기록을 모두 비울까요?")
    )
      return true;
    if (a === "toggle-history")
      await call("settings", { paused: !model.settings.paused });
    else
      await call(a === "delete-item" ? "history-delete" : "history-clear", v);
    clearRoom();
    await refresh();
    return true;
  }
  return false;
}
document.addEventListener("visibilitychange", () => {
  if (page === "room") {
    clearRoom();
    if (!document.hidden) void refresh();
  }
});
setInterval(() => {
  if (
    page === "room" &&
    !document.hidden &&
    !fetching &&
    Date.now() - fetched > 3000 &&
    roomRows.length <= 60
  )
    void fetchRoom();
}, 3000);

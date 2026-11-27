import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createIdentity, identitySchema } from "./identity";
import { Store, defaults, settingsSchema, writable, volumeRoot } from "./store";
import { Lan } from "./lan";
import { readJSON } from "./network";
import { Clips } from "./clipboard";
import { Receiver } from "./files";
import { releasesPage } from "./github-release";
import { Updater } from "./update";
import { History } from "./history";
import { Shelf, inside } from "./shelf";
import { Vault } from "./vault";
import { development, product } from "./channel";
const loginFlag = "--sync-vault-login";
const loginOptions = process.platform === "win32" ? { args: [loginFlag] } : {};
const testHome = !app.isPackaged ? process.env.SYNC_VAULT_TEST_HOME : undefined;
if (testHome) app.setPath("userData", path.resolve(testHome));
app.setName(product);
if (process.platform === "win32")
  app.setAppUserModelId(
    development ? "io.syncvault.desktop.dev" : "io.syncvault.desktop",
  );
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, args) => {
    if (!args.includes(loginFlag)) show();
  });
  app
    .whenReady()
    .then(initialize)
    .catch(async (e) => {
      await dialog.showMessageBox({
        type: "error",
        title: product,
        message: String(e.message),
      });
      app.exit(1);
    });
}
let win: BrowserWindow | undefined,
  tray: Tray | undefined,
  store: Store,
  lan: Lan,
  clips: Clips,
  rx: Receiver,
  vault: Vault,
  up: Updater;
let quitting = false,
  updating = false,
  updateLater = false,
  notice = "",
  outbound:
    | {
        id: string;
        name: string;
        code: string;
        confirmed: boolean;
        attempt?: string;
      }
    | undefined,
  pair: AbortController | undefined;
let nextPrune = 0;
let schedule: NodeJS.Timeout, uiTick: NodeJS.Timeout | undefined;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
type RequestLink = { page: "devices" | "transfers"; id: string };
const waiting = new Map<string, Notification | undefined>();
let requested: RequestLink | undefined;
let openRequested = false;
function navigateTo(link: RequestLink) {
  requested = link;
  show();
  if (win && !win.webContents.isLoading() && !win.webContents.isCrashed()) {
    win?.webContents.send("vault:request", link);
    requested = undefined;
  }
}
function pendingRequests() {
  const entries = new Map<string, RequestLink>();
  for (const p of lan.pending.values())
    entries.set("pair-" + p.id + "-" + (p.attempt || p.expires), {
      page: "devices",
      id: p.id,
    });
  for (const j of store.state.incoming)
    if (j.state === "승인 대기")
      entries.set("file-" + j.id, { page: "transfers", id: j.id });
  return entries;
}
function updateRequests() {
  if (!tray || !lan || quitting) return;
  const entries = pendingRequests();
  let changed = false;
  for (const [key, n] of waiting) {
    if (entries.has(key)) continue;
    waiting.delete(key);
    n?.close();
    changed = true;
  }
  for (const [key, link] of entries) {
    if (waiting.has(key)) continue;
    waiting.set(key, undefined);
    changed = true;
    if ((win?.isVisible() && win.isFocused()) || !Notification.isSupported())
      continue;
    const n = new Notification({
      title: product,
      body:
        link.page === "devices"
          ? "기기 등록 요청이 있습니다."
          : "파일 수신 요청이 있습니다.",
    });
    n.on("click", () => {
      if (pendingRequests().has(key)) navigateTo(link);
    });
    n.on("failed", () =>
      note("알림을 표시할 수 없습니다. 트레이에서 대기 요청을 확인하세요."),
    );
    waiting.set(key, n);
    n.show();
  }
  if (changed) trayMenu();
}
function note(s: string) {
  notice = s;
  change();
}
function change() {
  if (quitting) return;
  if (!uiTick)
    uiTick = setTimeout(() => {
      uiTick = undefined;
      updateRequests();
      if (
        !quitting &&
        win &&
        !win.isDestroyed() &&
        win.isVisible() &&
        !win.webContents.isCrashed()
      )
        win.webContents.send("vault:changed");
    }, 180);
}
function show() {
  openRequested = true;
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isCrashed()) win.reload();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  change();
}
function status() {
  const s = store.state;
  return {
    product,
    development,
    version: app.getVersion(),
    settings: s.settings,
    local: {
      id: lan.id,
      address: lan.address,
      port: lan.pairPort,
      os: process.platform,
    },
    adapters: lan.adapters,
    diagnostic: lan.diagnostics,
    notice,
    locked: clips.locked,
    outbound,
    shelf: vault.shelf.root,
    peers: s.peers.map(({ cert, ...p }) => ({
      ...p,
      online: lan.available(p.id),
      compatible: lan.online.get(p.id)?.features.includes("vault") === true,
      locked: lan.online.get(p.id)?.locked === true,
      version: lan.online.get(p.id)?.version,
    })),
    nearby: [...lan.nearby.values()].filter(
      (q) => !s.peers.some((p) => p.id === q.id),
    ),
    pending: [...lan.pending.values()].map(
      ({ id, name, code, confirmed, attempt }) => ({
        id,
        name,
        code,
        confirmed,
        attempt,
      }),
    ),
    jobs: [
      ...s.outgoing.map((j) => ({
        id: j.id,
        peer: j.peer,
        direction: "보냄",
        name: j.entries[0]?.name,
        count: j.entries.length,
        state: j.state,
        done: j.done,
        total: j.total,
        error: j.error,
      })),
      ...s.incoming
        .filter((j) => !s.pulls.some((p) => p.id === j.id))
        .map((j) => ({
          id: j.id,
          peer: j.peer,
          direction: "받음",
          name: j.offer.entries[0]?.name,
          count: j.offer.entries.length,
          state: j.state,
          total: j.offer.entries.reduce((a, e) => a + e.size, 0),
          done:
            j.state === "완료"
              ? j.offer.entries.reduce((a, e) => a + e.size, 0)
              : Object.values(j.received ?? {}).reduce((a, b) => a + b, 0),
          error: j.error,
        })),
      ...s.pulls.map((p) => {
        const j = s.incoming.find((j) => j.id === p.id);
        return {
          ...p,
          direction: "받음",
          count: j?.offer.entries.length ?? 1,
          total: j?.offer.entries.reduce((sum, e) => sum + e.size, 0) || 0,
          done: Object.values(j?.received ?? {}).reduce((a, b) => a + b, 0),
          location: j?.root || s.settings.receive,
        };
      }),
    ].reverse(),
    update: {
      status: up.status,
      checkedAt: s.updateCheck,
      busy: up.busy,
      next: up.next,
      notes: up.notes,
      percent: up.percent,
      ready: up.ready,
      later: updateLater,
    },
  };
}
async function initialize() {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const pix = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const k = (y * 32 + x) * 4,
        arrow =
          (y >= 8 && y <= 11 && x >= 5 && x < 24) ||
          (Math.abs(y - 10) + Math.abs(x - 23) < 7 && x >= 22) ||
          (y >= 20 && y <= 23 && x > 8 && x < 27) ||
          (Math.abs(y - 22) + Math.abs(x - 8) < 7 && x <= 9);
      pix[k] = arrow ? 180 : 52;
      pix[k + 1] = arrow ? 250 : 72;
      pix[k + 2] = arrow ? 221 : 27;
      pix[k + 3] = x < 2 || x > 29 || y < 2 || y > 29 ? 0 : 255;
    }
  const ico = nativeImage.createFromBitmap(pix, { width: 32, height: 32 });
  tray = new Tray(ico.resize({ width: 18, height: 18 }));
  tray.setToolTip(product);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "기기 키 저장소 확인 중", enabled: false },
      { type: "separator" },
      { label: "종료", click: () => app.exit(0) },
    ]),
  );
  if (process.platform === "win32") tray.on("click", show);
  const home = app.getPath("userData");
  store = new Store(home, app.getPath("downloads"));
  // Convert the previous Windows login entry when updating an enabled install.
  if (
    app.isPackaged &&
    process.platform === "win32" &&
    store.state.settings.login
  ) {
    const legacy = app.getLoginItemSettings();
    if (
      legacy.openAtLogin &&
      legacy.executableWillLaunchAtLogin &&
      !app.getLoginItemSettings(loginOptions).openAtLogin
    )
      app.setLoginItemSettings({ ...loginOptions, openAtLogin: true });
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw Error(
      "OS 키 저장소에 접근할 수 없습니다. 로그인 키체인 또는 Windows 계정을 확인하세요.",
    );
  const sealed = store.state.sealed;
  let keys;
  if (sealed) {
    const decrypted = await safeStorage.decryptStringAsync(
      Buffer.from(sealed, "base64"),
    );
    keys = identitySchema.parse(
      JSON.parse(typeof decrypted === "string" ? decrypted : decrypted.result),
    );
  } else {
    keys = await createIdentity();
    store.state.sealed = (
      await safeStorage.encryptStringAsync(JSON.stringify(keys))
    ).toString("base64");
    store.save();
  }
  const key = (process.env.SYNC_VAULT_RELEASE_KEY || "").replaceAll(
    "\\n",
    "\n",
  );
  lan = new Lan(
    store,
    keys,
    app.getVersion(),
    async (id, route, req) => {
      if (updating) throw Error("업데이트 준비 중");
      if (route.startsWith("/vault/")) {
        try {
          return await vault.serve(id, route, await readJSON(req, 64000));
        } catch (e) {
          const error = msg(e);
          return {
            problem: /^[가-힣]/u.test(error)
              ? error.slice(0, 180)
              : "공유 항목을 읽을 수 없습니다. 목록을 새로고침하세요.",
          };
        }
      }
      throw Error("지원하지 않는 요청");
    },
    change,
  );
  const tool = path.join(
    app.isPackaged ? process.resourcesPath : path.resolve("out"),
    "native",
    process.platform === "win32" ? "clipboard.exe" : "clipboard",
  );
  if (!store.state.historyKey) {
    store.state.historyKey = (
      await safeStorage.encryptStringAsync(randomBytes(32).toString("base64"))
    ).toString("base64");
    store.save();
  }
  const decryptedKey = await safeStorage.decryptStringAsync(
    Buffer.from(store.state.historyKey, "base64"),
  );
  const vaultKey = Buffer.from(
    typeof decryptedKey === "string" ? decryptedKey : decryptedKey.result,
    "base64",
  );
  const history = new History(
    path.join(home, "history"),
    vaultKey,
    () => store.state.settings.historyLimit,
    (bytes) => {
      const img = nativeImage.createFromBuffer(bytes),
        { width, height } = img.getSize();
      if (!width || !height) return;
      const factor = Math.min(1, 72 / Math.max(width, height));
      const thumb = img
        .resize({
          width: Math.max(1, Math.round(width * factor)),
          height: Math.max(1, Math.round(height * factor)),
        })
        .toPNG();
      if (thumb.length <= 24000) return thumb.toString("base64");
    },
  );
  const qaProfile =
    testHome ||
    /^SyncVaultQA-[a-zA-Z0-9-]+$/.test(process.env.SYNC_VAULT_QA_STATION || "");
  const shelf = new Shelf(
    path.join(qaProfile ? home : app.getPath("home"), product, "공유"),
    vaultKey,
  );
  await history.init();
  await shelf.init();
  clips = new Clips(
    tool,
    store,
    lan.id,
    async (clip) => {
      const generation = clips.generation;
      await history.add(
        clip,
        () => clips.enabled && clips.generation === generation,
      );
      change();
    },
    async () => {},
    note,
    true,
  );
  rx = new Receiver(
    store,
    async () => {},
    (id) =>
      !updating &&
      !clips.locked &&
      store.state.peers.some((p) => p.id === id) &&
      !lan.online.get(id)?.locked,
  );
  vault = new Vault(store, lan, shelf, history, clips, rx, change, (peer) => {
    if (win && !win.isDestroyed() && !win.webContents.isCrashed())
      win.webContents.send("vault:privacy", peer);
  });
  let lockGeneration = 0;
  let unlockRetry: NodeJS.Timeout | undefined;
  powerMonitor.on("lock-screen", () => {
    ++lockGeneration;
    clearTimeout(unlockRetry);
    clips.locked = true;
    vault.announce(true);
    change();
  });
  powerMonitor.on("unlock-screen", () => {
    const generation = ++lockGeneration;
    const resumeClipboard = async () => {
      if (quitting || generation !== lockGeneration) return;
      try {
        await clips.resetBaseline();
        if (generation !== lockGeneration) return;
        clips.locked = false;
        vault.announce(false);
        change();
      } catch (e) {
        note(msg(e));
        unlockRetry = setTimeout(resumeClipboard, 2000);
        unlockRetry.unref();
      }
    };
    void resumeClipboard();
  });
  clips.locked = powerMonitor.getSystemIdleState(1) === "locked";
  lan.locked = clips.locked;
  up = new Updater(home, app.getVersion(), key, change);
  win = new BrowserWindow({
    width: 1060,
    height: 735,
    minWidth: 740,
    minHeight: 560,
    title: product,
    backgroundColor: "#f8faf9",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.on("did-finish-load", () => {
    if (requested) win?.webContents.send("vault:request", requested);
    requested = undefined;
  });
  win.webContents.on("render-process-gone", () => {
    if (!quitting && win?.isVisible()) win.reload();
  });
  ipcMain.handle("vault", async (e, action, value) => {
    if (
      e.sender !== win?.webContents ||
      e.senderFrame !== win.webContents.mainFrame
    )
      throw Error("잘못된 창");
    return command(action, value);
  });
  await win.loadFile(path.join(__dirname, "ui", "index.html"));
  const loginStart =
    process.argv.includes(loginFlag) ||
    (process.platform === "darwin" &&
      app.getLoginItemSettings().wasOpenedAtLogin);
  if (openRequested || !loginStart) win.show();
  win.setIcon(ico);
  tray.setToolTip(product);
  trayMenu();
  app.on("activate", show);
  powerMonitor.on("resume", () => void lan.poll(true));
  lan.start();
  await clips.start().catch((e) => note(msg(e)));
  schedule = setInterval(() => void pump(), 1000);
  autoCheckUpdate();
  const dir = process.env.SYNC_VAULT_HEALTH,
    token = process.env.SYNC_VAULT_TICKET;
  if (
    dir &&
    token &&
    path.dirname(path.resolve(dir)) === path.join(home, "updates") &&
    /^[a-f0-9-]{36}$/.test(token)
  ) {
    await fs.writeFile(path.join(dir, "healthy.pid"), String(process.pid), {
      mode: 0o600,
    });
    await fs.writeFile(path.join(dir, "healthy.version"), app.getVersion(), {
      mode: 0o600,
    });
    await fs.writeFile(path.join(dir, "healthy"), token, { mode: 0o600 });
  }
  change();
}
function checkUpdate() {
  if (development || up.busy || up.ready) return;
  store.state.updateCheck = Date.now();
  persist();
  return up.check();
}
function autoCheckUpdate() {
  if (store.state.settings.updates && Date.now() - store.state.updateCheck >= 86400000)
    void checkUpdate();
}
function trayMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: product + " 열기", click: () => show() },
      ...Array.from(pendingRequests(), ([key, link]) => ({
        label:
          (link.page === "devices" ? "기기 등록 요청" : "파일 수신 요청") +
          " 열기",
        click: () => {
          if (pendingRequests().has(key)) navigateTo(link);
        },
      })),
      {
        label: store.state.settings.paused
          ? "클립보드 공유 재개"
          : "클립보드 공유 일시 중지",
        click: () => {
          void command("settings", {
            paused: !store.state.settings.paused,
          }).catch((e) => note(msg(e)));
        },
      },
      {
        label: "클립보드 이미지 PNG로 저장",
        click: () => {
          void command("save-image", null).catch((e) => note(msg(e)));
        },
      },
      { type: "separator" },
      { label: "종료", click: () => app.quit() },
    ]),
  );
}
function persist() {
  try {
    store.save();
  } catch (e) {
    note("상태 저장 실패 · " + msg(e));
  }
  change();
}
async function pump() {
  if (quitting || updating) return;
  if (clips.enabled && Date.now() > nextPrune) {
    nextPrune = Date.now() + 3600000;
    void clips.pruneImages().catch((e) => note(msg(e)));
    if (
      store.state.incoming.some(
        (j) =>
          j.offer.stamp && j.finished && Date.now() - j.finished > 86400000,
      )
    )
      void clips
        .currentFiles()
        .then((paths) => rx.pruneClipboard(paths))
        .catch((e) => note(msg(e)));
  }
  autoCheckUpdate();
  if (
    updateLater &&
    !vault.active.size && !vault.shelf.isServing() &&
    !store.state.pulls.some((p) =>
      ["대기", "수신 중", "준비 중", "재연결 대기"].includes(p.state),
    )
  ) {
    updateLater = false;
    void applyUpdate().catch((e) => note(msg(e)));
    return;
  }
  vault.pump();
}
async function applyUpdate() {
  if (updating) throw Error("업데이트 중입니다.");
  if (!up.ready) throw Error("검증된 업데이트가 없습니다.");
  updating = true;
  try {
    vault.invalidate();
    while (vault.active.size || rx.active)
      await new Promise((r) => setTimeout(r, 100));
    const launch = await up.prepare(
      process.execPath,
      path.join(__dirname, "ui"),
    );
    store.save();
    await launch();
    app.quit();
  } finally {
    updating = false;
  }
}
async function command(action: string, v: any): Promise<any> {
  if (action === "state") return status();
  if (
    development &&
    ["check", "download", "update-now", "update-later"].includes(action)
  )
    throw Error("개발판은 새 개발 설치본으로 갱신하세요.");
  if (updating) throw Error("업데이트 중입니다.");
  if (action === "refresh") {
    await lan.poll(true);
    return;
  }
  if (action === "pair") {
    if (pair) throw Error("기기 등록이 진행 중입니다.");
    const endpoint = z
      .object({ address: z.string(), port: z.number().int() })
      .parse(v);
    const ctl = (pair = new AbortController());
    try {
      const req = await lan.inspect(endpoint);
      outbound = {
        id: req.id,
        name: req.name,
        code: req.code,
        confirmed: false,
        attempt: req.attempt,
      };
      change();
      void lan
        .register(endpoint, req, ctl.signal, () => !!outbound?.confirmed)
        .then(() => note("기기 연결을 완료했습니다."))
        .catch((e) => {
          if (!ctl.signal.aborted) note(msg(e));
        })
        .finally(() => {
          outbound = undefined;
          pair = undefined;
          change();
        });
    } catch (e) {
      pair = undefined;
      throw e;
    }
    return;
  }
  if (action === "pair-confirm" || action === "pair-cancel") {
    if (outbound && outbound.attempt === v) {
      if (action === "pair-confirm") outbound.confirmed = true;
      else pair?.abort();
      change();
    }
    return;
  }
  if (action === "approve") {
    if (!v || lan.pending.get(v.id)?.attempt !== v.attempt)
      throw Error("등록 요청이 변경되었습니다.");
    lan.approve(v.id);
    change();
    return;
  }
  if (action === "deny") {
    if (v && lan.pending.get(v.id)?.attempt === v.attempt) lan.deny(v.id);
    change();
    return;
  }
  if (action === "forget") {
    await vault.forget(v);
    return;
  }
  if (action === "vault-list")
    return vault.list(v.peer, v.id ?? "", v.offset ?? 0);
  if (action === "vault-history") return vault.records(v.peer);
  if (action === "vault-copy") return vault.copy(v.peer, v.id);
  if (action === "vault-get") return vault.enqueue(v.peer, v.id, v.name);
  if (action === "history-delete" || action === "history-clear") {
    vault.check(lan.id);
    await vault.history.remove(
      action === "history-delete" ? z.string().uuid().parse(v) : undefined,
    );
    change();
    return;
  }
  if (action === "shelf-open") {
    vault.check(lan.id);
    const error = await shell.openPath(vault.shelf.root);
    if (error) throw Error("공유 폴더를 열 수 없습니다.");
    return;
  }
  if (action === "job") {
    if (v.op === "open") {
      const i = store.state.incoming.find(
        (j) => j.id === v.id && j.state === "완료",
      );
      if (i) shell.showItemInFolder(Object.values(i.paths)[0] ?? i.root);
    } else await vault.action(v.id, v.op);
    return;
  }
  if (action === "folder") {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  }
  if (action === "save-image") {
    const { clipboard } = await import("electron");
    const items = await clipboard.read();
    const item = items.find((i) => i.types.includes("image/png"));
    if (!item) throw Error("클립보드에 PNG 이미지가 없습니다.");
    const png = await item.getType("image/png");
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: "클립보드.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!r.canceled && r.filePath)
      await fs.writeFile(r.filePath, Buffer.from(await png.arrayBuffer()));
    return;
  }
  if (action === "settings") {
    const old = store.state.settings,
      proposed = settingsSchema.parse({ ...old, ...v });
    if (development) proposed.updates = false;
    if (proposed.receive !== old.receive) {
      if (
        inside(vault.shelf.root, proposed.receive) ||
        inside(proposed.receive, vault.shelf.root)
      )
        throw Error("공유 폴더와 다른 수신 위치를 선택하세요.");
      proposed.receive = writable(proposed.receive);
    }
    if (old.paused !== proposed.paused) await clips.resetBaseline();
    if (proposed.login !== old.login) {
      app.setLoginItemSettings({
        ...loginOptions,
        openAtLogin: proposed.login,
      });
      if (
        app.isPackaged &&
        app.getLoginItemSettings(loginOptions).openAtLogin !== proposed.login
      )
        throw Error("OS의 로그인 항목 설정을 확인하세요.");
    }
    const oldVolume = store.state.receiveVolume;
    if (proposed.receive !== old.receive)
      store.state.receiveVolume = volumeRoot(proposed.receive);
    store.state.settings = proposed;
    try {
      store.save();
    } catch (e) {
      store.state.settings = old;
      store.state.receiveVolume = oldVolume;
      throw e;
    }
    await vault.history.trim();
    if (old.name !== proposed.name || old.adapter !== proposed.adapter)
      await lan.poll(true);
    trayMenu();
    change();
    return;
  }
  if (action === "defaults")
    return command("settings", defaults(store.downloads));
  if (action === "reset") {
    const r = await dialog.showMessageBox(win!, {
      type: "warning",
      message: "이 기기의 인증키와 모든 등록을 초기화할까요?",
      buttons: ["취소", "등록 초기화"],
      cancelId: 0,
      defaultId: 0,
    });
    if (r.response !== 1) return;
    for (const p of [...store.state.peers]) await vault.forget(p.id);
    store.state.sealed = "";
    store.save();
    store.save();
    app.relaunch();
    app.quit();
    return;
  }
  if (action === "open-releases") return shell.openExternal(releasesPage);
  if (action === "check") return checkUpdate();
  if (action === "download") return up.download();
  if (action === "cancel-update") return up.cancel();
  if (action === "update-later") {
    if (!up.ready) throw Error("업데이트 파일이 없습니다.");
    updateLater = true;
    change();
    return;
  }
  if (action === "update-now") return applyUpdate();
  if (action === "dismiss") {
    notice = "";
    change();
    return;
  }
  throw Error("지원하지 않는 동작입니다.");
}
app.on("before-quit", () => {
  quitting = true;
  clearTimeout(uiTick);
  clearInterval(schedule);
  pair?.abort();
  vault?.invalidate();
  clips?.stop();
  void lan?.stop();
  tray?.destroy();
});

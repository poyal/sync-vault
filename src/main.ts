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
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createIdentity, identitySchema } from "./identity";
import { Store, defaults, settingsSchema, writable, volumeRoot } from "./store";
import { Lan, binary } from "./lan";
import { readJSON } from "./network";
import { Clips } from "./clipboard";
import { Receiver, inventory, createJob, transmit } from "./files";
import { ReleaseFolder } from "./releases";
import { Updater } from "./update";
import { type Outgoing, type Stamp, type ShareEndpoint } from "./types";
import { development, product } from "./channel";
const loginFlag = "--sync-vault-login";
const loginOptions = process.platform === "win32" ? { args: [loginFlag] } : {};
const testHome = !app.isPackaged ? process.env.SYNC_VAULT_TEST_HOME : undefined;
if (testHome) app.setPath("userData", path.resolve(testHome));
app.setName(product);
if (process.platform === "win32")
  app.setAppUserModelId(development ? "io.syncvault.desktop.dev" : "io.syncvault.desktop");
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
  up: Updater;
let quitting = false,
  updating = false,
  updateLater = false,
  notice = "",
  pick: string[] = [],
  pair: AbortController | undefined;
let nextPrune = 0;
let schedule: NodeJS.Timeout,
  uiTick: NodeJS.Timeout | undefined,
  preparing = 0;
const running = new Map<string, AbortController>(),
  retryAt = new Map<string, number>();
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
    entries.set("pair-" + p.id + "-" + (p.attempt || p.expires),
      { page: "devices", id: p.id });
  for (const j of store.state.incoming)
    if (j.state === "승인 대기") entries.set("file-" + j.id, { page: "transfers", id: j.id });
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
    if ((win?.isVisible() && win.isFocused()) || !Notification.isSupported()) continue;
    const n = new Notification({ title: product, body: link.page === "devices"
      ? "기기 등록 요청이 있습니다." : "파일 수신 요청이 있습니다." });
    n.on("click", () => { if (pendingRequests().has(key)) navigateTo(link); });
    n.on("failed", () => note("알림을 표시할 수 없습니다. 트레이에서 대기 요청을 확인하세요."));
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
      if (!quitting && win && !win.isDestroyed() && win.isVisible() && !win.webContents.isCrashed())
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
    product, development,
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
    pick: pick.map((p) => path.basename(p)),
    preparing,
    peers: s.peers.map(({ cert, ...p }) => ({
      ...p,
      online: lan.available(p.id),
      compatible: !!lan.online.get(p.id)?.features.length,
      version: lan.online.get(p.id)?.version,
    })),
    nearby: [...lan.nearby.values()].filter(
      (q) => !s.peers.some((p) => p.id === q.id),
    ),
    pending: [...lan.pending.values()].map(({ id, name, code }) => ({
      id,
      name,
      code,
    })),
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
      ...s.incoming.map((j) => ({
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
    ].reverse(),
    update: {
      status: up.status,
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "기기 키 저장소 확인 중", enabled: false },
    { type: "separator" },
    { label: "종료", click: () => app.exit(0) },
  ]));
  if (process.platform === "win32") tray.on("click", show);
  const home = app.getPath("userData");
  store = new Store(home, app.getPath("downloads"));
  // Convert the previous Windows login entry when updating an enabled install.
  if (app.isPackaged && process.platform === "win32" && store.state.settings.login) {
    const legacy = app.getLoginItemSettings();
    if (legacy.openAtLogin && legacy.executableWillLaunchAtLogin &&
        !app.getLoginItemSettings(loginOptions).openAtLogin)
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
  const releases = new ReleaseFolder(
    () => store.state.settings.releaseFolder,
    key,
  );
  lan = new Lan(
    store,
    keys,
    app.getVersion(),
    async (id, route, req) => {
      if (updating) throw Error("업데이트 준비 중");
      if (development && route.startsWith("/release/"))
        throw Error("개발판은 업데이트를 배포하지 않습니다.");
      if (route === "/release/index") {
        await readJSON(req);
        return releases.index();
      }
      if (route === "/release/part") return releases.part(await readJSON(req));
      if (route === "/clip") {
        await clips.receive(id, await readJSON(req, 46 * 1024 ** 2));
        return {};
      }
      if (route === "/offer") {
        const offer = await readJSON(req, 8 * 1024 ** 2);
        const result = await rx.locked((offer as any).id, () => rx.offer(id, offer));
        change();
        return result;
      }
      if (route === "/cancel") {
        const { id: job } = z
          .object({ id: z.string().uuid() })
          .parse(await readJSON(req));
        await rx.cancel(id, job);
        return {};
      }
      if (route === "/finish") {
        const { id: job } = z
          .object({ id: z.string().uuid() })
          .parse(await readJSON(req));
        return rx.finish(id, job);
      }
      const m =
        /^\/part\/([a-f0-9-]{36})\/(\d{1,5})\/(status|finish|replace|\d{1,16})$/.exec(
          route,
        );
      if (m)
        return rx.part(
          id,
          m[1],
          Number(m[2]),
          m[3],
          /^\d/.test(m[3]) ? await binary(req) : await readJSON(req),
        );
      throw Error("지원하지 않는 요청");
    },
    change,
  );
  const tool = path.join(
    app.isPackaged ? process.resourcesPath : path.resolve("out"),
    "native",
    process.platform === "win32" ? "clipboard.exe" : "clipboard",
  );
  clips = new Clips(
    tool,
    store,
    lan.id,
    async (clip) => {
      const recipients = store.state.peers.filter(
        (p) =>
          lan.available(p.id) &&
          lan.online.get(p.id)?.features.includes(clip.kind),
      );
      await Promise.allSettled(
        recipients.map((p) =>
          lan
            .send(p.id, "/clip", clip)
            .catch((e) => note(p.name + " · " + msg(e))),
        ),
      );
    },
    async (paths, stamp) => {
      const settings = store.state.settings;
      const stats = await Promise.all(
        paths.slice(0, settings.smallCount + 1).map((f) => fs.lstat(f)),
      );
      if (
        paths.length > settings.smallCount ||
        stats.some((s) => !s.isFile() || s.isSymbolicLink()) ||
        stats.reduce((a, s) => a + s.size, 0) > settings.smallBytes
      ) {
        pick = paths;
        note("큰 파일 또는 폴더입니다. 받을 기기를 선택해 보내세요.");
        return;
      }
      const peers = store.state.peers.filter(
        (p) =>
          lan.available(p.id) &&
          lan.online.get(p.id)?.features.includes("files"),
      );
      if (!peers.length) return;
      const entries = await inventory(paths);
      if (stamp.clock !== store.state.stamp.clock || !clips.enabled) return;
      for (const p of peers)
        store.state.outgoing.push(createJob(entries, p.id, stamp));
      store.save();
      void pump();
    },
    note,
  );
  rx = new Receiver(
    store,
    (s, p) => clips.receiveFiles(s, p),
    (id, stamp) =>
      !updating &&
      store.state.peers.some((p) => p.id === id) &&
      (!stamp || (clips.enabled && store.state.settings.files)),
  );
  up = new Updater(
    home,
    app.getVersion(),
    process.env.SYNC_VAULT_FEED || "",
    key,
    change,
    {
      indexes: async () => {
        const requests = store.state.peers
          .filter((p) => lan.available(p.id))
          .map(async (p) => ({
            peer: p.id,
            index: await lan.send(
              p.id,
              "/release/index",
              {},
              AbortSignal.timeout(4000),
            ),
          }));
        if (store.state.settings.releaseFolder)
          requests.push(
            releases.index().then((index) => ({ peer: "this-device", index })),
          );
        const results = await Promise.allSettled(requests);
        return results.flatMap((r) => {
          if (r.status !== "fulfilled") return [];
          const { peer, index } = r.value;
          return [
            {
              peer,
              manifest: Buffer.from(index.manifest, "base64"),
              sig: Buffer.from(index.sig, "base64"),
            },
          ];
        });
      },
      part: async (peer, name, offset, signal) => {
        const r: any =
          peer === "this-device"
            ? await releases.part({ name, offset })
            : await lan.send(peer, "/release/part", { name, offset }, signal);
        return Buffer.from(r.data, "base64");
      },
    },
  );
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
  const loginStart = process.argv.includes(loginFlag) ||
    (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
  if (openRequested || !loginStart) win.show();
  win.setIcon(ico);
  tray.setToolTip(product);
  trayMenu();
  app.on("activate", show);
  let lockGeneration = 0;
  let unlockRetry: NodeJS.Timeout | undefined;
  powerMonitor.on("lock-screen", () => {
    ++lockGeneration;
    clearTimeout(unlockRetry);
    clips.locked = true;
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
        change();
      } catch (e) {
        note(msg(e));
        unlockRetry = setTimeout(resumeClipboard, 2000);
        unlockRetry.unref();
      }
    };
    void resumeClipboard();
  });
  powerMonitor.on("resume", () => void lan.poll(true));
  lan.start();
  await clips.start().catch((e) => note(msg(e)));
  schedule = setInterval(() => void pump(), 1000);
  if (
    store.state.settings.updates &&
    Date.now() - store.state.updateCheck > 86400000
  ) {
    store.state.updateCheck = Date.now();
    store.save();
    void up.check();
  }
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
function keyForRelease() {
  return (process.env.SYNC_VAULT_RELEASE_KEY || "").replaceAll("\\n", "\n");
}
function trayMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: product + " 열기", click: () => show() },
      ...Array.from(pendingRequests(), ([key, link]) => ({
        label: (link.page === "devices" ? "기기 등록 요청" : "파일 수신 요청") + " 열기",
        click: () => { if (pendingRequests().has(key)) navigateTo(link); },
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
  if (
    store.state.settings.updates &&
    Date.now() - store.state.updateCheck >
      (up.status.includes("기다리고") ? 60000 : 86400000)
  ) {
    store.state.updateCheck = Date.now();
    persist();
    void up.check();
  }
  if (
    updateLater &&
    !running.size &&
    !preparing &&
    !store.state.outgoing.some((j) =>
      ["대기", "보내는 중", "승인 대기", "재연결 대기"].includes(j.state),
    ) &&
    !store.state.incoming.some((j) => j.state === "수신 중")
  ) {
    updateLater = false;
    void applyUpdate().catch((e) => note(msg(e)));
    return;
  }
  for (const job of store.state.outgoing) {
    if (running.size >= 2) break;
    if (
      job.cancelPending &&
      job.state === "취소" &&
      !running.has(job.id) &&
      lan.available(job.peer) &&
      (retryAt.get(job.id) || 0) <= Date.now()
    ) {
      const ctl = new AbortController();
      running.set(job.id, ctl);
      void lan
        .send(
          job.peer,
          "/cancel",
          { id: job.id },
          AbortSignal.any([ctl.signal, AbortSignal.timeout(5000)]),
        )
        .then(() => {
          delete job.cancelPending;
        })
        .catch(() => {
          retryAt.set(job.id, Date.now() + 3000);
        })
        .finally(() => {
          running.delete(job.id);
          persist();
        });
      continue;
    }
    if (
      !["대기", "보내는 중", "승인 대기", "재연결 대기"].includes(job.state) ||
      running.has(job.id) ||
      !lan.available(job.peer) ||
      (retryAt.get(job.id) || 0) > Date.now()
    )
      continue;
    if (!lan.online.get(job.peer)?.features.includes("files")) continue;
    if (
      job.stamp &&
      (!clips.enabled ||
        !store.state.settings.files ||
        job.stamp.clock !== store.state.stamp.clock ||
        job.stamp.origin !== store.state.stamp.origin)
    ) {
      job.state = "취소";
      job.cancelPending = true;
      persist();
      continue;
    }
    const ctl = new AbortController();
    running.set(job.id, ctl);
    job.state = "보내는 중";
    change();
    void transmit(job, (...args) => lan.send(...args), ctl.signal, change)
      .then((result) => {
        if (ctl.signal.aborted) return;
        job.state =
          result === "complete"
            ? "완료"
            : result === "pending"
              ? "승인 대기"
              : "취소";
        if (job.state === "완료") job.done = job.total;
        job.error = "";
        retryAt.set(job.id, Date.now() + 2500);
      })
      .catch((e) => {
        if (ctl.signal.aborted && job.state !== "보내는 중") return;
        job.state =
          lan.available(job.peer) && !ctl.signal.aborted
            ? "오류"
            : "재연결 대기";
        if (
          job.state === "오류" &&
          /socket|ECONN|시간 초과|ETIMEDOUT|EHOST|ENET/i.test(msg(e))
        )
          job.state = "재연결 대기";
        job.error = msg(e);
        retryAt.set(job.id, Date.now() + 3500);
      })
      .finally(() => {
        running.delete(job.id);
        persist();
      });
  }
}
async function applyUpdate() {
  if (updating) throw Error("업데이트 중입니다.");
  updating = true;
  try {
    for (const ctl of running.values()) ctl.abort();
    while (running.size || preparing || rx.active)
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
  if (development && ["check", "download", "update-now", "update-later"].includes(action))
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
      const request = await lan.inspect(endpoint);
      const choice = await dialog.showMessageBox(win!, {
        type: "question",
        buttons: ["등록 요청", "취소"],
        defaultId: 1,
        cancelId: 1,
        message: request.name + " 기기를 등록할까요?",
        detail: "양쪽 화면의 확인값이 같은지 확인하세요.\n" + request.code,
      });
      if (choice.response === 0) {
        note("상대 기기에서 승인하세요 · " + request.code);
        await lan.register(endpoint, request, ctl.signal);
        note("기기 등록을 완료했습니다.");
      }
    } finally {
      pair = undefined;
    }
    return;
  }
  if (action === "approve") {
    lan.approve(v);
    change();
    return;
  }
  if (action === "deny") {
    lan.deny(v);
    change();
    return;
  }
  if (action === "forget") {
    lan.forget(v);
    for (const j of store.state.incoming.filter(
      (j) => j.peer === v && j.state === "취소",
    ))
      await rx.cancel(v, j.id);
    return;
  }
  if (action === "autoaccept") {
    const peer = store.state.peers.find((p) => p.id === v.id);
    if (peer) peer.autoAccept = v.value === true;
    persist();
    return;
  }
  if (action === "dialog-files" || action === "dialog-folders") {
    const r = await dialog.showOpenDialog(win!, {
      properties: [
        action === "dialog-folders" ? "openDirectory" : "openFile",
        "multiSelections",
      ],
    });
    if (!r.canceled) pick = [...new Set([...pick, ...r.filePaths])];
    change();
    return;
  }
  if (action === "drop") {
    pick = [
      ...new Set([
        ...pick,
        ...z
          .array(z.string().min(1).max(32768))
          .max(8000)
          .parse(v)
          .filter((s) => path.isAbsolute(s)),
      ]),
    ];
    change();
    return;
  }
  if (action === "clear") {
    pick = [];
    change();
    return;
  }
  if (action === "send") {
    if (!store.state.peers.some((p) => p.id === v) || !pick.length)
      throw Error("파일과 받을 기기를 선택하세요.");
    const selected = pick;
    preparing++;
    change();
    try {
      const entries = await inventory(selected);
      if (!store.state.peers.some((p) => p.id === v))
        throw Error("기기 등록이 해제되었습니다.");
      store.state.outgoing.push(createJob(entries, v));
      if (pick === selected) pick = [];
      persist();
      void pump();
    } finally {
      preparing--;
      change();
    }
    return;
  }
  if (action === "job") {
    const j = store.state.outgoing.find((j) => j.id === v.id),
      i = store.state.incoming.find((j) => j.id === v.id);
    if (
      v.op === "retry" &&
      j &&
      store.state.peers.some((p) => p.id === j.peer)
    ) {
      j.state = "대기";
      j.error = "";
      retryAt.delete(j.id);
    }
    if (v.op === "accept" && i?.state === "승인 대기") i.state = "수신 중";
    if (v.op === "cancel") {
      if (j && j.state !== "완료") {
        j.cancelPending = true;
        retryAt.delete(j.id);
        j.state = "취소";
        running.get(j.id)?.abort();
      }
      if (i && i.state !== "완료") await rx.cancel(i.peer, i.id);
    }
    if (v.op === "open" && i?.state === "완료")
      shell.showItemInFolder(Object.values(i.paths)[0] ?? i.root);
    persist();
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
    if (development) {
      proposed.updates = false;
      proposed.releaseFolder = "";
    }
    if (proposed.releaseFolder && proposed.releaseFolder !== old.releaseFolder)
      await new ReleaseFolder(
        () => proposed.releaseFolder,
        keyForRelease(),
      ).index();
    if (proposed.receive !== old.receive)
      proposed.receive = writable(proposed.receive);
    if (old.paused !== proposed.paused) await clips.resetBaseline();
    if (proposed.login !== old.login) {
      app.setLoginItemSettings({ ...loginOptions, openAtLogin: proposed.login });
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
    for (const p of [...store.state.peers]) lan.forget(p.id);
    store.state.sealed = "";
    store.save();
    store.save();
    app.relaunch();
    app.quit();
    return;
  }
  if (action === "check") return up.check();
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
  for (const c of running.values()) c.abort();
  clips?.stop();
  void lan?.stop();
  tray?.destroy();
});

// Venuebox desktop client: turns this computer into a child box. Each attached screen is a
// TV on the box (docs: C:\CodeProjects\GameBroker\docs\NATIVE-CLIENTS.md).
//
// Flags: --windowed (small windows instead of full-screen, for development),
//        --box=<address> (sets the box address, e.g. for unattended installs).

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, screen, Tray } from "electron";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getStartAtLogin, setStartAtLogin } from "./autostart";
import { BoxClient, checkBox, normalizeBox, type ClientStatus } from "./box-client";
import { browse, reachable, relocate, type FoundBox } from "./discovery";
import type { BoxMsg, VideoCaps } from "./protocol";
import { ScreenManager, type StatusView } from "./screens";
import { Store } from "./store";
import { Updater, type UpdateState } from "./updater";
import { VideoPlayers } from "./video";
import { isHdrColorSpace, PROBE_SCRIPT, videoCaps, type DecodeProbe } from "./video-caps";

const STATIC = join(__dirname, "..", "..", "static");
const windowed = process.argv.includes("--windowed");
const boxArg = process.argv.find((a) => a.startsWith("--box="))?.slice(6);

// Separate settings/token for test runs.
if (process.env.VENUEBOX_DATA_DIR) app.setPath("userData", process.env.VENUEBOX_DATA_DIR);

// Games autoplay sound and keep animating on screens nobody clicks.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// No swipe-to-go-back on touchscreens: the box decides what a screen shows.
app.commandLine.appendSwitch("overscroll-history-navigation", "0");

// ---------------------------------------------------------------- log

let logFile: string | undefined;
function log(msg: string, extra?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`;
  console.log(line);
  if (!logFile) return;
  try {
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 2_000_000) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, `${line}\n`);
  } catch {
    /* logging must never take the app down */
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
  void app.whenReady().then(start);
}

let store: Store;
let screens: ScreenManager;
let client: BoxClient;
let settingsWin: BrowserWindow | undefined;
let tray: Tray | undefined;
let updater: Updater;
let video: VideoPlayers;
let caps: VideoCaps | undefined;

const platformName = () => ({ win32: "windows", darwin: "macos", linux: "linux" })[process.platform as string] ?? process.platform;

async function start() {
  logFile = join(app.getPath("userData"), "venuebox.log");
  log("starting", { version: app.getVersion(), platform: process.platform, windowed });
  Menu.setApplicationMenu(null);
  store = new Store(log);
  await store.load();
  if (boxArg !== undefined && normalizeBox(boxArg) !== normalizeBox(store.config.box)) store.update({ box: boxArg, boxId: undefined, boxName: undefined });
  if (store.config.startAtLogin === undefined) {
    // First run of an installed copy: start at login (a venue PC must come back by itself).
    const on = app.isPackaged;
    store.update({ startAtLogin: on });
    if (on) setStartAtLogin(true);
  }

  screens = new ScreenManager({ windowed, log, report: (m) => client?.send(m), touchMode: store.config.touchMode === true, bigKeyboard: store.config.bigKeyboard === true });
  client = new BoxClient({
    boxUrl: () => store.config.box,
    token: store,
    device: () => ({ name: store.config.name?.trim() || hostname(), platform: platformName(), model: hostname(), appVersion: app.getVersion() }),
    screens: () => screens.list(),
    video: () => caps,
    onStatus,
    onMessage,
    log,
    relocate: async () => {
      const id = store.config.boxId;
      if (!id) return undefined;
      const r = await relocate(id);
      if (!r) return undefined;
      store.update({ box: r.url, boxName: r.box.name });
      return r.url;
    },
  });

  screens.sync();
  video = new VideoPlayers({
    mpvPath: findMpv(),
    send: (m) => client.send(m),
    log,
    geometry: (s) => screens.videoRect(s),
    covering: (s, on) => screens.coverForVideo(s, on),
  });
  caps = video.available ? await probeVideoCaps() : undefined;
  log("video player", video.available ? { caps } : { available: false });
  let pending: NodeJS.Timeout | undefined;
  const displaysChanged = () => {
    if (pending) clearTimeout(pending);
    // Plugging a TV fires several events (added, then metrics): settle first.
    pending = setTimeout(() => {
      if (screens.sync()) {
        log("screens changed", { screens: screens.list() });
        // A screen that's gone takes its video player with it.
        const ids = new Set(screens.list().map((x) => x.id));
        for (const id of video.playingScreens()) if (!ids.has(id)) void video.close(id, "screen unplugged");
        client.sendScreens();
        pushState();
      }
    }, 1000);
  };
  screen.on("display-added", displaysChanged);
  screen.on("display-removed", displaysChanged);
  screen.on("display-metrics-changed", displaysChanged);

  updater = new Updater({
    log,
    onChange: () => {
      updateTray(client.current);
      pushState();
    },
    prompt: () => openSettings(), // the settings window shows the update banner, above the TVs
  });
  updater.start();

  powerSaveBlocker.start("prevent-display-sleep");
  setupTray();
  globalShortcut.register("CommandOrControl+Alt+Shift+V", openSettings);
  setupIpc();

  client.restart();
  if (!normalizeBox(store.config.box)) void autoFind();
  if (windowed) openSettings();
}

// ---------------------------------------------------------------- video (box 0.28.0)

/** The bundled mpv (resources/mpv), the dev copy (vendor/mpv), or mpv on PATH (Linux/macOS). */
function findMpv(): string | undefined {
  const exe = process.platform === "win32" ? "mpv.exe" : "mpv";
  const candidates = [
    process.env.VENUEBOX_MPV,
    app.isPackaged ? join(process.resourcesPath, "mpv", exe) : join(app.getAppPath(), "vendor", "mpv", `${process.platform}-${process.arch}`, exe),
    ...(process.platform === "win32" ? [] : (process.env.PATH ?? "").split(":").map((d) => join(d, exe))),
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!));
}

/** What to declare in hello.video: this PC's hardware decoders, via Chromium (src/video-caps.ts). */
async function probeVideoCaps(): Promise<VideoCaps> {
  const tallest = Math.max(0, ...screens.list().map((s) => s.h));
  let probe: DecodeProbe = {};
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL("data:text/html,<title>probe</title>");
    probe = (await Promise.race([win.webContents.executeJavaScript(PROBE_SCRIPT), new Promise((r) => setTimeout(() => r({}), 5000))])) as DecodeProbe;
  } catch (err) {
    log("video: decoder probe failed (declaring H.264 only)", { error: String(err) });
  } finally {
    win.destroy();
  }
  const hw = Object.entries(probe).filter(([, v]) => v?.powerEfficient).map(([k]) => k);
  const hdr = screen.getAllDisplays().some((d) => isHdrColorSpace(d.colorSpace));
  log("video: hardware decoders", { hw, tallestScreenPx: tallest, hdrMonitor: hdr });
  return videoCaps(probe, tallest, hdr);
}

// ---------------------------------------------------------------- discovery

let found: (FoundBox & { url?: string })[] = [];
let searching = false;
let findTimer: NodeJS.Timeout | undefined;
let firstFind = true;

/** Browses the LAN; each box gets the first of its addresses that answers. */
async function search(): Promise<typeof found> {
  if (searching) return found;
  searching = true;
  refreshNoBox();
  try {
    const boxes = await browse();
    found = await Promise.all(boxes.map(async (b) => ({ ...b, url: await reachable(b) })));
    log("discovery", { found: found.map((b) => ({ id: b.id, name: b.name, url: b.url ?? "no answer" })) });
  } catch (err) {
    log("discovery failed", { error: String(err) });
  } finally {
    searching = false;
    refreshNoBox();
  }
  return found;
}

/** The "no box" screens say searching / several found / none: keep them current. */
function refreshNoBox() {
  if (client.current.phase === "no-box") screens.setStatus(statusView(client.current));
  pushState();
}

/** No box set: pick it by itself when exactly one answers; otherwise let staff choose. */
async function autoFind() {
  if (findTimer) clearTimeout(findTimer);
  if (normalizeBox(store.config.box)) return;
  const live = (await search()).filter((b) => b.url);
  if (normalizeBox(store.config.box)) return; // set by hand meanwhile
  if (live.length === 1) {
    log("one box found: using it", { id: live[0].id, name: live[0].name });
    useFound(live[0]);
    return;
  }
  // Several boxes, or none (client isolation, other network): staff choose or type it.
  if (live.length > 1 || firstFind) openSettings();
  firstFind = false;
  findTimer = setTimeout(() => void autoFind(), 20_000);
}

function useFound(b: FoundBox & { url?: string }) {
  if (!b.url) return { ok: false, error: `${b.name} didn't answer at ${b.addresses.join(", ")}.` };
  // Same box at a new address: the pairing still works. Another box: pair again.
  if (store.config.boxId !== b.id && normalizeBox(store.config.box) !== b.url) store.clear();
  store.update({ box: b.url, boxId: b.id, boxName: b.name });
  client.restart();
  return { ok: true };
}

/** A box typed in by hand: learn its discovery id once connected, so it can be re-found. */
async function learnBoxId() {
  if (store.config.boxId) return;
  const current = normalizeBox(store.config.box);
  if (!current) return;
  const host = new URL(current).hostname;
  const box = (await browse()).find((b) => b.addresses.includes(host) || b.host === host.toLowerCase());
  if (box && normalizeBox(store.config.box) === current) {
    store.update({ boxId: box.id, boxName: box.name });
    log("learned the box's discovery id", { id: box.id, name: box.name });
  }
}

// Screen windows come and go with displays; the app runs until "Quit" in settings/tray.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  video?.killAll();
  client?.stop();
  screens?.closeAll();
});

// ---------------------------------------------------------------- box → screens

function onMessage(m: BoxMsg) {
  switch (m.type) {
    case "welcome":
      log("connected", { deviceId: m.deviceId, name: m.name });
      void learnBoxId();
      screens.setLabels(Object.fromEntries(m.screens.map((s) => [s.id, s.label])));
      screens.reportAll();
      break;
    case "video":
      void video.handle(m);
      break;
    case "show":
      // A new page closes the video player. The same page again (the box re-sends what each
      // screen shows after a reconnect) leaves the movie playing over it.
      if (video.isPlaying(m.screen)) {
        if (m.url === screens.currentUrl(m.screen)) {
          log("show: same page as under the video, kept the video playing", { screen: m.screen });
          break;
        }
        void video.close(m.screen, "new show");
      }
      if (m.kind !== "native-url") {
        client.send({ type: "state", screen: m.screen, showing: m.url, status: "error", detail: `this app can't play ${m.kind}` });
        break;
      }
      screens.show(m.screen, m.url, m.title);
      break;
    case "off":
      void video.close(m.screen, "off");
      screens.off(m.screen);
      break;
    case "reload":
      screens.reload(m.screen);
      break;
    case "identify":
      screens.identify(m.screen, m.label);
      break;
    case "preview":
      screens.preview(m.screen).then(
        (jpeg) => client.send({ type: "preview", requestId: m.requestId, screen: m.screen, jpeg }),
        (err: Error) => client.send({ type: "preview", requestId: m.requestId, screen: m.screen, error: err.message }),
      );
      break;
    case "error":
      log("box error", { code: m.code, message: m.message });
      break;
  }
  pushState();
}

function statusView(s: ClientStatus): StatusView | undefined {
  switch (s.phase) {
    case "no-box":
      if (searching) return { title: "Looking for the box…", detail: "Searching this network." };
      if (found.filter((b) => b.url).length > 1) return { title: "Several boxes found", detail: "Choose one in the settings window (Ctrl+Alt+Shift+V)." };
      return { title: "No box found yet", detail: "Still looking. Or type the box address in the settings window (Ctrl+Alt+Shift+V)." };
    case "unreachable":
      return { title: "Can't reach the box", detail: `${s.box}: ${s.error}. Trying again…` };
    case "pairing":
      return { title: "Pair this screen", detail: "On the box: TVs page → Venuebox apps → type this code.", code: s.code };
    case "connecting":
      return { title: "Connecting to the box…", detail: s.error ? `${s.box}: ${s.error}` : s.box };
    case "replaced":
      return { title: "Paired elsewhere", detail: "Another copy of this app connected with this device's pairing. Trying again in a few minutes." };
    case "connected":
      return undefined; // black until the box shows something
  }
}

function onStatus(s: ClientStatus) {
  if (s.phase !== "connected") log("status", { ...s, ...(s.phase === "pairing" ? { code: "******" } : {}) });
  screens?.setStatus(statusView(s));
  if (s.phase === "connected") screens?.setLabels(s.labels);
  updateTray(s);
  pushState();
}

// ---------------------------------------------------------------- settings window

function snapshot() {
  return {
    version: app.getVersion(),
    status: client.current,
    config: store.config,
    defaultName: hostname(),
    paired: Boolean(store.get()),
    startAtLogin: getStartAtLogin(),
    touchMode: screens.touchMode,
    bigKeyboard: screens.bigKeyboardOn,
    screens: screens.view(),
    update: updater?.state ?? ({ phase: "dev" } as UpdateState),
    searching,
    found: found.map((b) => ({ id: b.id, name: b.name, addresses: b.addresses, url: b.url, current: b.id === store.config.boxId })),
  };
}

function pushState() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("state", snapshot());
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.moveTop();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 720,
    title: "Venuebox",
    backgroundColor: "#111318",
    alwaysOnTop: !windowed,
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "settings-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // Above the full-screen TV windows on the same display.
  if (!windowed) settingsWin.setAlwaysOnTop(true, "screen-saver", 2);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void settingsWin.loadFile(join(STATIC, "settings.html"));
  settingsWin.on("closed", () => (settingsWin = undefined));
}

function setupIpc() {
  ipcMain.handle("state", () => snapshot());
  ipcMain.handle("box:test", async (_e, input: string) => {
    const box = normalizeBox(input);
    if (!box) return { ok: false, error: "That isn't an address (try 192.168.1.20)." };
    return { ...(await checkBox(box)), url: box };
  });
  ipcMain.handle("box:set", (_e, input: string) => {
    const box = normalizeBox(input);
    if (!box) return { ok: false, error: "That isn't an address (try 192.168.1.20)." };
    const changed = normalizeBox(store.config.box) !== box;
    // Typed by hand: the discovery id is learned again once connected.
    store.update({ box: input.trim(), ...(changed ? { boxId: undefined, boxName: undefined } : {}) });
    // A different box: the old pairing means nothing there.
    if (changed) store.clear();
    client.restart();
    return { ok: true };
  });
  ipcMain.handle("update:check", async () => {
    await updater.check();
    return snapshot();
  });
  ipcMain.handle("update:install", () => updater.install());
  ipcMain.handle("update:later", () => {
    updater.later();
    settingsWin?.close();
  });
  ipcMain.handle("discover", async () => {
    await search();
    return snapshot();
  });
  ipcMain.handle("box:choose", async (_e, id: string) => {
    const b = found.find((x) => x.id === id);
    if (!b) return { ok: false, error: "That box isn't in the list any more: search again." };
    const url = await reachable(b);
    return useFound({ ...b, url });
  });
  ipcMain.handle("name:set", (_e, name: string) => {
    store.update({ name: String(name ?? "").trim().slice(0, 60) || undefined });
    return { ok: true };
  });
  ipcMain.handle("unpair", () => {
    log("unpaired from settings");
    store.clear();
    client.restart();
    return { ok: true };
  });
  ipcMain.handle("login:set", (_e, on: boolean) => {
    setStartAtLogin(Boolean(on));
    store.update({ startAtLogin: Boolean(on) });
    return { ok: true };
  });
  ipcMain.handle("touch:set", (_e, on: boolean, bigKeyboard?: boolean) => {
    const kb = bigKeyboard === undefined ? store.config.bigKeyboard === true : Boolean(bigKeyboard);
    store.update({ touchMode: Boolean(on), bigKeyboard: kb });
    screens.setTouchMode(Boolean(on), kb);
    pushState();
    return { ok: true };
  });
  ipcMain.handle("identify", (_e, id: string) => screens.identify(String(id)));
  ipcMain.handle("quit", () => app.quit());
}

// ---------------------------------------------------------------- tray

function trayIcon() {
  // 16×16 amber rounded square, drawn in code (no icon files yet).
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const corner = (x < 2 || x > 13) && (y < 2 || y > 13);
      const i = (y * size + x) * 4;
      if (corner) continue;
      buf[i] = 0x2b; // B
      buf[i + 1] = 0xa8; // G
      buf[i + 2] = 0xf5; // R
      buf[i + 3] = 0xff;
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function setupTray() {
  try {
    tray = new Tray(trayIcon());
    tray.on("click", openSettings);
  } catch (err) {
    log("no tray available", { error: String(err) }); // Linux kiosk sessions
  }
}

function updateTray(s: ClientStatus) {
  if (!tray) return;
  const text =
    s.phase === "connected" ? `Venuebox: ${s.name}` : s.phase === "pairing" ? "Venuebox: waiting for pairing" : s.phase === "no-box" ? "Venuebox: no box set" : "Venuebox: connecting…";
  tray.setToolTip(text);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: text, enabled: false },
      { type: "separator" },
      { label: "Settings…", click: openSettings },
      updater?.state.phase === "ready"
        ? { label: `Install update ${updater.state.version}…`, click: openSettings }
        : { label: "Check for updates", enabled: app.isPackaged, click: () => void updater?.check().then(() => openSettings()) },
      { label: "Quit Venuebox", click: () => app.quit() },
    ]),
  );
}

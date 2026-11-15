// Venuebox desktop client: turns this computer into a child box. Each attached screen is a
// TV on the box (docs: C:\CodeProjects\GameBroker\docs\NATIVE-CLIENTS.md).
//
// Flags: --windowed (small windows instead of full-screen, for development),
//        --box=<address> (sets the box address, e.g. for unattended installs).

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, screen, Tray } from "electron";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getStartAtLogin, setStartAtLogin } from "./autostart";
import { BoxClient, checkBox, normalizeBox, type ClientStatus } from "./box-client";
import type { BoxMsg } from "./protocol";
import { ScreenManager, type StatusView } from "./screens";
import { Store } from "./store";

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

const platformName = () => ({ win32: "windows", darwin: "macos", linux: "linux" })[process.platform as string] ?? process.platform;

async function start() {
  logFile = join(app.getPath("userData"), "venuebox.log");
  log("starting", { version: app.getVersion(), platform: process.platform, windowed });
  Menu.setApplicationMenu(null);
  store = new Store(log);
  await store.load();
  if (boxArg !== undefined) store.update({ box: boxArg });
  if (store.config.startAtLogin === undefined) {
    // First run of an installed copy: start at login (a venue PC must come back by itself).
    const on = app.isPackaged;
    store.update({ startAtLogin: on });
    if (on) setStartAtLogin(true);
  }

  screens = new ScreenManager({ windowed, log, report: (m) => client?.send(m) });
  client = new BoxClient({
    boxUrl: () => store.config.box,
    token: store,
    device: () => ({ name: store.config.name?.trim() || hostname(), platform: platformName(), model: hostname(), appVersion: app.getVersion() }),
    screens: () => screens.list(),
    onStatus,
    onMessage,
    log,
  });

  screens.sync();
  let pending: NodeJS.Timeout | undefined;
  const displaysChanged = () => {
    if (pending) clearTimeout(pending);
    // Plugging a TV fires several events (added, then metrics): settle first.
    pending = setTimeout(() => {
      if (screens.sync()) {
        log("screens changed", { screens: screens.list() });
        client.sendScreens();
        pushState();
      }
    }, 1000);
  };
  screen.on("display-added", displaysChanged);
  screen.on("display-removed", displaysChanged);
  screen.on("display-metrics-changed", displaysChanged);

  powerSaveBlocker.start("prevent-display-sleep");
  setupTray();
  globalShortcut.register("CommandOrControl+Alt+Shift+V", openSettings);
  setupIpc();

  client.restart();
  if (!normalizeBox(store.config.box) || windowed) openSettings();
}

// Screen windows come and go with displays; the app runs until "Quit" in settings/tray.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  client?.stop();
  screens?.closeAll();
});

// ---------------------------------------------------------------- box → screens

function onMessage(m: BoxMsg) {
  switch (m.type) {
    case "welcome":
      log("connected", { deviceId: m.deviceId, name: m.name });
      screens.setLabels(Object.fromEntries(m.screens.map((s) => [s.id, s.label])));
      screens.reportAll();
      break;
    case "show":
      if (m.kind !== "native-url") {
        client.send({ type: "state", screen: m.screen, showing: m.url, status: "error", detail: `this app can't play ${m.kind}` });
        break;
      }
      screens.show(m.screen, m.url, m.title);
      break;
    case "off":
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
      return { title: "Venuebox", detail: "Set the box address in the settings window (Ctrl+Alt+Shift+V)." };
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
    screens: screens.view(),
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
    store.update({ box: input.trim() });
    // A different box: the old pairing means nothing there.
    if (changed) store.clear();
    client.restart();
    return { ok: true };
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
      { label: "Quit Venuebox", click: () => app.quit() },
    ]),
  );
}

// One full-screen window per attached display. Each one is a TV on the box: it shows what the
// box sends (a TV page URL), or a local status page (pairing code, "connecting…", or black).

import { BrowserWindow, ipcMain, screen, type Display } from "electron";
import { join } from "node:path";
import type { Screen, StateMsg } from "./protocol";
import { checkShowUrl, navigationAllowed } from "./urls";
import { viewportFor, type ViewportInfo } from "./viewport";

/** What windows that aren't showing a game display. Undefined → plain black. */
export interface StatusView {
  title: string;
  detail?: string;
  code?: string;
}

interface Tv {
  id: string;
  display: Display;
  win: BrowserWindow;
  /** The URL the box asked for; undefined → off (status page / black). */
  url?: string;
  title?: string;
  state: StateMsg["status"];
  detail?: string;
  /** The window shows our own status page, not the box's URL. */
  local: boolean;
  retry?: NodeJS.Timeout;
  hang?: NodeJS.Timeout;
  label?: string;
  index: number;
  /** The zoom applied and what pages should see (1920x1080 CSS at the panel's pixels). */
  viewport?: ViewportInfo;
  /** What the last page actually reported (innerWidth/innerHeight/devicePixelRatio). */
  measured?: { w: number; h: number; dpr: number };
}

const STATIC = join(__dirname, "..", "..", "static");
const HIDE_CURSOR = "*, *::before, *::after { cursor: none !important; }";
// Touch mode: no pinch zoom (pan only) and no overscroll gestures (swipe back, pull to refresh).
// touch-action combines down the tree, so elements that ask for "none" (drag games) still get it.
const TOUCH_CSS = "html, body { touch-action: pan-x pan-y !important; overscroll-behavior: none !important; }";
const RETRY_MS = 10_000;
const MAX_PREVIEW_B64 = 270_000; // ≈200 KB of JPEG

export const screenId = (d: Display) => String(d.id);
const guarded = new WeakSet<Electron.Session>();

export class ScreenManager {
  private readonly tvs = new Map<string, Tv>();
  private status?: StatusView;
  private touch = false;
  /** Touch mode's option: GameKit's big on-screen keyboard instead of Windows' touch keyboard. */
  private bigKeyboard = false;

  constructor(
    private readonly o: {
      windowed: boolean;
      report: (m: StateMsg) => void;
      log: (msg: string, extra?: Record<string, unknown>) => void;
      touchMode?: boolean;
      bigKeyboard?: boolean;
    },
  ) {
    this.touch = Boolean(o.touchMode);
    this.bigKeyboard = Boolean(o.bigKeyboard);
    // The screen preload asks this before each page's scripts run (src/screen-preload.ts).
    ipcMain.on("venuebox:touch-mode", (e) => {
      e.returnValue = { touch: this.touch, keyboard: this.touch && this.bigKeyboard };
    });
  }

  get touchMode(): boolean {
    return this.touch;
  }

  get bigKeyboardOn(): boolean {
    return this.bigKeyboard;
  }

  /** Touch mode and its keyboard option; pages reload so they see the change. */
  setTouchMode(on: boolean, bigKeyboard = this.bigKeyboard) {
    if (on === this.touch && bigKeyboard === this.bigKeyboard) return;
    this.touch = on;
    this.bigKeyboard = bigKeyboard;
    this.o.log("touch mode", { on, bigKeyboard });
    for (const tv of this.tvs.values()) {
      if (tv.win.isDestroyed()) continue;
      this.applyTouch(tv);
      tv.win.webContents.reload(); // the keyboard flag is read when a page starts
    }
  }

  private applyTouch(tv: Tv) {
    // Pinch zoom (visual zoom) only; our 1920x1080 layout zoom is separate (applyZoom).
    void tv.win.webContents.setVisualZoomLevelLimits(1, this.touch ? 1 : 3).catch(() => {});
  }

  /** The screens as the box sees them (pixel size, refresh rate). */
  list(): Screen[] {
    const displays = this.displays();
    const names = displays.map((d, i) => displayName(d, i));
    return displays.map((d, i) => ({
      id: screenId(d),
      // Two monitors of the same model: "LG TV (1)", "LG TV (2)".
      name: names.filter((n) => n === names[i]).length > 1 ? `${names[i].slice(0, 54)} (${i + 1})` : names[i],
      w: Math.round(d.size.width * d.scaleFactor),
      h: Math.round(d.size.height * d.scaleFactor),
      ...(d.displayFrequency > 0 ? { hz: Math.round(d.displayFrequency) } : {}),
    }));
  }

  /** Local view for the settings window. */
  view() {
    return this.list().map((s) => {
      const tv = this.tvs.get(s.id);
      return { ...s, label: tv?.label, showing: tv?.url ?? "", title: tv?.title, state: tv?.state ?? "off", detail: tv?.detail, viewport: tv?.viewport, measured: tv?.measured };
    });
  }

  private displays(): Display[] {
    // Primary first, then left to right, top to bottom: stable "Screen 1, 2, 3" names.
    const primary = screen.getPrimaryDisplay().id;
    return screen
      .getAllDisplays()
      .sort((a, b) => Number(b.id === primary) - Number(a.id === primary) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
      .slice(0, 16);
  }

  /** Matches windows to the attached displays. Returns true if the screen list changed. */
  sync(): boolean {
    const displays = this.displays();
    const before = JSON.stringify(this.listFrom(this.tvs));
    const seen = new Set<string>();
    displays.forEach((d, index) => {
      const id = screenId(d);
      seen.add(id);
      const tv = this.tvs.get(id);
      if (!tv) {
        this.tvs.set(id, this.create(id, d, index));
        this.o.log("screen added", { id, name: displayName(d, index), bounds: d.bounds });
      } else {
        tv.display = d;
        tv.index = index;
        this.place(tv);
      }
    });
    for (const [id, tv] of this.tvs) {
      if (seen.has(id)) continue;
      this.o.log("screen removed", { id });
      this.destroy(tv);
      this.tvs.delete(id);
    }
    return JSON.stringify(this.listFrom(this.tvs)) !== before;
  }

  private listFrom(tvs: Map<string, Tv>) {
    return [...tvs.values()].map((t) => [t.id, t.display.size, t.display.scaleFactor, t.display.displayFrequency]);
  }

  private create(id: string, display: Display, index: number): Tv {
    const win = new BrowserWindow({
      ...this.bounds(display, index),
      frame: false,
      show: false,
      backgroundColor: "#000000",
      autoHideMenuBar: true,
      skipTaskbar: !this.o.windowed,
      alwaysOnTop: !this.o.windowed,
      title: `Venuebox ${displayName(display, index)}`,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
        spellcheck: false,
        // Its own session per screen: Chromium keeps zoom per site per session, so two
        // screens of different sizes showing the same game would otherwise share one zoom.
        partition: `persist:venuebox-screen-${id}`,
        preload: join(__dirname, "screen-preload.js"),
        // Run the preload in iframes too (games may be framed); the sandbox keeps Node out.
        nodeIntegrationInSubFrames: true,
      },
    });
    const tv: Tv = { id, display, win, state: "off", index, local: true };
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" })); // no pop-ups, touch mode or not
    this.applyTouch(tv);
    // Touch mode keeps the screen on the box's pages: no links or scripts leaving the
    // origin the box showed, no downloads. The box's own show/reload (loadURL) aren't checked.
    wc.on("will-navigate", (e) => {
      if (!this.touch || navigationAllowed(tv.url, e.url)) return;
      e.preventDefault();
      this.o.log("touch mode: kept the page from leaving", { screen: id, to: e.url.slice(0, 120) });
    });
    if (!guarded.has(wc.session)) {
      guarded.add(wc.session); // a replugged screen reuses its session: one handler each
      wc.session.on("will-download", (e) => {
        if (this.touch) e.preventDefault();
      });
    }
    // Ctrl+wheel and the like: put our layout zoom back.
    wc.on("zoom-changed", () => setTimeout(() => this.applyZoom(tv), 0));
    wc.on("dom-ready", () => {
      void wc.insertCSS(HIDE_CURSOR).catch(() => {});
      if (this.touch) void wc.insertCSS(TOUCH_CSS).catch(() => {});
      this.applyZoom(tv);
    });
    // Zoom is kept per site: set it again for each new document, and when the size changes.
    wc.on("did-navigate", () => this.applyZoom(tv));
    win.on("resize", () => this.applyZoom(tv));
    win.on("enter-full-screen", () => this.applyZoom(tv));
    // Loading = a new document in the main frame. Not did-start-loading: TV pages are SPAs whose
    // history.replaceState right after load fires it again with no did-finish-load after.
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && tv.url && !tv.local) this.setState(tv, "loading");
    });
    wc.on("did-finish-load", () => {
      if (tv.url && !tv.local) {
        this.setState(tv, "playing");
        void this.measure(tv);
      }
    });
    wc.on("did-stop-loading", () => {
      // A failed load already switched to the local error page (tv.local).
      if (tv.url && !tv.local && tv.state === "loading") this.setState(tv, "playing");
    });
    wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ERR_ABORTED: a newer navigation replaced it */ || !tv.url || tv.local) return;
      this.o.log("page failed to load", { screen: id, url, code, desc });
      this.failed(tv, `${desc} (${code})`);
    });
    wc.on("render-process-gone", (_e, details) => {
      if (details.reason === "clean-exit") return;
      this.o.log("page crashed", { screen: id, reason: details.reason });
      if (tv.url) this.failed(tv, `page crashed (${details.reason})`, 2000);
      else this.render(tv);
    });
    wc.on("unresponsive", () => {
      if (tv.hang) return;
      tv.hang = setTimeout(() => {
        tv.hang = undefined;
        this.o.log("page hung: restarting it", { screen: id });
        wc.forcefullyCrashRenderer();
      }, 15_000);
    });
    wc.on("responsive", () => {
      if (tv.hang) clearTimeout(tv.hang);
      tv.hang = undefined;
    });
    win.once("ready-to-show", () => {
      win.show();
      this.place(tv);
    });
    win.on("closed", () => {
      if (this.tvs.get(id) === tv) this.tvs.delete(id);
    });
    this.render(tv);
    return tv;
  }

  private bounds(d: Display, index: number) {
    if (!this.o.windowed) return { ...d.bounds };
    // Dev mode: a small window per screen, tiled on that display.
    const w = Math.round(d.workArea.width * 0.35);
    const h = Math.round((w * 9) / 16);
    return { x: d.workArea.x + 20 + index * 30, y: d.workArea.y + 20 + index * 30, width: w, height: h };
  }

  private place(tv: Tv) {
    if (tv.win.isDestroyed()) return;
    if (this.o.windowed) return;
    tv.win.setFullScreen(false);
    tv.win.setBounds(tv.display.bounds);
    tv.win.setFullScreen(true);
    tv.win.setAlwaysOnTop(true, "screen-saver");
    this.applyZoom(tv);
  }

  /** Lays pages out at 1920x1080 CSS px, rendered at the panel's own pixels (src/viewport.ts). */
  private applyZoom(tv: Tv) {
    if (tv.win.isDestroyed()) return;
    const b = tv.win.getContentBounds();
    const v = viewportFor(b.width, b.height, tv.display.scaleFactor);
    const changed = v.zoom !== tv.viewport?.zoom || v.px.w !== tv.viewport?.px.w;
    tv.viewport = v;
    tv.win.webContents.setZoomFactor(v.zoom);
    if (changed) this.o.log("screen viewport", { screen: tv.id, css: `${v.css.w}x${v.css.h}`, zoom: v.zoom, dpr: v.dpr, renderedAt: `${v.px.w}x${v.px.h}` });
  }

  /** Reads what the page really sees, to confirm the zoom took (logged when it differs). */
  private async measure(tv: Tv) {
    try {
      const m = (await tv.win.webContents.executeJavaScript("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })", false)) as { w: number; h: number; dpr: number };
      tv.measured = { w: m.w, h: m.h, dpr: Math.round(m.dpr * 1000) / 1000 };
      const v = tv.viewport;
      if (v && (Math.abs(m.w - v.css.w) > 2 || Math.abs(m.h - v.css.h) > 2)) {
        this.o.log("page viewport differs from the 1920x1080 layout", { screen: tv.id, expected: `${v.css.w}x${v.css.h}`, page: `${m.w}x${m.h}@${tv.measured.dpr}` });
        this.applyZoom(tv);
      }
    } catch {
      /* page navigated away meanwhile */
    }
  }

  private destroy(tv: Tv) {
    if (tv.retry) clearTimeout(tv.retry);
    if (tv.hang) clearTimeout(tv.hang);
    if (!tv.win.isDestroyed()) tv.win.destroy();
  }

  closeAll() {
    for (const tv of this.tvs.values()) this.destroy(tv);
    this.tvs.clear();
  }

  // ---------------------------------------------------------------- box commands

  setStatus(status: StatusView | undefined) {
    const same = JSON.stringify(status) === JSON.stringify(this.status);
    this.status = status;
    if (same) return;
    for (const tv of this.tvs.values()) if (!tv.url) this.render(tv);
  }

  setLabels(labels: Record<string, string>) {
    for (const tv of this.tvs.values()) tv.label = labels[tv.id] ?? tv.label;
  }

  show(id: string, url: string, title?: string): boolean {
    const tv = this.tvs.get(id);
    if (!tv) return false;
    const check = checkShowUrl(url);
    if (!check.ok) {
      this.o.log("show refused", { screen: id, url: url.slice(0, 120), reason: check.reason });
      this.setState(tv, "error", check.reason);
      return false;
    }
    // data: idle pages can be long: log only their start.
    this.o.log("show", { screen: id, url: url.length > 200 ? `${url.slice(0, 120)}… (${url.length} chars)` : url, title });
    tv.url = url;
    tv.title = title;
    this.load(tv);
    return true;
  }

  off(id: string) {
    const tv = this.tvs.get(id);
    if (!tv) return;
    this.o.log("off", { screen: id });
    tv.url = undefined;
    tv.title = undefined;
    this.render(tv);
  }

  reload(id: string) {
    const tv = this.tvs.get(id);
    if (!tv) return;
    if (tv.url) this.load(tv);
    else this.render(tv);
  }

  /** Flashes the screen's name over whatever it shows (which TV is which). */
  identify(id: string, label?: string) {
    const tv = this.tvs.get(id);
    if (!tv || tv.win.isDestroyed()) return;
    const text = label || tv.label || displayName(tv.display, tv.index);
    const overlay = new BrowserWindow({
      parent: tv.win,
      ...tv.win.getBounds(),
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    overlay.setIgnoreMouseEvents(true);
    overlay.setAlwaysOnTop(true, "screen-saver", 1);
    overlay.once("ready-to-show", () => overlay.showInactive());
    void overlay.loadFile(join(STATIC, "identify.html"), { query: { label: text } });
    setTimeout(() => !overlay.isDestroyed() && overlay.destroy(), 6000);
  }

  /** A JPEG of what the screen shows, base64, ≲200 KB. */
  async preview(id: string): Promise<string> {
    const tv = this.tvs.get(id);
    if (!tv || tv.win.isDestroyed()) throw new Error("no such screen");
    const img = await tv.win.webContents.capturePage();
    if (img.isEmpty()) throw new Error("nothing to capture yet");
    for (const [width, quality] of [
      [960, 70],
      [960, 50],
      [640, 50],
      [480, 40],
    ] as const) {
      const size = img.getSize();
      const scaled = size.width > width ? img.resize({ width, quality: "good" }) : img;
      const b64 = scaled.toJPEG(quality).toString("base64");
      if (b64.length <= MAX_PREVIEW_B64) return b64;
    }
    throw new Error("preview too large");
  }

  /** Every screen's current state (after a reconnect). */
  reportAll() {
    for (const tv of this.tvs.values()) this.report(tv);
  }

  // ---------------------------------------------------------------- internals

  private load(tv: Tv) {
    if (tv.retry) clearTimeout(tv.retry);
    tv.retry = undefined;
    if (!tv.url || tv.win.isDestroyed()) return;
    tv.local = false;
    this.setState(tv, "loading");
    tv.win.webContents.loadURL(tv.url).catch(() => {
      /* reported by did-fail-load */
    });
  }

  private failed(tv: Tv, detail: string, retryMs = RETRY_MS) {
    const url = tv.url;
    this.setState(tv, "error", detail);
    tv.local = true;
    void tv.win.loadFile(join(STATIC, "status.html"), { query: { title: tv.title || "Can't load this page", detail: `${detail}. Retrying…` } });
    if (tv.retry) clearTimeout(tv.retry);
    tv.retry = setTimeout(() => {
      tv.retry = undefined;
      if (tv.url === url) this.load(tv);
    }, retryMs);
  }

  /** Local status page (or black) on a screen that shows nothing from the box. */
  private render(tv: Tv) {
    if (tv.win.isDestroyed()) return;
    if (tv.retry) clearTimeout(tv.retry);
    tv.retry = undefined;
    const s = this.status;
    tv.local = true;
    const query: Record<string, string> = s ? { title: s.title, detail: s.detail ?? "", code: s.code ?? "" } : {};
    void tv.win.loadFile(join(STATIC, "status.html"), { query }).catch(() => {});
    this.setState(tv, "off");
  }

  private setState(tv: Tv, state: StateMsg["status"], detail?: string) {
    const changed = tv.state !== state || tv.detail !== detail;
    tv.state = state;
    tv.detail = detail;
    if (!changed) return;
    this.o.log("state", { screen: tv.id, state, ...(detail ? { detail } : {}) });
    this.report(tv);
  }

  private report(tv: Tv) {
    this.o.report({ type: "state", screen: tv.id, showing: tv.url ?? "", status: tv.url ? tv.state : "off", ...(tv.detail ? { detail: tv.detail } : {}) });
  }
}

function displayName(d: Display, index: number): string {
  const label = (d.label || "").trim();
  return (label ? `${label}` : `Screen ${index + 1}`).slice(0, 60);
}

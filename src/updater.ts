// Updates from GitHub Releases (electron-updater reads latest.yml from the newest release).
// Checks at start and every few hours, downloads in the background, then asks: installing
// restarts the app, so the TVs go blank for a few seconds. "Later" asks again the next day;
// an update that was never confirmed installs when the app quits.

import { app } from "electron";
import { autoUpdater } from "electron-updater";

export type UpdateState =
  | { phase: "dev" } // not an installed copy: no updates
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current"; checkedAt: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string; notes?: string }
  | { phase: "error"; error: string; checkedAt: string };

const CHECK_EVERY_MS = 4 * 60 * 60_000;
// Test hook (VENUEBOX_UPDATE_TEST=1): check after 3 s and install as soon as it's downloaded.
const TEST = process.env.VENUEBOX_UPDATE_TEST === "1";
const FIRST_CHECK_MS = TEST ? 3000 : 60_000; // let the screens come up first
const ASK_AGAIN_MS = 24 * 60 * 60_000;

export class Updater {
  private s: UpdateState = app.isPackaged ? { phase: "idle" } : { phase: "dev" };
  private remind?: NodeJS.Timeout;

  constructor(
    private readonly o: {
      log: (msg: string, extra?: Record<string, unknown>) => void;
      onChange: (s: UpdateState) => void;
      /** An update is downloaded: show the prompt. */
      prompt: (version: string) => void;
    },
  ) {}

  get state(): UpdateState {
    return this.s;
  }

  private set(s: UpdateState) {
    this.s = s;
    this.o.onChange(s);
  }

  start() {
    if (!app.isPackaged) return;
    const log = this.o.log;
    autoUpdater.logger = {
      info: (m: unknown) => log(`updater: ${String(m)}`),
      warn: (m: unknown) => log(`updater warning: ${String(m)}`),
      error: (m: unknown) => log(`updater error: ${String(m)}`),
      debug: () => {},
    };
    autoUpdater.disableWebInstaller = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => this.set({ phase: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ phase: "current", checkedAt: new Date().toISOString() }));
    autoUpdater.on("update-available", (info) => this.set({ phase: "downloading", version: info.version, percent: 0 }));
    autoUpdater.on("download-progress", (p) => {
      if (this.s.phase === "downloading") this.set({ ...this.s, percent: Math.round(p.percent) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      const notes = typeof info.releaseNotes === "string" ? info.releaseNotes.replace(/<[^>]+>/g, "").slice(0, 400) : undefined;
      this.set({ phase: "ready", version: info.version, notes });
      log("update ready", { version: info.version });
      if (TEST) return this.install();
      this.o.prompt(info.version);
    });
    autoUpdater.on("error", (err) => {
      // A ready update stays ready; otherwise show the error until the next check.
      if (this.s.phase !== "ready") this.set({ phase: "error", error: err?.message ?? String(err), checkedAt: new Date().toISOString() });
    });
    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged || this.s.phase === "ready" || this.s.phase === "downloading" || this.s.phase === "checking") return this.s;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ phase: "error", error: (err as Error).message ?? String(err), checkedAt: new Date().toISOString() });
    }
    return this.s;
  }

  /** Restarts into the new version (silent install, then Venuebox starts again). */
  install() {
    if (this.s.phase !== "ready") return;
    this.o.log("installing update", { version: this.s.version });
    autoUpdater.quitAndInstall(true, true);
  }

  /** "Later": ask again tomorrow (or it installs when the app quits). */
  later() {
    if (this.s.phase !== "ready") return;
    const version = this.s.version;
    if (this.remind) clearTimeout(this.remind);
    this.remind = setTimeout(() => this.s.phase === "ready" && this.o.prompt(version), ASK_AGAIN_MS);
  }
}

// Box 0.28.0 video: plays a link full screen over a screen's page with a bundled mpv, driven
// over its JSON IPC (GameBroker docs/NATIVE-CLIENTS.md, "Video player"). One mpv per screen
// while it plays; when it ends or stops, mpv closes and the page underneath comes back.
//
// PRIVACY: the link (and poster) carry the media server's key. The link goes to mpv only over
// the IPC pipe (loadfile), never on its command line (process lists), and is never logged,
// stored, or put in any message. mpv runs with no user config and without the built-in
// scripts that could show or pass it on (stats, console, file list, yt-dlp hook).
//
// No Electron imports: unit-tested with a fake mpv (test/fake-mpv.ts).

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpvIpc } from "./mpv-ipc";
import type { ClientMsg, RemoteAsk, Track, Tracks, VideoMsg, VideoReplyMsg, VideoState } from "./protocol";
import { buildMenu, cleanTracks, moveMenu, planAudio, planSubtitle, renderMenu, startAudio, switchSection, type Menu } from "./video-tracks";

/**
 * Box 0.29.0: keys pressed in the player window (a keyboard at the PC) that the app handles
 * (mpv sends them back as client-message). Space, Left/Right (seek) and the rest keep mpv's
 * own bindings; its track-cycling, fullscreen and playlist keys are taken over so tracks
 * change only through our menu (and the box hears about it).
 */
const DEVICE_KEYS: [string, string][] = [
  ["a", "audio"],
  ["#", "audio"],
  ["s", "subtitle"],
  ["j", "subtitle"],
  ["J", "subtitle"],
  ["UP", "up"],
  ["DOWN", "down"],
  ["ENTER", "select"],
  ["KP_ENTER", "select"],
  ["ESC", "back"],
  [">", "next"],
  ["NEXT", "next"],
  ["<", "previous"],
  ["PREV", "previous"],
  ["f", "ignore"],
  ["MBTN_LEFT_DBL", "ignore"],
];
const MENU_IDLE_MS = 10_000;
const OSD_MENU = 47;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Full screen on that monitor (false: a window there, for --windowed development). */
  fs?: boolean;
  /** That monitor is in Windows HDR mode: mpv outputs HDR there instead of tone-mapping. */
  hdr?: boolean;
}

export interface VideoDeps {
  /** The mpv executable; undefined → this computer has no player (don't declare video). */
  mpvPath?: string;
  /** Tests: arguments put before mpv's own (e.g. a fake mpv script for node). */
  mpvPrefixArgs?: string[];
  send: (msg: ClientMsg) => void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** The screen's monitor in physical pixels (mpv --geometry), or undefined if it's gone. */
  geometry: (screen: string) => Rect | undefined;
  /** The player is covering the screen (true) or has closed (false): move the kiosk window. */
  covering: (screen: string, on: boolean) => void;
  timing?: Partial<Timing>;
}

interface Timing {
  /** play: reply within this (the box allows 15 s). */
  playMs: number;
  /** While playing, a progress video-state at most this often. */
  heartbeatMs: number;
}
const DEFAULT_TIMING: Timing = { playMs: 12_000, heartbeatMs: 10_000 };

interface Player {
  screen: string;
  title: string;
  proc: ChildProcess;
  ipc: MpvIpc;
  state: VideoState;
  position?: number;
  duration?: number;
  paused: boolean;
  buffering: boolean;
  started: boolean;
  done: boolean;
  lastPush: number;
  /** Box 0.29.0 tracks: the list from play, and the ids on now (subtitle null: off). */
  tracks?: Tracks;
  audio?: string;
  subtitle?: string | null;
  /** The file is open: side-file subtitles can be added (sub-add). */
  loaded: boolean;
  pendingSub?: Track;
  menu?: Menu;
  menuTimer?: NodeJS.Timeout;
}

/** What mpv's end-file errors mean, without the link. */
function describeError(fileError: unknown): string {
  const e = String(fileError ?? "").toLowerCase();
  if (e.includes("loading failed")) return "couldn't open the stream (the server refused it or isn't reachable)";
  if (e.includes("unrecognized file format")) return "this video's format isn't supported";
  if (e.includes("no audio or video")) return "the stream had nothing to play";
  if (e.includes("output initialization")) return "the player couldn't open the screen or the sound";
  return "playback failed";
}

const secs = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : undefined);

export class VideoPlayers {
  private readonly players = new Map<string, Player>();
  private readonly t: Timing;

  constructor(private readonly d: VideoDeps) {
    this.t = { ...DEFAULT_TIMING, ...d.timing };
  }

  get available(): boolean {
    return Boolean(this.d.mpvPath);
  }

  playingScreens(): string[] {
    return [...this.players.values()].filter((p) => !p.done).map((p) => p.screen);
  }

  isPlaying(screen: string): boolean {
    const p = this.players.get(screen);
    return Boolean(p && !p.done);
  }

  /** Every op gets exactly one video-reply. */
  async handle(msg: VideoMsg): Promise<void> {
    const reply = (r: Omit<VideoReplyMsg, "type" | "requestId">) => this.d.send({ type: "video-reply", requestId: msg.requestId, ...r });
    const p = this.players.get(msg.screen);
    const live = p && !p.done ? p : undefined;
    try {
      switch (msg.op) {
        case "play":
          return await this.play(msg, reply);
        case "pause":
        case "resume":
          if (!live) return reply({ ok: false, reason: "error", message: "nothing is playing on this screen" });
          await live.ipc.command(["set_property", "pause", msg.op === "pause"]);
          return reply({ ok: true, ...this.snapshot(live, msg.op === "pause" ? "paused" : "playing") });
        case "seek": {
          if (!live) return reply({ ok: false, reason: "error", message: "nothing is playing on this screen" });
          const pos = Number(msg.position);
          if (!(pos >= 0)) return reply({ ok: false, reason: "error", message: "bad position" });
          await live.ipc.command(["seek", pos, "absolute"]);
          live.position = pos;
          return reply({ ok: true, ...this.snapshot(live) });
        }
        case "stop":
          if (live) await this.finish(live, "stopped", undefined, false);
          return reply({ ok: true, state: "stopped" });
        case "status":
          return reply(live ? { ok: true, ...this.snapshot(live) } : { ok: true, state: "stopped" });
        case "audio":
        case "subtitle": {
          if (!live) return reply({ ok: false, reason: "error", message: "nothing is playing on this screen" });
          const ok = msg.op === "audio" ? await this.setAudio(live, String(msg.id)) : await this.setSubtitle(live, msg.id === null ? null : String(msg.id));
          if (!ok) return reply({ ok: false, reason: "unsupported", message: "that track isn't in the stream that's playing" });
          if (live.menu) this.drawMenu(live);
          return reply({ ok: true, ...this.snapshot(live) });
        }
        default:
          return reply({ ok: false, reason: "unsupported", message: `this player can't do "${String((msg as { op?: unknown }).op)}"` });
      }
    } catch (err) {
      reply({ ok: false, reason: "error", message: (err as Error).message.slice(0, 120) });
    }
  }

  private snapshot(p: Player, state = p.state) {
    return {
      state,
      ...(p.position !== undefined ? { position: p.position } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
      ...(p.audio !== undefined ? { audio: p.audio } : {}),
      ...(p.subtitle !== undefined ? { subtitle: p.subtitle } : {}),
    };
  }

  private async play(msg: Extract<VideoMsg, { op: "play" }>, reply: (r: Omit<VideoReplyMsg, "type" | "requestId">) => void) {
    if (!this.d.mpvPath) return reply({ ok: false, reason: "unsupported", message: "this computer has no video player" });
    if (typeof msg.url !== "string" || !/^https?:\/\//i.test(msg.url)) return reply({ ok: false, reason: "error", message: "the box sent a link this player can't open" });
    const g = this.d.geometry(msg.screen);
    if (!g) return reply({ ok: false, reason: "error", message: "that screen isn't connected" });
    const old = this.players.get(msg.screen);
    if (old && !old.done) await this.finish(old, "stopped", undefined, false); // replaced: the box knows

    const title = String(msg.title ?? "").slice(0, 200) || "Video";
    const pipe = process.platform === "win32" ? `\\\\.\\pipe\\venuebox-mpv-${randomBytes(8).toString("hex")}` : join(tmpdir(), `venuebox-mpv-${randomBytes(8).toString("hex")}.sock`);
    const start = secs(msg.startAt);
    const args = [
      ...(this.d.mpvPrefixArgs ?? []),
      "--no-config", // no user config, scripts, watch-later or history files
      "--no-terminal",
      "--idle=yes", // started empty; the link comes over IPC (loadfile), not argv
      "--force-window=immediate",
      `--geometry=${g.w}x${g.h}+${g.x}+${g.y}`, // that screen's monitor…
      ...(g.fs === false ? [] : ["--fs"]), // …then full screen on it (fs-screen "current" = where the window is)
      "--ontop",
      "--no-border",
      "--keep-open=no",
      "--hwdec=auto-safe",
      `--input-ipc-server=${pipe}`,
      "--ytdl=no", // the yt-dlp hook would put the link on another process's command line
      "--load-stats-overlay=no", // stats ("i") and console show the file path
      "--load-console=no",
      "--load-select=no",
      "--load-commands=no",
      "--load-auto-profiles=no",
      "--osd-playing-msg=",
      "--cursor-autohide=always",
      "--title=Venuebox video",
      ...(g.hdr ? ["--target-colorspace-hint"] : []),
      ...(start ? [`--start=${start}`] : []),
    ];
    this.d.log("video: starting the player", { screen: msg.screen, title, startAt: start });
    const proc = spawn(this.d.mpvPath, args, { stdio: "ignore", windowsHide: false });
    const ipc = new MpvIpc();
    const p: Player = { screen: msg.screen, title, proc, ipc, state: "loading", paused: false, buffering: false, started: false, done: false, lastPush: 0, loaded: false, tracks: cleanTracks(msg.tracks) };
    this.players.set(msg.screen, p);
    proc.once("error", (err) => {
      this.d.log("video: the player didn't start", { screen: p.screen, error: err.message });
      void this.finish(p, "error", "the video player didn't start");
    });
    proc.once("exit", (code) => {
      if (!p.done) void this.finish(p, p.started ? "stopped" : "error", p.started ? undefined : `the video player closed (${code ?? "killed"})`);
    });

    const ready = (async () => {
      await ipc.connect(pipe, this.t.playMs);
      ipc.on("property", (name: string, value: unknown) => this.onProperty(p, name, value));
      ipc.on("event", (e) => this.onEvent(p, e));
      ipc.on("close", () => {
        if (!p.done) void this.finish(p, p.started ? "stopped" : "error", p.started ? undefined : "the video player closed");
      });
      let id = 1;
      for (const prop of ["pause", "time-pos", "duration", "paused-for-cache", "eof-reached", "idle-active"]) await ipc.observe(prop, id++);
      await ipc.command(["set_property", "force-media-title", title]); // the window and OSD show this, not the link
      // Starting tracks, set before loadfile so the file opens with them.
      const a = startAudio(p.tracks);
      if (a) await this.setAudio(p, a).catch(() => false);
      if (p.tracks?.subtitleId !== undefined) await this.setSubtitle(p, p.tracks.subtitleId).catch(() => false);
      for (const [key, name] of DEVICE_KEYS) await ipc.command(["keybind", key, name === "ignore" ? "ignore" : `script-message venuebox ${name}`]).catch(() => {});
      await ipc.command(["loadfile", msg.url, "replace"]);
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([ready, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("the video player didn't start in time")), this.t.playMs)))]);
    } catch (err) {
      if (timer) clearTimeout(timer);
      await this.finish(p, "error", (err as Error).message, false);
      return reply({ ok: false, reason: "error", message: (err as Error).message.replace(/\\\\\.\\pipe\\\S+|\/\S+\.sock/g, "").slice(0, 120) });
    }
    if (timer) clearTimeout(timer);
    if (p.done) return reply({ ok: false, reason: "error", message: "the video player closed" });
    this.d.covering(p.screen, true);
    reply({ ok: true, state: "loading" });
  }

  private push(p: Player, state: VideoState, message?: string) {
    p.state = state;
    p.lastPush = Date.now();
    this.d.send({ type: "video-state", screen: p.screen, ...this.snapshot(p, state), ...(message ? { message } : {}) });
  }

  /** The state mpv is in now, from what it reported. */
  private current(p: Player): VideoState {
    if (!p.started || p.buffering) return "loading";
    return p.paused ? "paused" : "playing";
  }

  private onProperty(p: Player, name: string, value: unknown) {
    if (p.done) return;
    switch (name) {
      case "time-pos": {
        const v = secs(value);
        if (v !== undefined) p.position = v;
        // Progress while playing, at most every heartbeatMs.
        if (p.started && p.state === "playing" && Date.now() - p.lastPush >= this.t.heartbeatMs) this.push(p, "playing");
        return;
      }
      case "duration": {
        const v = secs(value);
        if (v !== undefined) p.duration = v;
        return;
      }
      case "pause":
        p.paused = value === true;
        break;
      case "paused-for-cache":
        p.buffering = value === true;
        break;
      default:
        return;
    }
    const now = this.current(p);
    if (p.started && now !== p.state) this.push(p, now);
  }

  private onEvent(p: Player, e: { event: string; [k: string]: unknown }) {
    if (p.done) return;
    if (e.event === "file-loaded") {
      p.loaded = true;
      const t = p.pendingSub;
      p.pendingSub = undefined;
      if (t) void this.addSideSubtitle(p, t);
    } else if (e.event === "client-message" && Array.isArray(e.args) && e.args[0] === "venuebox") {
      void this.deviceKey(p, String(e.args[1] ?? ""));
    } else if (e.event === "playback-restart" && !p.started) {
      p.started = true;
      this.d.log("video: playing", { screen: p.screen, title: p.title });
      this.push(p, this.current(p));
    } else if (e.event === "end-file") {
      const reason = String(e.reason ?? "");
      if (reason === "error") {
        const message = describeError(e.file_error);
        this.d.log("video: failed", { screen: p.screen, title: p.title, error: message });
        void this.finish(p, "error", message);
      } else if (reason === "eof" || reason === "quit" || reason === "stop") {
        this.d.log("video: ended", { screen: p.screen, title: p.title, reason });
        void this.finish(p, "stopped");
      }
    }
  }

  // ---------------------------------------------------------------- tracks (box 0.29.0)

  /** mpv numbers tracks of a kind from 1, in the file's order: aid = index + 1. False: not in this stream. */
  private async setAudio(p: Player, id: string): Promise<boolean> {
    const plan = planAudio(p.tracks, id);
    if (plan.kind !== "aid") return false;
    await p.ipc.command(["set_property", "aid", plan.value]);
    p.audio = id;
    return true;
  }

  private async setSubtitle(p: Player, id: string | null): Promise<boolean> {
    const plan = planSubtitle(p.tracks, id);
    if (plan.kind === "missing") return false;
    if (plan.kind === "sub-add") {
      // A side file can only be added to an open video; "cached" picks it again if it's there.
      if (p.loaded) await this.addSideSubtitle(p, plan.track);
      else p.pendingSub = plan.track;
    } else {
      p.pendingSub = undefined;
      await p.ipc.command(["set_property", "sid", plan.value]);
    }
    p.subtitle = id;
    return true;
  }

  /** sub-add over IPC only: the url carries the key (never logged). */
  private async addSideSubtitle(p: Player, t: Track) {
    try {
      await p.ipc.command(["sub-add", t.url, "cached", t.label, ...(t.language ? [t.language] : [])], 8000);
    } catch {
      this.d.log("video: the subtitle file didn't load", { screen: p.screen, title: p.title, subtitle: t.label });
      if (!p.done) await this.osd(p, `Subtitles "${t.label}" didn't load`);
    }
  }

  /** Something only the app can do (next episode, a track not in this stream). */
  private remote(p: Player, action: RemoteAsk, note: string) {
    this.d.log("video: asked the app", { screen: p.screen, action: typeof action === "string" ? action : Object.keys(action)[0] });
    this.d.send({ type: "video-remote", screen: p.screen, action });
    void this.osd(p, note);
  }

  /** A short message on the video. mpv expands ${...} in show-text: break it up in labels. */
  private async osd(p: Player, text: string, ms = 2500) {
    await p.ipc.command(["show-text", text.replace(/\$\{/g, "$ {"), ms]).catch(() => {});
  }

  // ---------------------------------------------------------------- keys and the menu (box 0.29.0)

  /** A key pressed at the PC in the player window (sent back by mpv, see DEVICE_KEYS). */
  private async deviceKey(p: Player, name: string): Promise<void> {
    if (p.done) return;
    switch (name) {
      case "audio":
      case "subtitle":
        return this.openMenu(p, name);
      case "up":
      case "down":
        if (p.menu) return this.moveMenu(p, name === "up" ? -1 : 1);
        await p.ipc.command(["seek", name === "up" ? 60 : -60, "relative"]).catch(() => {});
        return;
      case "select":
        if (p.menu) return this.pick(p);
        await p.ipc.command(["cycle", "pause"]).catch(() => {});
        return;
      case "back":
        if (p.menu) return this.closeMenu(p);
        this.d.log("video: stopped at the PC", { screen: p.screen, title: p.title });
        return this.finish(p, "stopped");
      case "next":
      case "previous":
        return this.remote(p, name, name === "next" ? "Next…" : "Previous…");
    }
  }

  /**
   * A remote key from the box (TVs page) while this screen's video plays. The box itself turns
   * Play/Rev/Fwd/Back into video ops; these are the rest (and those too, if they come).
   * False: no video here (the key goes to the page).
   */
  async remoteKey(screen: string, key: string): Promise<boolean> {
    const p = this.players.get(screen);
    if (!p || p.done) return false;
    const cmd = (c: unknown[]) => p.ipc.command(c).catch(() => undefined);
    switch (key) {
      case "Up":
      case "Down":
        if (p.menu) this.moveMenu(p, key === "Up" ? -1 : 1);
        else this.openMenu(p, "audio");
        break;
      case "Left":
      case "Right":
        if (p.menu) {
          p.menu = switchSection(p.menu);
          this.drawMenu(p);
        } else await cmd(["seek", key === "Left" ? -10 : 10, "relative"]);
        break;
      case "Select":
        if (p.menu) await this.pick(p);
        else await cmd(["cycle", "pause"]);
        break;
      case "Back":
      case "Home":
        if (p.menu) this.closeMenu(p);
        else await this.finish(p, "stopped");
        break;
      case "Play":
        await cmd(["cycle", "pause"]);
        break;
      case "Rev":
      case "Fwd":
        await cmd(["seek", key === "Rev" ? -30 : 30, "relative"]);
        break;
      case "VolumeUp":
      case "VolumeDown":
        await cmd(["add", "volume", key === "VolumeUp" ? 5 : -5]);
        await this.osd(p, `Volume ${Math.round(Number((await cmd(["get_property", "volume"])) ?? 0))}%`, 1200);
        break;
      case "VolumeMute":
        await cmd(["cycle", "mute"]);
        await this.osd(p, (await cmd(["get_property", "mute"])) === true ? "Muted" : "Sound on", 1200);
        break;
      default:
        return true; // a key with no meaning in the player: swallow it, don't type into the page under it
    }
    return true;
  }

  private openMenu(p: Player, section: "audio" | "subtitle") {
    p.menu = buildMenu(p.tracks, section, { audio: p.audio, subtitle: p.subtitle });
    this.drawMenu(p);
  }

  private moveMenu(p: Player, by: number) {
    if (!p.menu) return;
    p.menu = moveMenu(p.menu, by);
    this.drawMenu(p);
  }

  private drawMenu(p: Player) {
    if (!p.menu || p.done) return;
    if (p.menuTimer) clearTimeout(p.menuTimer);
    p.menuTimer = setTimeout(() => this.closeMenu(p), MENU_IDLE_MS);
    void p.ipc
      .command({ name: "osd-overlay", id: OSD_MENU, format: "ass-events", data: renderMenu(p.menu, { audio: p.audio, subtitle: p.subtitle }), res_x: 1920, res_y: 1080, z: 10 })
      .catch(() => {});
  }

  private closeMenu(p: Player) {
    if (p.menuTimer) clearTimeout(p.menuTimer);
    p.menuTimer = undefined;
    if (!p.menu) return;
    p.menu = undefined;
    if (!p.done) void p.ipc.command({ name: "osd-overlay", id: OSD_MENU, format: "none", data: "" }).catch(() => {});
  }

  /** Enter on a menu item: switch here if the stream has it, else ask the app (video-remote). */
  private async pick(p: Player) {
    const item = p.menu?.items[p.menu.cursor];
    this.closeMenu(p);
    if (!item) return;
    const ok = item.kind === "audio" ? await this.setAudio(p, item.id!).catch(() => false) : await this.setSubtitle(p, item.id).catch(() => false);
    if (!ok) return this.remote(p, item.kind === "audio" ? { audio: item.id! } : { subtitle: item.id }, `Switching to ${item.label}…`);
    await this.osd(p, item.kind === "audio" ? `Audio: ${item.label}` : item.id === null ? "Subtitles off" : `Subtitles: ${item.label}`);
    this.push(p, this.current(p)); // a change made on the device: the box hears the new ids
  }

  /** Closes the player: mpv quits, the page comes back, the box hears (unless it asked). */
  private async finish(p: Player, state: VideoState, message?: string, push = true) {
    if (p.done) return;
    p.done = true;
    if (p.menuTimer) clearTimeout(p.menuTimer);

    if (this.players.get(p.screen) === p) this.players.delete(p.screen);
    if (p.ipc.open) await p.ipc.command(["quit"], 1000).catch(() => {});
    p.ipc.close();
    const kill = setTimeout(() => p.proc.exitCode === null && p.proc.kill(), 2000);
    p.proc.once("exit", () => clearTimeout(kill));
    if (p.proc.exitCode !== null) clearTimeout(kill);
    this.d.covering(p.screen, false);
    if (push) this.push(p, state, message);
  }

  /** A new show/off for this screen, or it was unplugged: close its player. */
  async close(screen: string, why: string): Promise<void> {
    const p = this.players.get(screen);
    if (!p || p.done) return;
    this.d.log("video: closing the player", { screen, why });
    await this.finish(p, "stopped");
  }

  /** App quitting: no time for a clean quit, end every mpv now. */
  killAll() {
    for (const p of this.players.values()) {
      p.done = true;
      p.ipc.close();
      if (p.proc.exitCode === null) p.proc.kill();
    }
    this.players.clear();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.players.keys()].map((s) => this.close(s, "app quitting")));
  }
}

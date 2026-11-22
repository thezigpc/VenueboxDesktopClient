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
import type { ClientMsg, VideoMsg, VideoReplyMsg, VideoState } from "./protocol";

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
        default:
          return reply({ ok: false, reason: "unsupported", message: `this player can't do "${String((msg as { op?: unknown }).op)}"` });
      }
    } catch (err) {
      reply({ ok: false, reason: "error", message: (err as Error).message.slice(0, 120) });
    }
  }

  private snapshot(p: Player, state = p.state) {
    return { state, ...(p.position !== undefined ? { position: p.position } : {}), ...(p.duration !== undefined ? { duration: p.duration } : {}) };
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
    const p: Player = { screen: msg.screen, title, proc, ipc, state: "loading", paused: false, buffering: false, started: false, done: false, lastPush: 0 };
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
    if (e.event === "playback-restart" && !p.started) {
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

  /** Closes the player: mpv quits, the page comes back, the box hears (unless it asked). */
  private async finish(p: Player, state: VideoState, message?: string, push = true) {
    if (p.done) return;
    p.done = true;
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

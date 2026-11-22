// Video (box 0.28.0): VideoPlayers against a fake mpv (test/fake-mpv.ts). Every op gets one
// video-reply; video-state when the player changes by itself; the link never leaves the IPC.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoPlayers } from "../src/video";
import { isHdrColorSpace, videoCaps } from "../src/video-caps";
import type { ClientMsg, VideoMsg, VideoReplyMsg, VideoStateMsg } from "../src/protocol";

const SECRET = "api_key=SECRET-7f3a9c";
const URL_OK = `http://media.example:8096/Videos/abc/stream.mkv?static=true&${SECRET}`;
const URL_SHORT = `http://media.example:8096/Videos/short/stream.mp4?${SECRET}`;
const URL_FAIL = `http://media.example:8096/Videos/fail/stream.mp4?${SECRET}`;

function setup(o: { mpv?: boolean } = {}) {
  const sent: ClientMsg[] = [];
  const logs: string[] = [];
  const covering: [string, boolean][] = [];
  const mpvLog = join(tmpdir(), `fake-mpv-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  process.env.FAKE_MPV_LOG = mpvLog;
  const v = new VideoPlayers({
    mpvPath: o.mpv === false ? undefined : process.execPath,
    mpvPrefixArgs: [join(__dirname, "fake-mpv.js")],
    send: (m) => sent.push(m),
    log: (msg, extra) => logs.push(`${msg} ${JSON.stringify(extra ?? {})}`),
    geometry: (s) => (s === "1" ? { x: 0, y: 0, w: 3840, h: 2160 } : undefined),
    covering: (s, on) => covering.push([s, on]),
    timing: { heartbeatMs: 200 },
  });
  const replies = () => sent.filter((m): m is VideoReplyMsg => m.type === "video-reply");
  const states = () => sent.filter((m): m is VideoStateMsg => m.type === "video-state");
  const mpvLines = () => {
    try {
      return readFileSync(mpvLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const cleanup = async () => {
    await v.closeAll();
    await new Promise((r) => setTimeout(r, 100));
    rmSync(mpvLog, { force: true });
  };
  return { v, sent, logs, covering, replies, states, mpvLines, cleanup };
}

async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const r = fn();
    if (r) return r;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((res) => setTimeout(res, 15));
  }
}

const play = (requestId: string, url: string, extra: Partial<Extract<VideoMsg, { op: "play" }>> = {}): VideoMsg => ({ type: "video", screen: "1", requestId, op: "play", url, title: "Big Buck Bunny", ...extra });
const op = (requestId: string, o: "pause" | "resume" | "stop" | "status"): VideoMsg => ({ type: "video", screen: "1", requestId, op: o });

test("play: replies ok while loading, then video-state playing; link only over IPC", async () => {
  const t = setup();
  try {
    await t.v.handle(play("r1", URL_OK, { startAt: 42 }));
    assert.deepEqual(t.replies()[0], { type: "video-reply", requestId: "r1", ok: true, state: "loading" });
    assert.deepEqual(t.covering, [["1", true]]);
    const playing = await until(() => t.states().find((s) => s.state === "playing"));
    assert.equal(playing.screen, "1");
    assert.equal(playing.duration, 120);
    // The link reached mpv by loadfile over the pipe, and nowhere else.
    const lines = t.mpvLines();
    const argv = lines.find((l) => l.startsWith("ARGV "))!;
    assert.ok(!argv.includes("SECRET") && !argv.includes("media.example"), "link on the command line");
    assert.ok(argv.includes("--start=42") && argv.includes("--geometry=3840x2160+0+0") && argv.includes("--fs"));
    assert.ok(argv.includes("--ytdl=no") && argv.includes("--no-config") && argv.includes("--load-stats-overlay=no"));
    assert.ok(lines.some((l) => l.startsWith("CMD ") && l.includes("loadfile") && l.includes("SECRET")));
    assert.ok(lines.some((l) => l.includes("force-media-title") && l.includes("Big Buck Bunny")));
  } finally {
    await t.cleanup();
  }
  // Never in our logs or messages.
  assert.ok(!t.logs.join("\n").includes("SECRET"), "link in the log");
  assert.ok(!JSON.stringify(t.sent).includes("SECRET"), "link in a message");
});

test("pause, resume, seek, status: one reply each; heartbeat while playing", async () => {
  const t = setup();
  try {
    await t.v.handle(play("p", URL_OK));
    await until(() => t.states().find((s) => s.state === "playing"));
    await t.v.handle(op("a", "pause"));
    const paused = t.replies().find((r) => r.requestId === "a")!;
    assert.equal(paused.ok, true);
    assert.equal(paused.state, "paused");
    await until(() => t.states().some((s) => s.state === "paused"));
    await t.v.handle(op("b", "resume"));
    assert.equal(t.replies().find((r) => r.requestId === "b")!.ok, true);
    await until(() => t.states().filter((s) => s.state === "playing").length >= 2);
    await t.v.handle({ type: "video", screen: "1", requestId: "c", op: "seek", position: 90 });
    const sk = t.replies().find((r) => r.requestId === "c")!;
    assert.equal(sk.ok, true);
    assert.ok(sk.position! >= 90);
    await t.v.handle(op("d", "status"));
    const st = t.replies().find((r) => r.requestId === "d")!;
    assert.equal(st.ok, true);
    assert.equal(st.state, "playing");
    assert.ok(st.position! >= 90 && st.duration === 120);
    // Heartbeat: periodic "playing" states with a position, at most every heartbeatMs (200 here).
    const before = t.states().length;
    await new Promise((r) => setTimeout(r, 700));
    const beats = t.states().slice(before).filter((s) => s.state === "playing");
    assert.ok(beats.length >= 2 && beats.length <= 4, `beats ${beats.length}`);
    assert.ok(beats.every((s) => typeof s.position === "number"));
    // Exactly one reply per request.
    for (const id of ["p", "a", "b", "c", "d"]) assert.equal(t.replies().filter((r) => r.requestId === id).length, 1, id);
  } finally {
    await t.cleanup();
  }
});

test("the video ends by itself → video-state stopped, the player closes, the page comes back", async () => {
  const t = setup();
  try {
    await t.v.handle(play("s", URL_SHORT));
    await until(() => t.states().find((s) => s.state === "stopped"));
    assert.equal(t.v.isPlaying("1"), false);
    await until(() => t.covering.some(([, on]) => on === false));
    await until(() => t.mpvLines().some((l) => l.includes('CMD ["quit"]')));
  } finally {
    await t.cleanup();
  }
});

test("a stream that fails → video-state error with a message that has no link", async () => {
  const t = setup();
  try {
    await t.v.handle(play("f", URL_FAIL));
    assert.equal(t.replies()[0].ok, true); // accepted while loading
    const err = await until(() => t.states().find((s) => s.state === "error"));
    assert.match(err.message!, /couldn't open the stream/);
    assert.ok(!err.message!.includes("SECRET") && !err.message!.includes("http"));
  } finally {
    await t.cleanup();
  }
});

test("stop (asked by the box): reply ok, no extra video-state; stop/status with nothing playing", async () => {
  const t = setup();
  try {
    await t.v.handle(op("n1", "status"));
    assert.deepEqual(t.replies()[0], { type: "video-reply", requestId: "n1", ok: true, state: "stopped" });
    await t.v.handle(op("n2", "pause"));
    assert.equal(t.replies()[1].ok, false);
    assert.equal(t.replies()[1].reason, "error");
    await t.v.handle(play("p", URL_OK));
    await until(() => t.states().find((s) => s.state === "playing"));
    const statesBefore = t.states().length;
    await t.v.handle(op("x", "stop"));
    assert.deepEqual(t.replies().find((r) => r.requestId === "x"), { type: "video-reply", requestId: "x", ok: true, state: "stopped" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.states().length, statesBefore);
    assert.equal(t.v.isPlaying("1"), false);
  } finally {
    await t.cleanup();
  }
});

test("a new show closes the player (video-state stopped); a new play replaces the old one", async () => {
  const t = setup();
  try {
    await t.v.handle(play("p1", URL_OK));
    await until(() => t.states().find((s) => s.state === "playing"));
    await t.v.handle(play("p2", URL_OK));
    assert.equal(t.replies().find((r) => r.requestId === "p2")!.ok, true);
    assert.equal(t.v.isPlaying("1"), true);
    const n = t.states().filter((s) => s.state === "stopped").length;
    await t.v.close("1", "new show");
    assert.equal(t.states().filter((s) => s.state === "stopped").length, n + 1);
    assert.equal(t.v.isPlaying("1"), false);
  } finally {
    await t.cleanup();
  }
});

test("refusals: no player, unknown screen, unknown op, non-http link", async () => {
  const none = setup({ mpv: false });
  await none.v.handle(play("a", URL_OK));
  assert.deepEqual(none.replies()[0], { type: "video-reply", requestId: "a", ok: false, reason: "unsupported", message: "this computer has no video player" });
  const t = setup();
  try {
    await t.v.handle({ ...play("b", URL_OK), screen: "9" } as VideoMsg);
    assert.equal(t.replies()[0].ok, false);
    await t.v.handle({ type: "video", screen: "1", requestId: "c", op: "rewind" } as unknown as VideoMsg);
    assert.equal(t.replies()[1].reason, "unsupported");
    await t.v.handle(play("d", "file:///C:/movie.mkv"));
    assert.equal(t.replies()[2].ok, false);
    assert.equal(t.mpvLines().length, 0, "no player started");
  } finally {
    await t.cleanup();
  }
});

test("caps: h264 always; hevc/av1/vp9 and 4K only with hardware decoding", () => {
  const none = videoCaps({}, 2160);
  assert.deepEqual(none.video, ["h264"]);
  assert.equal(none.maxHeight, 1080);
  assert.equal(none.seek, true);
  assert.equal(none.passthrough, undefined);
  assert.deepEqual(none.containers, ["mp4", "mkv", "mov", "webm", "ts", "hls"]);
  const yes = { supported: true, smooth: true, powerEfficient: true };
  const sw = { supported: true, smooth: true, powerEfficient: false };
  const gpu = videoCaps({ "h264@1080": yes, "h264@2160": yes, "hevc@1080": yes, "hevc@2160": yes, "vp9@1080": sw, "av1@1080": yes }, 2160);
  assert.deepEqual(gpu.video, ["h264", "hevc", "av1"]);
  assert.equal(gpu.maxHeight, 2160);
  assert.equal(videoCaps({ "hevc@2160": yes }, 1080).maxHeight, 1080); // no 4K monitor
});

test("ranges: sdr only, plus hdr10/hlg with a monitor in Windows HDR mode", () => {
  assert.deepEqual(videoCaps({}, 1080).ranges, ["sdr"]);
  assert.deepEqual(videoCaps({}, 2160, true).ranges, ["sdr", "hdr10", "hlg"]);
  assert.equal(isHdrColorSpace("{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}"), false); // this VM
  assert.equal(isHdrColorSpace("{primaries:BT709, transfer:SCRGB_LINEAR_80_NITS, matrix:RGB, range:FULL}"), true); // Windows HDR on
  assert.equal(isHdrColorSpace("{primaries:BT2020, transfer:PQ, matrix:RGB, range:FULL}"), true);
  assert.equal(isHdrColorSpace(undefined), false);
});

test("an HDR monitor gets --target-colorspace-hint; SDR doesn't", async () => {
  const { VideoPlayers: VP } = await import("../src/video");
  for (const hdr of [true, false]) {
    const log = join(tmpdir(), `fake-mpv-hdr-${process.pid}-${hdr}.log`);
    process.env.FAKE_MPV_LOG = log;
    const sent: ClientMsg[] = [];
    const v = new VP({ mpvPath: process.execPath, mpvPrefixArgs: [join(__dirname, "fake-mpv.js")], send: (m) => sent.push(m), log: () => {}, geometry: () => ({ x: 0, y: 0, w: 3840, h: 2160, hdr }), covering: () => {} });
    await v.handle(play("h", URL_OK));
    const argv = readFileSync(log, "utf8").split(/\r?\n/).find((l) => l.startsWith("ARGV "))!;
    assert.equal(argv.includes("--target-colorspace-hint"), hdr);
    await v.closeAll();
    await new Promise((r) => setTimeout(r, 80));
    rmSync(log, { force: true });
  }
});

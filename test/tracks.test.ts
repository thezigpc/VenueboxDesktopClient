// Box 0.29.0: audio tracks, subtitles and the remote, for the mpv player.
// Pure rules (src/video-tracks.ts), then VideoPlayers with the fake mpv, pressing keys in the
// "player window" through a second IPC client (as a keyboard at the PC would).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MpvIpc } from "../src/mpv-ipc";
import { VideoPlayers } from "../src/video";
import { buildMenu, cleanTracks, moveMenu, planAudio, planSubtitle, renderMenu, startAudio, switchSection } from "../src/video-tracks";
import type { ClientMsg, Tracks, VideoMsg, VideoRemoteMsg, VideoReplyMsg, VideoStateMsg } from "../src/protocol";

const KEY = "api_key=SECRET-7f3a9c";
const URL_OK = `http://media.example:8096/Videos/abc/stream.mkv?${KEY}`;
const SUB_URL = `http://media.example:8096/Videos/abc/Subtitles/3/0/Stream.vtt?${KEY}`;

const TRACKS: Tracks = {
  audio: [
    { id: "a1", label: "English 5.1", language: "eng", index: 0, default: true },
    { id: "a2", label: "Commentary", language: "eng", index: 1 },
    { id: "a9", label: "Français (other version)", language: "fra" }, // not in this stream
  ],
  subtitles: [
    { id: "s1", label: "English", language: "eng", index: 0 },
    { id: "s2", label: "Español (file)", language: "spa", url: SUB_URL, format: "vtt" },
    { id: "s9", label: "Deutsch (burn-in)", language: "deu" }, // not in this stream
  ],
  audioId: "a1",
  subtitleId: null,
};

// ---------------------------------------------------------------- pure rules

test("tracks: index → aid/sid = index + 1, url → sub-add, neither → missing", () => {
  assert.deepEqual(planAudio(TRACKS, "a2"), { kind: "aid", value: 2 });
  assert.deepEqual(planAudio(TRACKS, "a9"), { kind: "missing" });
  assert.deepEqual(planAudio(TRACKS, "nope"), { kind: "missing" });
  assert.deepEqual(planSubtitle(TRACKS, "s1"), { kind: "sid", value: 1 });
  assert.deepEqual(planSubtitle(TRACKS, null), { kind: "sid", value: "no" });
  assert.equal(planSubtitle(TRACKS, "s2").kind, "sub-add");
  assert.deepEqual(planSubtitle(TRACKS, "s9"), { kind: "missing" });
  assert.equal(startAudio(TRACKS), "a1");
  assert.equal(startAudio({ audio: [{ id: "x", label: "X" }, { id: "y", label: "Y", index: 0 }] }), "y");
  assert.equal(startAudio(undefined), undefined);
});

test("cleanTracks drops junk, keeps side-file urls only for subtitles", () => {
  const t = cleanTracks({
    audio: [{ id: "ok", label: "OK", index: 2 }, { id: "bad id!", label: "x" }, { label: "no id" }, { id: "u", label: "U", url: "http://x/a.mka" }],
    subtitles: [{ id: "s", label: "S", url: "file:///etc/passwd" }, { id: "t", label: "T", url: "https://x/t.srt", index: -1 }],
    audioId: "gone",
    subtitleId: "t",
  })!;
  assert.deepEqual(t.audio!.map((x) => x.id), ["ok", "u"]);
  assert.equal(t.audio![1].url, undefined); // audio has no side files
  assert.equal(t.subtitles![0].url, undefined); // file: refused
  assert.equal(t.subtitles![1].url, "https://x/t.srt");
  assert.equal(t.subtitles![1].index, undefined);
  assert.equal(t.audioId, undefined); // not in the list
  assert.equal(t.subtitleId, "t");
  assert.equal(cleanTracks(undefined), undefined);
});

test("menu: Audio then Subtitles (with Off), starts on what's on, moves and wraps; labels only", () => {
  const m = buildMenu(TRACKS, "subtitle", { audio: "a1", subtitle: null });
  assert.deepEqual(m.items.map((i) => i.label), ["English 5.1", "Commentary", "Français (other version)", "Off", "English", "Español (file)", "Deutsch (burn-in)"]);
  assert.equal(m.items[m.cursor].label, "Off");
  assert.equal(moveMenu(m, -1).cursor, 2);
  assert.equal(moveMenu(m, 4).cursor, 0); // wraps
  assert.equal(switchSection(m).items[switchSection(m).cursor].kind, "audio");
  const a = buildMenu(TRACKS, "audio", { audio: "a2" });
  assert.equal(a.items[a.cursor].id, "a2");
  const ass = renderMenu(m, { audio: "a1", subtitle: null });
  assert.ok(ass.includes("English 5.1") && ass.includes("Subtitles") && ass.includes("✓"));
  assert.ok(!ass.includes("http") && !ass.includes("SECRET"), "a url in the menu");
  const tricky = renderMenu(buildMenu({ audio: [{ id: "x", label: "{\\pos(0,0)}evil", index: 0 }] }, "audio", {}), {});
  assert.ok(!tricky.includes("{\\pos(0,0)}evil"), "ASS override in a label");
  assert.ok(renderMenu(buildMenu(undefined, "audio", {}), {}).includes("No other audio tracks"));
});

// ---------------------------------------------------------------- the player (fake mpv)

function setup() {
  const sent: ClientMsg[] = [];
  const logs: string[] = [];
  const mpvLog = join(tmpdir(), `fake-mpv-tracks-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  process.env.FAKE_MPV_LOG = mpvLog;
  const v = new VideoPlayers({
    mpvPath: process.execPath,
    mpvPrefixArgs: [join(__dirname, "fake-mpv.js")],
    send: (m) => sent.push(m),
    log: (msg, extra) => logs.push(`${msg} ${JSON.stringify(extra ?? {})}`),
    geometry: () => ({ x: 0, y: 0, w: 1920, h: 1080 }),
    covering: () => {},
    timing: { heartbeatMs: 60_000 },
  });
  const lines = () => {
    try {
      return readFileSync(mpvLog, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };
  const cmds = () => lines().filter((l) => l.startsWith("CMD ")).map((l) => l.slice(4));
  /** A keyboard at the PC: a second IPC client presses keys in the player window. */
  const keyboard = async () => {
    const pipe = JSON.parse(lines().find((l) => l.startsWith("ARGV "))!.slice(5)).find((a: string) => a.startsWith("--input-ipc-server=")).slice(19);
    const kb = new MpvIpc();
    await kb.connect(pipe);
    return { press: (k: string) => kb.command(["keypress", k]), close: () => kb.close() };
  };
  const replies = () => sent.filter((m): m is VideoReplyMsg => m.type === "video-reply");
  const states = () => sent.filter((m): m is VideoStateMsg => m.type === "video-state");
  const remotes = () => sent.filter((m): m is VideoRemoteMsg => m.type === "video-remote");
  const cleanup = async () => {
    await v.closeAll();
    await new Promise((r) => setTimeout(r, 100));
    rmSync(mpvLog, { force: true });
  };
  return { v, sent, logs, cmds, keyboard, replies, states, remotes, cleanup };
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** null: a play with no tracks at all. */
const play = (tracks: Tracks | null = TRACKS): VideoMsg => ({ type: "video", screen: "1", requestId: "p", op: "play", url: URL_OK, title: "Movie", ...(tracks ? { tracks } : {}) });
const ask = (requestId: string, op: "audio" | "subtitle", id: string | null): VideoMsg => ({ type: "video", screen: "1", requestId, op, id } as VideoMsg);

test("play with tracks: starting audio/subtitle set before loadfile; status reports them", async () => {
  const t = setup();
  try {
    await t.v.handle(play({ ...TRACKS, audioId: "a2", subtitleId: "s1" }));
    await until(() => t.states().find((s) => s.state === "playing"));
    const c = t.cmds();
    const at = (needle: string) => c.findIndex((x) => x.includes(needle));
    assert.ok(at('"aid",2') >= 0 && at('"aid",2') < at('"loadfile"'), "aid before loadfile");
    assert.ok(at('"sid",1') >= 0 && at('"sid",1') < at('"loadfile"'), "sid before loadfile");
    assert.ok(c.some((x) => x.includes('"keybind","a","script-message venuebox audio"')));
    await t.v.handle({ type: "video", screen: "1", requestId: "st", op: "status" });
    const st = t.replies().find((r) => r.requestId === "st")!;
    assert.equal(st.audio, "a2");
    assert.equal(st.subtitle, "s1");
  } finally {
    await t.cleanup();
  }
});

test("a side-file subtitle: sub-add after file-loaded, over IPC only; never logged or sent", async () => {
  const t = setup();
  try {
    await t.v.handle(play({ ...TRACKS, subtitleId: "s2" }));
    await until(() => t.cmds().some((x) => x.startsWith('["sub-add"')));
    const c = t.cmds();
    assert.ok(c.findIndex((x) => x.startsWith('["sub-add"')) > c.findIndex((x) => x.includes('"loadfile"')), "sub-add waits for the file");
    assert.ok(c.find((x) => x.startsWith('["sub-add"'))!.includes(SUB_URL) && c.find((x) => x.startsWith('["sub-add"'))!.includes('"cached","Español (file)","spa"'));
    await until(() => t.states().find((s) => s.state === "playing"));
    assert.equal(t.states().at(-1)!.subtitle, "s2");
  } finally {
    await t.cleanup();
  }
  assert.ok(!t.logs.join("\n").includes("SECRET") && !JSON.stringify(t.sent).includes("SECRET"), "the key leaked");
});

test('ops "audio"/"subtitle": switch in the stream, "unsupported" for one it lacks, null = off', async () => {
  const t = setup();
  try {
    await t.v.handle(play());
    await until(() => t.states().find((s) => s.state === "playing"));
    await t.v.handle(ask("x1", "audio", "a2"));
    assert.deepEqual([t.replies().at(-1)!.ok, t.replies().at(-1)!.audio], [true, "a2"]);
    assert.ok(t.cmds().some((x) => x === '["set_property","aid",2]'));
    await t.v.handle(ask("x2", "audio", "a9"));
    assert.deepEqual([t.replies().at(-1)!.ok, t.replies().at(-1)!.reason], [false, "unsupported"]);
    await t.v.handle(ask("x3", "subtitle", "s1"));
    assert.equal(t.replies().at(-1)!.subtitle, "s1");
    await t.v.handle(ask("x4", "subtitle", null));
    assert.equal(t.replies().at(-1)!.ok, true);
    assert.equal(t.replies().at(-1)!.subtitle, null);
    assert.ok(t.cmds().some((x) => x === '["set_property","sid","no"]'));
    await t.v.handle(ask("x5", "subtitle", "s9"));
    assert.equal(t.replies().at(-1)!.reason, "unsupported");
    for (const id of ["x1", "x2", "x3", "x4", "x5"]) assert.equal(t.replies().filter((r) => r.requestId === id).length, 1);
  } finally {
    await t.cleanup();
  }
});

test("keyboard at the PC: A opens the menu, ↓ Enter switches audio and the box hears it", async () => {
  const t = setup();
  try {
    await t.v.handle(play());
    await until(() => t.states().find((s) => s.state === "playing"));
    const kb = await t.keyboard();
    await kb.press("a");
    await until(() => t.cmds().some((x) => x.includes('"osd-overlay"') && x.includes("ass-events")));
    await kb.press("DOWN");
    await kb.press("ENTER");
    await until(() => t.cmds().some((x) => x === '["set_property","aid",2]'));
    const st = await until(() => t.states().find((s) => s.audio === "a2"));
    assert.equal(st.state, "playing");
    assert.ok(t.cmds().some((x) => x.includes('"osd-overlay"') && x.includes('"format":"none"')), "menu closed");
    // A track not in this stream: ask the app.
    await kb.press("a");
    await kb.press("DOWN");
    await kb.press("ENTER"); // a2 → a9 (Français, not in the stream)
    const r = await until(() => t.remotes().at(-1));
    assert.deepEqual(r, { type: "video-remote", screen: "1", action: { audio: "a9" } });
    // Next episode (> or the media key).
    await kb.press(">");
    await until(() => t.remotes().some((x) => x.action === "next"));
    await kb.press("PREV");
    await until(() => t.remotes().some((x) => x.action === "previous"));
    // Esc with no menu: stop, the page comes back.
    await kb.press("ESC");
    await until(() => t.states().find((s) => s.state === "stopped"));
    assert.equal(t.v.isPlaying("1"), false);
    kb.close();
  } finally {
    await t.cleanup();
  }
});

test("remote keys from the box: ↓ opens/moves the menu, Select picks, ←/→ seek, volume, Home stops", async () => {
  const t = setup();
  try {
    assert.equal(await t.v.remoteKey("1", "Up"), false); // nothing playing: the page gets it
    await t.v.handle(play());
    await until(() => t.states().find((s) => s.state === "playing"));
    assert.equal(await t.v.remoteKey("1", "Down"), true); // opens on the audio now on (a1)
    await t.v.remoteKey("1", "Right"); // → Subtitles section ("Off")
    await t.v.remoteKey("1", "Down"); // English (s1, in the stream)
    await t.v.remoteKey("1", "Select");
    await until(() => t.cmds().some((x) => x === '["set_property","sid",1]'));
    await until(() => t.states().find((s) => s.subtitle === "s1"));
    await t.v.remoteKey("1", "Right"); // menu closed: seek +10
    await until(() => t.cmds().some((x) => x === '["seek",10,"relative"]'));
    await t.v.remoteKey("1", "Left");
    await until(() => t.cmds().some((x) => x === '["seek",-10,"relative"]'));
    await t.v.remoteKey("1", "VolumeDown");
    await until(() => t.cmds().some((x) => x === '["add","volume",-5]'));
    await t.v.remoteKey("1", "VolumeMute");
    await until(() => t.cmds().some((x) => x === '["cycle","mute"]'));
    await t.v.remoteKey("1", "Select"); // menu closed: pause
    await until(() => t.states().find((s) => s.state === "paused"));
    await t.v.remoteKey("1", "Home");
    await until(() => t.states().find((s) => s.state === "stopped"));
    assert.equal(await t.v.remoteKey("1", "Down"), false); // the page has the keys again
  } finally {
    await t.cleanup();
  }
});

test("no tracks given: the menu says so, switches answer unsupported", async () => {
  const t = setup();
  try {
    await t.v.handle(play(null));
    await until(() => t.states().find((s) => s.state === "playing"));
    await t.v.handle(ask("n", "audio", "a1"));
    assert.equal(t.replies().at(-1)!.reason, "unsupported");
    await t.v.remoteKey("1", "Down");
    await until(() => t.cmds().some((x) => x.includes("No other audio tracks")));
    await wait(50);
  } finally {
    await t.cleanup();
  }
});

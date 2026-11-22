// Box 0.29.0 tracks: what play's `tracks` mean for mpv, and the "Audio & subtitles" menu
// drawn on the video (mpv osd-overlay). No Electron imports (unit-tested).
//
//   Track.index (0-based among its kind, container order) → mpv aid / sid = index + 1
//   Track.url (subtitles: a vtt/srt/ass side file)        → mpv sub-add, once the file is loaded
//   neither                                               → not in this stream: the app restarts
//                                                           the stream with it (video-remote)
//
// A subtitle url carries the media server's key: it goes to mpv over IPC only, and is never
// logged or rendered (the menu shows labels).

import type { Track, Tracks } from "./protocol";

const ID = /^[\w.:-]{1,64}$/;

function cleanTrack(t: unknown, subtitle: boolean): Track | undefined {
  const o = (t ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID.test(o.id)) return undefined;
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : o.id;
  const out: Track = { id: o.id, label };
  if (typeof o.language === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i.test(o.language)) out.language = o.language;
  if (Number.isInteger(o.index) && (o.index as number) >= 0 && (o.index as number) < 100) out.index = o.index as number;
  if (subtitle && typeof o.url === "string" && /^https?:\/\//i.test(o.url)) out.url = o.url;
  if (typeof o.format === "string") out.format = o.format.slice(0, 8);
  if (o.forced === true) out.forced = true;
  if (o.default === true) out.default = true;
  return out;
}

/** play's tracks, cleaned up (bad entries dropped, side-file urls only for subtitles). */
export function cleanTracks(v: unknown): Tracks | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const list = (x: unknown, sub: boolean) => (Array.isArray(x) ? x.slice(0, 64).map((t) => cleanTrack(t, sub)).filter((t): t is Track => Boolean(t)) : []);
  const tracks: Tracks = { audio: list(o.audio, false), subtitles: list(o.subtitles, true) };
  if (typeof o.audioId === "string" && tracks.audio!.some((t) => t.id === o.audioId)) tracks.audioId = o.audioId;
  if (o.subtitleId === null) tracks.subtitleId = null;
  else if (typeof o.subtitleId === "string" && tracks.subtitles!.some((t) => t.id === o.subtitleId)) tracks.subtitleId = o.subtitleId;
  return tracks;
}

/** What switching to a track means for mpv. */
export type TrackPlan =
  | { kind: "aid" | "sid"; value: number | "no" }
  | { kind: "sub-add"; track: Track }
  | { kind: "missing" }; // not in this stream (or unknown id)

export function planAudio(tracks: Tracks | undefined, id: string): TrackPlan {
  const t = tracks?.audio?.find((x) => x.id === id);
  return t?.index !== undefined ? { kind: "aid", value: t.index + 1 } : { kind: "missing" };
}

export function planSubtitle(tracks: Tracks | undefined, id: string | null): TrackPlan {
  if (id === null) return { kind: "sid", value: "no" };
  const t = tracks?.subtitles?.find((x) => x.id === id);
  if (!t) return { kind: "missing" };
  if (t.index !== undefined) return { kind: "sid", value: t.index + 1 };
  if (t.url) return { kind: "sub-add", track: t };
  return { kind: "missing" };
}

/** The track a video starts with: audioId, else the default one, else the first in the stream. */
export function startAudio(tracks: Tracks | undefined): string | undefined {
  const a = tracks?.audio ?? [];
  return tracks?.audioId ?? a.find((t) => t.default && t.index !== undefined)?.id ?? a.find((t) => t.index !== undefined)?.id;
}

// ---------------------------------------------------------------- the menu

export interface MenuItem {
  kind: "audio" | "subtitle";
  /** Subtitle null: "Off". */
  id: string | null;
  label: string;
}

export interface Menu {
  items: MenuItem[];
  cursor: number;
}

export function buildMenu(tracks: Tracks | undefined, section: "audio" | "subtitle", current: { audio?: string; subtitle?: string | null }): Menu {
  const items: MenuItem[] = [
    ...(tracks?.audio ?? []).map((t) => ({ kind: "audio" as const, id: t.id, label: t.label })),
    ...((tracks?.subtitles ?? []).length ? [{ kind: "subtitle" as const, id: null, label: "Off" }] : []),
    ...(tracks?.subtitles ?? []).map((t) => ({ kind: "subtitle" as const, id: t.id, label: t.label })),
  ];
  // Start on what's on now in the section asked for (else the section's first item).
  const want = section === "audio" ? current.audio : current.subtitle;
  let cursor = items.findIndex((i) => i.kind === section && i.id === (want ?? (section === "subtitle" ? null : undefined)));
  if (cursor < 0) cursor = Math.max(0, items.findIndex((i) => i.kind === section));
  return { items, cursor };
}

export function moveMenu(m: Menu, by: number): Menu {
  if (!m.items.length) return m;
  return { ...m, cursor: (m.cursor + by + m.items.length) % m.items.length };
}

/** Left/Right: jump between the Audio and Subtitles sections. */
export function switchSection(m: Menu): Menu {
  const here = m.items[m.cursor]?.kind;
  const i = m.items.findIndex((x) => x.kind !== here);
  return i >= 0 ? { ...m, cursor: i } : m;
}

/** ASS text for mpv's osd-overlay (1920x1080 space): labels only, never a url. */
export function renderMenu(m: Menu, current: { audio?: string; subtitle?: string | null }): string {
  const esc = (s: string) => s.replace(/\\/g, "/").replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\n/g, " ");
  const lines: string[] = ["{\\b1}Audio & subtitles{\\b0}"];
  if (!m.items.length) lines.push("No other audio tracks or subtitles");
  let section = "";
  m.items.forEach((it, i) => {
    if (it.kind !== section) {
      section = it.kind;
      lines.push("", `{\\b1}${it.kind === "audio" ? "Audio" : "Subtitles"}{\\b0}`);
    }
    const on = it.kind === "audio" ? current.audio === it.id : (current.subtitle ?? null) === it.id;
    const mark = i === m.cursor ? "{\\1c&H2BA8F5&}▶ " : "{\\1c&HFFFFFF&}   ";
    lines.push(`${mark}${esc(it.label)}${on ? "  ✓" : ""}{\\1c&HFFFFFF&}`);
  });
  lines.push("", "{\\fs28}↑↓ choose · Enter pick · Esc close");
  return `{\\an7}{\\pos(80,80)}{\\fs40}{\\bord3}{\\shad0}{\\3c&H000000&}${lines.join("\\N")}`;
}

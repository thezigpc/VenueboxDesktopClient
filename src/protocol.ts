// Venuebox client protocol v1, mirrored from the box:
// C:\CodeProjects\GameBroker\apps\broker\src\venuebox\protocol.ts (the source of truth).
// Don't change shapes here without changing them there first (docs/NATIVE-CLIENTS.md).
//
// HTTP (pairing), on http://<box LAN address>:7210:
//   POST /pair/start   { name, platform, model?, appVersion?, screens: Screen[] }
//                      → { pairingId, code, expiresAt, pollMs }
//   GET  /pair/status?id=<pairingId>
//                      → { status: "pending" } | { status: "approved", deviceId, token, wsPath }
//                        (the token is handed out once) | 404 { status: "expired" }
//   GET  /health       → { ok, box, protocol }
// WebSocket /client: JSON messages; the client's first message is "hello".

export const CLIENT_PROTOCOL = 1;
export const DEFAULT_PORT = 7210;

export interface Screen {
  /** Stable per device (the OS display id); 1-64 chars of [\w.:-]. */
  id: string;
  name: string;
  w: number;
  h: number;
  hz?: number;
}

export type Delivery = "native-url" | "hls";

/**
 * Box 0.28.0: what the client's video player plays, lower-case Jellyfin names: containers
 * "mp4" "mkv" "mov" "webm" "ts" "hls"; video "h264" "hevc" "av1" "vp9"; audio "aac" "mp3"
 * "ac3" "eac3" "dts" "truehd" "opus" "flac". Apps pick direct play or a transcode from it.
 */
export interface VideoCaps {
  containers: string[];
  video: string[];
  audio: string[];
  /** Tallest picture it plays (2160 for 4K). */
  maxHeight?: number;
  /** It can jump to a position (and start part-way). */
  seek: boolean;
  /** Surround audio passed through to the TV/receiver. */
  passthrough?: string[];
  /**
   * Box 0.28.1: picture ranges the device shows correctly, end to end (decoder, display mode
   * and panel): "sdr" "hdr10" "hdr10plus" "hlg" "dovi". Absent: apps guess (SDR to be safe).
   */
  ranges?: string[];
}

// ---------------------------------------------------------------- client → box

export interface HelloMsg {
  type: "hello";
  v: number;
  token: string;
  platform: string;
  model?: string;
  appVersion?: string;
  screens: Screen[];
  deliveries: Delivery[];
  /** Box 0.28.0: present when the client plays video links itself. */
  video?: VideoCaps;
}
export interface ScreensMsg {
  type: "screens";
  screens: Screen[];
}
export interface StateMsg {
  type: "state";
  screen: string;
  showing: string;
  status: "playing" | "loading" | "error" | "off";
  detail?: string;
}
export interface PreviewMsg {
  type: "preview";
  requestId: string;
  screen: string;
  jpeg?: string;
  error?: string;
}
/** Box 0.28.0: the answer to a "video" message, same requestId. Never put the link in `message`. */
export interface VideoReplyMsg {
  type: "video-reply";
  requestId: string;
  ok: boolean;
  /** unsupported | not-allowed | error */
  reason?: "unsupported" | "not-allowed" | "error";
  message?: string;
  /** With op "status" (and allowed with any op): the player's state now. */
  state?: VideoState;
  position?: number;
  duration?: number;
}
export type VideoState = "loading" | "playing" | "paused" | "stopped" | "error";
/** Box 0.28.0: the player changed by itself (started, ended, failed, keyboard/remote). */
export interface VideoStateMsg {
  type: "video-state";
  screen: string;
  state: VideoState;
  position?: number;
  duration?: number;
  message?: string;
}
export type ClientMsg = HelloMsg | ScreensMsg | StateMsg | PreviewMsg | VideoReplyMsg | VideoStateMsg;

// ---------------------------------------------------------------- box → client

export interface WelcomeMsg {
  type: "welcome";
  v: number;
  deviceId: string;
  name: string;
  screens: { id: string; label: string }[];
}
export interface ShowMsg {
  type: "show";
  screen: string;
  url: string;
  kind: Delivery;
  title?: string;
}
/**
 * Box 0.28.0: play a video link full screen over the page (play), or control it. `url` and
 * `poster` carry the media server's key: never log them, store them or report them.
 */
export type VideoMsg =
  | { type: "video"; screen: string; requestId: string; op: "play"; url: string; title: string; mime?: string; poster?: string; startAt?: number }
  | { type: "video"; screen: string; requestId: string; op: "pause" | "resume" | "stop" | "status" }
  | { type: "video"; screen: string; requestId: string; op: "seek"; position: number };
export type BoxMsg =
  | WelcomeMsg
  | ShowMsg
  | VideoMsg
  | { type: "off"; screen: string }
  | { type: "reload"; screen: string }
  | { type: "identify"; screen: string; label: string }
  | { type: "preview"; screen: string; requestId: string }
  | { type: "error"; code: "bad-hello" | "bad-token" | "revoked" | "version"; message: string };

export interface PairStartReply {
  pairingId: string;
  code: string;
  expiresAt: string;
  pollMs: number;
}
export type PairStatusReply = { status: "pending" } | { status: "approved"; deviceId: string; token: string; wsPath: string } | { status: "expired" };

export const CLOSE = { badToken: 4401, revoked: 4403, protocol: 4400, replaced: 4409 } as const;

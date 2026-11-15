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
export type ClientMsg = HelloMsg | ScreensMsg | StateMsg | PreviewMsg;

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
export type BoxMsg =
  | WelcomeMsg
  | ShowMsg
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

// Talks to the box: pairing over HTTP, then one WebSocket control channel, reconnecting
// forever. No Electron imports here, so it runs (and is tested) in plain Node.

import WebSocket from "ws";
import { CLIENT_PROTOCOL, CLOSE, DEFAULT_PORT, type BoxMsg, type ClientMsg, type PairStartReply, type PairStatusReply, type Screen, type VideoCaps } from "./protocol";

export type ClientStatus =
  | { phase: "no-box" }
  | { phase: "unreachable"; box: string; error: string }
  | { phase: "pairing"; box: string; code: string; expiresAt: string }
  | { phase: "connecting"; box: string; attempt: number; error?: string }
  | { phase: "connected"; box: string; deviceId: string; name: string; labels: Record<string, string> }
  /** Another copy of this app connected with the same pairing (4409); retries later. */
  | { phase: "replaced"; box: string };

export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

export interface BoxClientDeps {
  boxUrl: () => string | undefined;
  token: TokenStore;
  device: () => { name: string; platform: string; model?: string; appVersion?: string };
  screens: () => Screen[];
  /** Box 0.28.0: what this client's video player plays (sent in hello); undefined = none. */
  video?: () => VideoCaps | undefined;
  /** Box 0.29.0: remote keys it takes as "key" messages (sent in hello). */
  keys?: () => string[];
  onStatus: (s: ClientStatus) => void;
  onMessage: (m: BoxMsg) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * The box stopped answering at `box`: where is it now? (Discovery by box id; the token
   * still works there.) Returns the new box URL, or undefined to keep trying `box`.
   */
  relocate?: (box: string) => Promise<string | undefined>;
  /** Overrides for tests. */
  timing?: Partial<Timing>;
}

interface Timing {
  backoffMinMs: number;
  backoffMaxMs: number;
  /** No ping or message from the box for this long → the socket is dead. Box pings every 30 s. */
  silenceMs: number;
  /** After a 4409 (replaced by another connection with our token). */
  replacedRetryMs: number;
  /** After a 4400 (protocol mismatch: the box needs a newer app). */
  protocolRetryMs: number;
  requestTimeoutMs: number;
  /** At most one relocate (a ~2 s LAN browse) this often. */
  relocateEveryMs: number;
}

const DEFAULT_TIMING: Timing = {
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  silenceMs: 75_000,
  replacedRetryMs: 5 * 60_000,
  protocolRetryMs: 10 * 60_000,
  requestTimeoutMs: 6000,
  relocateEveryMs: 30_000,
};

/** "192.168.1.20" → "http://192.168.1.20:7210"; keeps an explicit scheme/port; drops any path. */
export function normalizeBox(input: string | undefined): string | undefined {
  const raw = (input ?? "").trim();
  if (!raw) return undefined;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (!u.hostname) return undefined;
  if (!u.port && !/^[a-z]+:\/\/[^/]+:\d+/i.test(withScheme)) u.port = String(DEFAULT_PORT);
  return `${u.protocol}//${u.host}`;
}

export function wsUrl(box: string, path = "/client"): string {
  const u = new URL(path, box);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export async function checkBox(box: string, timeoutMs = 4000): Promise<{ ok: true; box: string; protocol: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(new URL("/health", box), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `the box answered ${res.status}` };
    const j = (await res.json()) as { ok?: boolean; box?: string; protocol?: number };
    if (!j.ok) return { ok: false, error: "not a Venuebox box" };
    if (j.protocol !== CLIENT_PROTOCOL) return { ok: false, error: `the box speaks protocol ${j.protocol}; this app speaks ${CLIENT_PROTOCOL}` };
    return { ok: true, box: String(j.box ?? ""), protocol: j.protocol };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "no answer (timed out)";
  if (e?.cause?.code) return e.cause.code;
  return e?.message ?? String(err);
}

export class BoxClient {
  private gen = 0;
  private ws?: WebSocket;
  private welcomed = false;
  private wakers = new Set<() => void>();
  private readonly t: Timing;
  private status: ClientStatus = { phase: "no-box" };
  private lastRelocate = 0;

  constructor(private readonly d: BoxClientDeps) {
    this.t = { ...DEFAULT_TIMING, ...d.timing };
  }

  get current(): ClientStatus {
    return this.status;
  }

  get connected(): boolean {
    return this.welcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** (Re)starts from scratch: use after the box address changed or the token was cleared. */
  restart(): void {
    this.stop();
    void this.run(this.gen);
  }

  stop(): void {
    this.gen++;
    this.welcomed = false;
    // Its close handler still runs (clearing timers); the old run loop sees the new gen and exits.
    const ws = this.ws;
    this.ws = undefined;
    ws?.terminate();
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  send(msg: ClientMsg): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  /** Displays changed: tell the box (when not connected, the next hello carries them). */
  sendScreens(): void {
    const screens = this.d.screens();
    if (screens.length) this.send({ type: "screens", screens });
  }

  private setStatus(s: ClientStatus) {
    this.status = s;
    this.d.onStatus(s);
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.d.log?.(msg, extra);
  }

  private alive(gen: number) {
    return gen === this.gen;
  }

  /** Sleeps; returns false if this run was cancelled meanwhile. */
  private sleep(ms: number, gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve(this.alive(gen));
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private backoff(attempt: number) {
    const base = Math.min(this.t.backoffMaxMs, this.t.backoffMinMs * 2 ** Math.min(attempt, 16));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  private async run(gen: number): Promise<void> {
    let box = normalizeBox(this.d.boxUrl());
    if (!box) return this.setStatus({ phase: "no-box" });
    this.lastRelocate = 0;
    let attempt = 0;
    while (this.alive(gen)) {
      let token = this.d.token.get();
      if (!token) {
        const paired = await this.pair(gen, box);
        if (!paired || !this.alive(gen)) return;
        ({ token, box } = paired);
        attempt = 0;
      }
      this.setStatus({ phase: "connecting", box, attempt, error: this.status.phase === "connecting" ? this.status.error : undefined });
      const r = await this.connectOnce(gen, box, token);
      if (!this.alive(gen)) return;
      this.log("control channel closed", { code: r.code, reason: r.reason, error: r.error, welcomed: r.welcomed });
      if (r.code === CLOSE.badToken || r.code === CLOSE.revoked) {
        this.log(r.code === CLOSE.revoked ? "removed from the box: pairing again" : "token not accepted: pairing again");
        this.d.token.clear();
        attempt = 0;
        continue;
      }
      if (r.code === CLOSE.replaced) {
        this.setStatus({ phase: "replaced", box });
        if (!(await this.sleep(this.t.replacedRetryMs, gen))) return;
        attempt = 0;
        continue;
      }
      if (r.welcomed) attempt = 0;
      else if (r.code === 1006 || r.code === 1005) {
        // Never reached the box (or it vanished mid-handshake): it may have a new address.
        const moved = await this.tryRelocate(gen, box);
        if (!this.alive(gen)) return;
        if (moved) {
          box = moved;
          attempt = 0;
          continue;
        }
      }
      const error = r.code === CLOSE.protocol ? `the box refused this app version (${r.reason || "protocol"})` : r.error ?? (r.welcomed ? "connection lost" : `closed (${r.code})`);
      this.setStatus({ phase: "connecting", box, attempt: attempt + 1, error });
      const wait = r.code === CLOSE.protocol ? this.t.protocolRetryMs : this.backoff(attempt);
      attempt++;
      if (!(await this.sleep(wait, gen))) return;
    }
  }

  // ---------------------------------------------------------------- pairing

  private async request<T>(box: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(new URL(path, box), { ...init, signal: AbortSignal.timeout(this.t.requestTimeoutMs) });
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch {
      body = {} as T;
    }
    return { status: res.status, body };
  }

  /** The box at `box` didn't answer: ask relocate (rate-limited) for a new address. */
  private async tryRelocate(gen: number, box: string): Promise<string | undefined> {
    if (!this.d.relocate || Date.now() - this.lastRelocate < this.t.relocateEveryMs) return undefined;
    this.lastRelocate = Date.now();
    let found: string | undefined;
    try {
      found = normalizeBox(await this.d.relocate(box));
    } catch (err) {
      this.log("relocate failed", { error: String(err) });
    }
    if (!this.alive(gen) || !found || found === box) return undefined;
    this.log("the box moved: reconnecting at its new address", { from: box, to: found });
    return found;
  }

  /** Shows codes until staff approve one; returns the token (or undefined if cancelled). */
  private async pair(gen: number, box: string): Promise<{ token: string; box: string } | undefined> {
    let attempt = 0;
    while (this.alive(gen)) {
      const screens = this.d.screens();
      if (!screens.length) {
        if (!(await this.sleep(5000, gen))) return;
        continue;
      }
      let start: { status: number; body: PairStartReply & { error?: string } };
      try {
        start = await this.request(box, "/pair/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...this.d.device(), screens }),
        });
      } catch (err) {
        if (!this.alive(gen)) return;
        const moved = await this.tryRelocate(gen, box);
        if (!this.alive(gen)) return;
        if (moved) {
          box = moved;
          continue;
        }
        this.setStatus({ phase: "unreachable", box, error: describe(err) });
        if (!(await this.sleep(this.backoff(attempt++), gen))) return;
        continue;
      }
      if (!this.alive(gen)) return;
      if (start.status !== 200 || !start.body.code) {
        this.setStatus({ phase: "unreachable", box, error: start.body.error ?? `the box answered ${start.status}` });
        if (!(await this.sleep(start.status === 429 ? 30_000 : this.backoff(attempt++), gen))) return;
        continue;
      }
      attempt = 0;
      const { pairingId, code, expiresAt } = start.body;
      const pollMs = Math.max(500, Number(start.body.pollMs) || 2000);
      const expires = Date.parse(expiresAt) || Date.now() + 10 * 60_000;
      this.log("pairing: showing code", { box });
      this.setStatus({ phase: "pairing", box, code, expiresAt });
      while (this.alive(gen) && Date.now() < expires + 5000) {
        if (!(await this.sleep(pollMs, gen))) return;
        let st: { status: number; body: PairStatusReply };
        try {
          st = await this.request(box, `/pair/status?id=${encodeURIComponent(pairingId)}`);
        } catch {
          continue; // keep showing the code; the box may be restarting
        }
        if (!this.alive(gen)) return;
        if (st.status === 404) break; // expired (or the box restarted): get a new code
        if (st.status === 200 && st.body.status === "approved" && st.body.token) {
          this.d.token.set(st.body.token);
          this.log("paired", { deviceId: st.body.deviceId });
          return { token: st.body.token, box };
        }
      }
    }
  }

  // ---------------------------------------------------------------- control channel

  private connectOnce(gen: number, box: string, token: string): Promise<{ code: number; reason: string; welcomed: boolean; error?: string }> {
    return new Promise((resolve) => {
      let welcomed = false;
      let error: string | undefined;
      let silence: NodeJS.Timeout | undefined;
      const ws = new WebSocket(wsUrl(box), { handshakeTimeout: this.t.requestTimeoutMs });
      this.ws = ws;
      this.welcomed = false;
      const heard = () => {
        if (silence) clearTimeout(silence);
        silence = setTimeout(() => {
          error = "the box went quiet";
          ws.terminate();
        }, this.t.silenceMs);
      };
      ws.on("open", () => {
        heard();
        const video = this.d.video?.();
        const keys = this.d.keys?.();
        ws.send(
          JSON.stringify({
            type: "hello",
            v: CLIENT_PROTOCOL,
            token,
            ...this.d.device(),
            screens: this.d.screens(),
            deliveries: ["native-url"],
            ...(video ? { video } : {}),
            ...(keys?.length ? { keys } : {}),
          } satisfies ClientMsg),
        );
      });
      ws.on("ping", heard);
      ws.on("message", (raw) => {
        heard();
        let msg: BoxMsg;
        try {
          msg = JSON.parse(String(raw)) as BoxMsg;
        } catch {
          return;
        }
        if (!this.alive(gen) || !msg || typeof msg.type !== "string") return;
        if (msg.type === "welcome") {
          welcomed = true;
          this.welcomed = true;
          const labels = Object.fromEntries((msg.screens ?? []).map((s) => [s.id, s.label]));
          this.setStatus({ phase: "connected", box, deviceId: msg.deviceId, name: msg.name, labels });
        } else if (msg.type === "error") {
          error = msg.message;
        }
        try {
          this.d.onMessage(msg);
        } catch (err) {
          this.log("handling a box message failed", { type: msg.type, error: String(err) });
        }
      });
      ws.on("error", (err) => {
        error ??= describe(err);
      });
      ws.on("close", (code, reason) => {
        if (silence) clearTimeout(silence);
        if (this.ws === ws) {
          this.ws = undefined;
          this.welcomed = false;
        }
        resolve({ code, reason: reason.toString(), welcomed, error });
      });
    });
  }
}

// A fake box that behaves like the broker's VenueboxHub
// (GameBroker/apps/broker/src/venuebox/hub.ts): pairing, hello/welcome, close codes.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { BoxClient, type ClientStatus } from "../src/box-client";
import type { BoxMsg, ClientMsg, HelloMsg } from "../src/protocol";

export const TOKEN = "t".repeat(43);

export class FakeBox {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  url = "";
  pairings = new Map<string, { code: string; approved: boolean; expireNow?: boolean }>();
  pairStarts = 0;
  hellos: HelloMsg[] = [];
  received: ClientMsg[] = [];
  sockets: WebSocket[] = [];
  validTokens = new Set<string>();

  constructor() {
    this.server = createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (u.pathname === "/health") return json(200, { ok: true, box: "fake", protocol: 1 });
      if (req.method === "POST" && u.pathname === "/pair/start") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const b = JSON.parse(body);
          if (!b.name || !b.platform || !Array.isArray(b.screens) || !b.screens.length) return json(400, { error: "bad" });
          const id = `p${++this.pairStarts}`;
          const code = String(100000 + this.pairStarts);
          this.pairings.set(id, { code, approved: false });
          json(200, { pairingId: id, code, expiresAt: new Date(Date.now() + 600_000).toISOString(), pollMs: 20 });
        });
        return;
      }
      if (u.pathname === "/pair/status") {
        const p = this.pairings.get(u.searchParams.get("id") ?? "");
        if (!p || p.expireNow) return json(404, { status: "expired" });
        if (!p.approved) return json(200, { status: "pending" });
        this.pairings.delete(u.searchParams.get("id")!);
        this.validTokens.add(TOKEN);
        return json(200, { status: "approved", deviceId: "dev1", token: TOKEN, wsPath: "/client" });
      }
      json(404, {});
    });
    this.server.on("upgrade", (req, socket, head) => this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws)));
  }

  async listen(port = 0) {
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  approve(code: string) {
    for (const p of this.pairings.values()) if (p.code === code) p.approved = true;
  }

  private accept(ws: WebSocket) {
    this.sockets.push(ws);
    let hello = false;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ClientMsg;
      if (!hello) {
        hello = true;
        if (m.type !== "hello") return ws.close(4400);
        this.hellos.push(m);
        if (!this.validTokens.has(m.token)) {
          ws.send(JSON.stringify({ type: "error", code: "bad-token", message: "pair again" }));
          return ws.close(4401, "bad-token");
        }
        ws.send(JSON.stringify({ type: "welcome", v: 1, deviceId: "dev1", name: "Bar PC", screens: m.screens.map((s) => ({ id: s.id, label: `Bar PC · ${s.name}` })) } satisfies BoxMsg));
        return;
      }
      this.received.push(m);
    });
  }

  latest() {
    return this.sockets[this.sockets.length - 1];
  }

  async close() {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise((r) => this.server.close(r));
  }
}

export function makeClient(box: string, initialToken?: string, relocate?: (box: string) => Promise<string | undefined>) {
  let token = initialToken;
  const statuses: ClientStatus[] = [];
  const messages: BoxMsg[] = [];
  const client = new BoxClient({
    boxUrl: () => box,
    token: { get: () => token, set: (t) => (token = t), clear: () => (token = undefined) },
    device: () => ({ name: "Test PC", platform: "windows", model: "test", appVersion: "0.0.1" }),
    screens: () => [
      { id: "1", name: "Left HDMI", w: 1920, h: 1080, hz: 60 },
      { id: "2", name: "Right HDMI", w: 3840, h: 2160 },
    ],
    onStatus: (s) => statuses.push(s),
    onMessage: (m) => messages.push(m),
    relocate,
    timing: { backoffMinMs: 20, backoffMaxMs: 100, requestTimeoutMs: 1000, relocateEveryMs: 0 },
  });
  return { client, statuses, messages, token: () => token };
}

export async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}


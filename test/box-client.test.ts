// BoxClient against a fake box that behaves like the broker's VenueboxHub
// (GameBroker/apps/broker/src/venuebox/hub.ts): pairing, hello/welcome, close codes, reconnects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { BoxClient, normalizeBox, wsUrl, type ClientStatus } from "../src/box-client";
import type { BoxMsg, ClientMsg, HelloMsg } from "../src/protocol";

const TOKEN = "t".repeat(43);

class FakeBox {
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

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
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

function makeClient(box: string, initialToken?: string) {
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
    timing: { backoffMinMs: 20, backoffMaxMs: 100, requestTimeoutMs: 1000 },
  });
  return { client, statuses, messages, token: () => token };
}

async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("normalizeBox", () => {
  assert.equal(normalizeBox("192.168.1.20"), "http://192.168.1.20:7210");
  assert.equal(normalizeBox(" 192.168.1.20:8000 "), "http://192.168.1.20:8000");
  assert.equal(normalizeBox("http://bg-box.local:7210/health"), "http://bg-box.local:7210");
  assert.equal(normalizeBox("http://bg-box:80"), "http://bg-box");
  assert.equal(normalizeBox("https://box.example"), "https://box.example:7210");
  assert.equal(normalizeBox(""), undefined);
  assert.equal(normalizeBox("ftp://x"), undefined);
  assert.equal(wsUrl("http://192.168.1.20:7210"), "ws://192.168.1.20:7210/client");
});

test("pairs, says hello, gets welcome and commands, reports state", async () => {
  const box = new FakeBox();
  await box.listen();
  const c = makeClient(box.url);
  try {
    c.client.restart();
    const pairing = await until(() => c.statuses.find((s) => s.phase === "pairing"));
    assert.equal(pairing.phase === "pairing" && pairing.code, "100001");
    box.approve("100001");
    await until(() => c.client.current.phase === "connected");
    assert.equal(c.token(), TOKEN);
    const hello = box.hellos[0];
    assert.equal(hello.v, 1);
    assert.equal(hello.token, TOKEN);
    assert.deepEqual(hello.deliveries, ["native-url"]);
    assert.equal(hello.screens.length, 2);
    const st = c.client.current;
    assert.ok(st.phase === "connected" && st.labels["2"] === "Bar PC · Right HDMI");

    box.latest().send(JSON.stringify({ type: "show", screen: "1", url: "http://box/tv/trivia", kind: "native-url", title: "Trivia" }));
    const show = await until(() => c.messages.find((m) => m.type === "show"));
    assert.ok(show.type === "show" && show.url === "http://box/tv/trivia");

    assert.ok(c.client.send({ type: "state", screen: "1", showing: "http://box/tv/trivia", status: "playing" }));
    c.client.sendScreens();
    await until(() => box.received.length >= 2);
    assert.equal(box.received[0].type, "state");
    assert.equal(box.received[1].type, "screens");
  } finally {
    c.client.stop();
    await box.close();
  }
});

test("a revoked/unknown token (4401) clears it and pairs again", async () => {
  const box = new FakeBox();
  await box.listen();
  const c = makeClient(box.url, "stale-token-stale-token-stale");
  try {
    c.client.restart();
    await until(() => c.client.current.phase === "pairing");
    assert.equal(c.token(), undefined);
    assert.equal(box.hellos[0].token, "stale-token-stale-token-stale");
  } finally {
    c.client.stop();
    await box.close();
  }
});

test("reconnects with the same token after the connection drops", async () => {
  const box = new FakeBox();
  await box.listen();
  box.validTokens.add(TOKEN);
  const c = makeClient(box.url, TOKEN);
  try {
    c.client.restart();
    await until(() => c.client.current.phase === "connected");
    box.latest().terminate();
    await until(() => c.statuses.some((s) => s.phase === "connecting" && s.attempt > 0));
    await until(() => box.hellos.length === 2 && c.client.current.phase === "connected");
    assert.equal(box.hellos[1].token, TOKEN);
    assert.equal(box.pairStarts, 0);
  } finally {
    c.client.stop();
    await box.close();
  }
});

test("an expired code (404) gets a new code", async () => {
  const box = new FakeBox();
  await box.listen();
  const c = makeClient(box.url);
  try {
    c.client.restart();
    await until(() => c.client.current.phase === "pairing");
    box.pairings.get("p1")!.expireNow = true;
    await until(() => c.client.current.phase === "pairing" && c.client.current.code === "100002");
    box.approve("100002");
    await until(() => c.client.current.phase === "connected");
  } finally {
    c.client.stop();
    await box.close();
  }
});

test("an unreachable box shows unreachable and keeps trying", async () => {
  const c = makeClient("http://127.0.0.1:1");
  try {
    c.client.restart();
    await until(() => c.statuses.filter((s) => s.phase === "unreachable").length >= 2);
  } finally {
    c.client.stop();
  }
});

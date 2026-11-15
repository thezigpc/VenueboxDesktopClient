// BoxClient against a fake box that behaves like the broker's VenueboxHub
// (GameBroker/apps/broker/src/venuebox/hub.ts): pairing, hello/welcome, close codes, reconnects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBox, wsUrl } from "../src/box-client";
import { FakeBox, TOKEN, makeClient, until } from "./fake-box";

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

// Discovery: parsing the box's mDNS answer, browsing (legacy unicast), re-finding a moved box
// by id, and the typed-address fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { boxesFrom, browse, encodeQuery, parseMessage, relocate, SERVICE, type FoundBox } from "../src/discovery";
import { FakeBox, TOKEN, makeClient, until } from "./fake-box";

// ---------------------------------------------------------------- the box's encoder, mirrored
// From GameBroker/apps/broker/src/venuebox/advertise.ts (encodeAnswer): uncompressed names,
// PTR + SRV + TXT + one A per address, optional echoed question (legacy unicast).

function encName(name: string): Buffer {
  return Buffer.concat([...name.split(".").filter(Boolean).map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
}
function rr(name: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(0x8001, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encName(name), head, data]);
}
function boxAnswer(o: { name: string; id: string; port: number; addresses: string[] }, question?: Buffer): Buffer {
  const inst = `${o.name}.${SERVICE}`;
  const host = `bargames-${o.id}.local`;
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(o.port, 4);
  const txt = Buffer.concat(
    Object.entries({ v: "1", id: o.id, name: o.name, path: "/venuebox" }).map(([k, v]) => {
      const s = Buffer.from(`${k}=${v}`);
      return Buffer.concat([Buffer.from([s.length]), s]);
    }),
  );
  const records = [rr(SERVICE, 12, encName(inst)), rr(inst, 33, Buffer.concat([srv, encName(host)])), rr(inst, 16, txt), ...o.addresses.map((ip) => rr(host, 1, Buffer.from(ip.split(".").map(Number))))];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(question ? 1 : 0, 4);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...(question ? [question] : []), ...records]);
}

const KAVA = { name: "Kava Bar", id: "a1b2c3d4e5f6", port: 7210, addresses: ["192.168.1.20", "10.0.0.5"] };

test("parses the box's answer: PTR → SRV/TXT → A", () => {
  const [box] = boxesFrom([boxAnswer(KAVA)]);
  assert.deepEqual(box, { id: KAVA.id, name: "Kava Bar", port: 7210, host: "bargames-a1b2c3d4e5f6.local", addresses: ["192.168.1.20", "10.0.0.5"] });
});

test("parses a legacy-unicast answer that echoes the question", () => {
  const q = encodeQuery(0x1234).subarray(12); // the question section
  const boxes = boxesFrom([boxAnswer(KAVA, q)]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].id, KAVA.id);
});

test("parses compressed names (other responders compress)", () => {
  // Header: response, 0 questions, 4 answers. Names after the first point back into it.
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
  const svc = encName(SERVICE); // at offset 12
  const ptr = (off: number) => Buffer.from([0xc0 | (off >> 8), off & 0xff]);
  const meta = (type: number, len: number) => {
    const b = Buffer.alloc(10);
    b.writeUInt16BE(type, 0);
    b.writeUInt16BE(1, 2);
    b.writeUInt32BE(120, 4);
    b.writeUInt16BE(len, 8);
    return b;
  };
  // PTR rdata: "Pool Hall" + pointer to the service name.
  const instRdata = Buffer.concat([Buffer.from([9]), Buffer.from("Pool Hall"), ptr(12)]);
  const p1 = Buffer.concat([header, svc, meta(12, instRdata.length)]);
  const instOff = p1.length; // the instance name lives in the PTR rdata
  const p2 = Buffer.concat([p1, instRdata]);
  const srvRdata = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1c, 0x2a]), Buffer.from([4]), Buffer.from("pool"), Buffer.from([5]), Buffer.from("local"), Buffer.from([0])]);
  const p3 = Buffer.concat([p2, ptr(instOff), meta(33, srvRdata.length)]);
  const hostOff = p3.length + 6;
  const p4 = Buffer.concat([p3, srvRdata]);
  const t = Buffer.from("id=0f0f0f0f0f0f");
  const p5 = Buffer.concat([p4, ptr(instOff), meta(16, t.length + 1), Buffer.from([t.length]), t]);
  const msg = Buffer.concat([p5, ptr(hostOff), meta(1, 4), Buffer.from([192, 168, 7, 9])]);
  assert.equal(parseMessage(msg).length, 4);
  assert.deepEqual(boxesFrom([msg]), [{ id: "0f0f0f0f0f0f", name: "pool hall", port: 7210, host: "pool.local", addresses: ["192.168.7.9"] }]);
});

test("ignores queries, other services and truncated packets", () => {
  assert.deepEqual(boxesFrom([encodeQuery()]), []);
  assert.deepEqual(boxesFrom([boxAnswer(KAVA).subarray(0, 40)]), []);
  const other = boxAnswer(KAVA).toString("latin1").replace(/_venuebox/g, "_airplay__").replace("\x09", "\x09");
  assert.deepEqual(boxesFrom([Buffer.from(other, "latin1")]), []);
});

/** A UDP responder like the box: answers PTR queries for the service by unicast to the sender. */
async function fakeResponder(answer: () => Buffer) {
  const s = createSocket("udp4");
  const queries: Buffer[] = [];
  s.on("message", (m, from) => {
    queries.push(m);
    const names = parseQuestionNames(m);
    if (names.includes(SERVICE)) s.send(answer(), from.port, from.address);
  });
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
  return { target: { address: "127.0.0.1", port: (s.address() as AddressInfo).port }, queries, close: () => s.close() };
}
function parseQuestionNames(m: Buffer): string[] {
  const labels: string[] = [];
  for (let off = 12; off < m.length && m[off] !== 0; off += 1 + m[off]!) labels.push(m.toString("utf8", off + 1, off + 1 + m[off]!));
  return [labels.join(".")];
}

test("browse sends a PTR query and collects the unicast answer", async () => {
  const r = await fakeResponder(() => boxAnswer(KAVA));
  try {
    const found = await browse({ target: r.target, timeoutMs: 300 });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "Kava Bar");
    assert.ok(r.queries.length >= 1);
  } finally {
    r.close();
  }
});

test("relocate re-finds the same box id at a new address (and only that id)", async () => {
  const health = createServer((_req, res) => res.end(JSON.stringify({ ok: true, box: "Kava Bar", protocol: 1 })));
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
  const port = (health.address() as AddressInfo).port;
  // The box now reports an address that doesn't answer plus one that does.
  const r = await fakeResponder(() => boxAnswer({ ...KAVA, port, addresses: ["127.0.0.2", "127.0.0.1"] }));
  try {
    const moved = await relocate(KAVA.id, { target: r.target, timeoutMs: 300 });
    assert.equal(moved?.url, `http://127.0.0.1:${port}`);
    assert.equal(await relocate("ffffffffffff", { target: r.target, timeoutMs: 300 }), undefined);
  } finally {
    r.close();
    await new Promise((res) => health.close(res));
  }
});

test("the client follows its box to a new address without pairing again", async () => {
  const oldBox = new FakeBox();
  await oldBox.listen();
  oldBox.validTokens.add(TOKEN);
  const newBox = new FakeBox();
  await newBox.listen();
  newBox.validTokens.add(TOKEN); // same box (same device registry), new address
  let asked = 0;
  const c = makeClient(oldBox.url, TOKEN, async () => {
    asked++;
    return newBox.url;
  });
  try {
    c.client.restart();
    await until(() => c.client.current.phase === "connected");
    await oldBox.close(); // DHCP gave the box a new address
    await until(() => c.client.current.phase === "connected" && c.client.current.box === newBox.url);
    assert.ok(asked >= 1);
    assert.equal(newBox.hellos[0].token, TOKEN);
    assert.equal(newBox.pairStarts, 0);
    assert.equal(c.token(), TOKEN);
  } finally {
    c.client.stop();
    await newBox.close();
  }
});

test("fallback: nothing found → keeps trying the saved (typed) address", async () => {
  const box = new FakeBox();
  await box.listen();
  box.validTokens.add(TOKEN);
  const port = Number(new URL(box.url).port);
  const c = makeClient(box.url, TOKEN, async () => undefined);
  try {
    c.client.restart();
    await until(() => c.client.current.phase === "connected");
    await box.close();
    await until(() => c.statuses.filter((s) => s.phase === "connecting" && s.error).length >= 2);
    assert.ok(c.statuses.every((s) => !("box" in s) || s.box === box.url));
    const back = new FakeBox(); // the box comes back at the same address
    back.validTokens.add(TOKEN);
    await back.listen(port);
    try {
      await until(() => c.client.current.phase === "connected", 5000);
    } finally {
      c.client.stop();
      await back.close();
    }
  } finally {
    c.client.stop();
  }
});

// Unused-type guard so the import stays checked.
export type _F = FoundBox;

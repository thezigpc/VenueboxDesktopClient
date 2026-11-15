// Finds boxes on the venue LAN: DNS-SD browse for "_venuebox._tcp.local" (box 0.16.2+,
// GameBroker docs/NATIVE-CLIENTS.md "Discovery"). No dependencies, no Electron.
//
// We send the PTR query from an ephemeral port (one socket per LAN interface), so the box
// answers us directly by unicast ("legacy unicast", RFC 6762 §6.7). That avoids sharing
// :5353 with Windows' and macOS's own mDNS responders. Client isolation on Wi-Fi blocks
// this: typing the address stays the fallback.

import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { checkBox } from "./box-client";

export const SERVICE = "_venuebox._tcp.local";
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

export interface FoundBox {
  /** Stable box id from TXT (remember the box by this, not by its IP). */
  id: string;
  /** Venue name. */
  name: string;
  port: number;
  /** Every LAN IPv4 address the box reported. */
  addresses: string[];
  host?: string;
}

interface Record_ {
  name: string;
  type: number;
  data: Buffer;
  /** Offset of data in the whole message (for compressed names inside RDATA). */
  offset: number;
}

// ---------------------------------------------------------------- DNS wire format

/** Reads a (possibly compressed) name at `off`; returns it and the offset after it. */
function readName(buf: Buffer, off: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  let jumps = 0;
  while (off < buf.length) {
    const len = buf[off]!;
    if (len === 0) {
      off += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length || ++jumps > 20) throw new Error("bad name pointer");
      if (next < 0) next = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1]!;
      continue;
    }
    if (off + 1 + len > buf.length) throw new Error("name runs past the end");
    labels.push(buf.toString("utf8", off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join("."), next: next >= 0 ? next : off };
}

/** All answer/authority/additional records of a DNS message (questions skipped). */
export function parseMessage(buf: Buffer): Record_[] {
  if (buf.length < 12) return [];
  if (!(buf.readUInt16BE(2) & 0x8000)) return []; // a query, not a response
  const qd = buf.readUInt16BE(4);
  const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  const out: Record_[] = [];
  try {
    for (let i = 0; i < qd; i++) off = readName(buf, off).next + 4;
    for (let i = 0; i < rrCount && off < buf.length; i++) {
      const { name, next } = readName(buf, off);
      off = next;
      if (off + 10 > buf.length) break;
      const type = buf.readUInt16BE(off);
      const len = buf.readUInt16BE(off + 8);
      const start = off + 10;
      if (start + len > buf.length) break;
      out.push({ name: name.toLowerCase(), type, data: buf.subarray(start, start + len), offset: start });
      off = start + len;
    }
  } catch {
    // malformed: keep what parsed
  }
  return out;
}

function txt(data: Buffer): Record<string, string> {
  const kv: Record<string, string> = {};
  for (let off = 0; off < data.length; ) {
    const len = data[off]!;
    const s = data.toString("utf8", off + 1, off + 1 + len);
    off += 1 + len;
    const eq = s.indexOf("=");
    if (eq > 0) kv[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
  }
  return kv;
}

/** Boxes described by one or more DNS messages (PTR → SRV/TXT → A). */
export function boxesFrom(messages: Buffer[]): FoundBox[] {
  const records = messages.flatMap((m) => parseMessage(m).map((r) => ({ ...r, msg: m })));
  const instances = new Set<string>();
  for (const r of records) if (r.type === TYPE.PTR && r.name === SERVICE) instances.add(readName(r.msg, r.offset).name.toLowerCase());
  // Announcements may arrive without the PTR in the same packet: SRV/TXT under our service count too.
  for (const r of records) if ((r.type === TYPE.SRV || r.type === TYPE.TXT) && r.name.endsWith(`.${SERVICE}`)) instances.add(r.name);
  const byId = new Map<string, FoundBox>();
  for (const inst of instances) {
    const srv = records.find((r) => r.type === TYPE.SRV && r.name === inst && r.data.length >= 7);
    const t = records.find((r) => r.type === TYPE.TXT && r.name === inst);
    if (!srv || !t) continue;
    const kv = txt(t.data);
    if (!kv.id || (kv.v && kv.v !== "1")) continue;
    const port = srv.data.readUInt16BE(4);
    const host = readName(srv.msg, srv.offset + 6).name.toLowerCase();
    const addresses = [
      ...new Set(records.filter((r) => r.type === TYPE.A && r.name === host && r.data.length === 4).map((r) => [...r.data].join("."))),
    ];
    if (!addresses.length) continue;
    const label = inst.slice(0, -SERVICE.length - 1);
    const prev = byId.get(kv.id);
    byId.set(kv.id, {
      id: kv.id,
      name: kv.name || prev?.name || label,
      port,
      host,
      addresses: [...new Set([...(prev?.addresses ?? []), ...addresses])],
    });
  }
  return [...byId.values()];
}

/** A PTR query for the service (QU bit clear; we're a legacy-unicast querier). */
export function encodeQuery(id = Math.floor(Math.random() * 0xffff)): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4); // one question
  const labels = SERVICE.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.PTR, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

// ---------------------------------------------------------------- browsing

/** This computer's LAN IPv4 addresses (not loopback, link-local, VPNs or virtual switches). */
export function localAddresses(ifaces = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/tailscale|zerotier|docker|vboxnet|vmnet|wsl|loopback/i.test(name)) continue;
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.") && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push(a.address);
  }
  return out;
}

export interface BrowseOptions {
  timeoutMs?: number;
  /** Tests: where to send the query instead of the mDNS group. */
  target?: { address: string; port: number };
  /** Local addresses to query from (default: every LAN interface). */
  interfaces?: string[];
}

/** Asks the LAN for boxes; resolves with what answered within the timeout (merged by id). */
export async function browse(o: BrowseOptions = {}): Promise<FoundBox[]> {
  const target = o.target ?? { address: MDNS_ADDR, port: MDNS_PORT };
  const ifaces = o.interfaces ?? (o.target ? ["0.0.0.0"] : localAddresses());
  const messages: Buffer[] = [];
  const sockets: Socket[] = [];
  const timers: NodeJS.Timeout[] = [];
  const query = encodeQuery();
  await Promise.all(
    ifaces.map(
      (ip) =>
        new Promise<void>((resolve) => {
          const s = createSocket({ type: "udp4" });
          s.on("error", () => resolve());
          s.on("message", (m) => messages.push(m));
          s.bind(0, ip === "0.0.0.0" ? undefined : ip, () => {
            sockets.push(s);
            try {
              if (!o.target) {
                s.setMulticastInterface(ip);
                s.setMulticastTTL(255);
              }
            } catch {
              /* send anyway */
            }
            const send = () => {
              try {
                s.send(query, target.port, target.address, () => undefined);
              } catch {
                /* closed meanwhile */
              }
            };
            send();
            timers.push(setTimeout(send, 600)); // mDNS is lossy (Wi-Fi): ask twice
            resolve();
          });
        }),
    ),
  );
  await new Promise((r) => setTimeout(r, o.timeoutMs ?? 2000));
  for (const t of timers) clearTimeout(t);
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  return boxesFrom(messages);
}

/** The first of the box's addresses that answers /health, as a box URL. */
export async function reachable(box: FoundBox, timeoutMs = 3000): Promise<string | undefined> {
  const urls = box.addresses.map((ip) => `http://${ip}:${box.port}`);
  const results = await Promise.all(urls.map(async (u) => ((await checkBox(u, timeoutMs)).ok ? u : undefined)));
  return results.find(Boolean);
}

/** Re-finds a box we paired with (its address changed): browse, match the id, check it answers. */
export async function relocate(id: string, o: BrowseOptions = {}): Promise<{ url: string; box: FoundBox } | undefined> {
  const box = (await browse(o)).find((b) => b.id === id);
  if (!box) return undefined;
  const url = await reachable(box);
  return url ? { url, box } : undefined;
}

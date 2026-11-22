// A stand-in for mpv in tests: takes mpv's arguments, opens --input-ipc-server and answers
// the JSON IPC that src/video.ts uses. Run with node (VideoPlayers mpvPrefixArgs).
// It appends its argv and each command to FAKE_MPV_LOG, so tests can check where the link went.
//
// Links: "...fail..." → end-file error (loading failed); "...short..." → ends (eof) after
// ~300 ms; otherwise plays a 120 s video, ticking time-pos every 50 ms.

import { createServer, type Socket } from "node:net";
import { appendFileSync } from "node:fs";

const log = (line: string) => process.env.FAKE_MPV_LOG && appendFileSync(process.env.FAKE_MPV_LOG, `${line}\n`);
log(`ARGV ${JSON.stringify(process.argv.slice(2))}`);

const pipe = process.argv.find((a) => a.startsWith("--input-ipc-server="))?.slice("--input-ipc-server=".length);
if (!pipe) process.exit(2);
const startArg = Number(process.argv.find((a) => a.startsWith("--start="))?.slice(8) ?? 0);

const observed = new Map<string, number>();
const props: Record<string, unknown> = { pause: false, "time-pos": null, duration: null, "paused-for-cache": false, "eof-reached": false, "idle-active": true, aid: "auto", sid: "auto", volume: 100, mute: false };
const binds = new Map<string, string>();
const clients = new Set<Socket>();
let ticker: NodeJS.Timeout | undefined;

// Events go to every client (like mpv); replies to the one that asked.
const send = (o: unknown) => {
  for (const c of clients) c.write(`${JSON.stringify(o)}\n`);
};
function set(name: string, value: unknown) {
  props[name] = value;
  const id = observed.get(name);
  if (id !== undefined) send({ event: "property-change", id, name, data: value });
}
function end(reason: string, fileError?: string) {
  if (ticker) clearInterval(ticker);
  send({ event: "end-file", reason, ...(fileError ? { file_error: fileError } : {}) });
  set("idle-active", true);
}

function play(url: string) {
  set("idle-active", false);
  setTimeout(() => {
    if (url.includes("fail")) return end("error", "loading failed");
    set("duration", 120);
    set("time-pos", startArg);
    send({ event: "file-loaded" });
    send({ event: "playback-restart" });
    ticker = setInterval(() => {
      if (props.pause) return;
      set("time-pos", Math.round(((props["time-pos"] as number) + 0.05) * 100) / 100);
    }, 50);
    if (url.includes("short")) setTimeout(() => end("eof"), 300);
  }, 60);
}

const server = createServer((sock) => {
  clients.add(sock);
  sock.on("close", () => clients.delete(sock));
  sock.on("error", () => clients.delete(sock));
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const { command, request_id } = JSON.parse(line) as { command: unknown[] | Record<string, unknown>; request_id: number };
      log(`CMD ${JSON.stringify(command)}`);
      const reply = (o: Record<string, unknown>) => sock.write(`${JSON.stringify({ request_id, ...o })}\n`);
      const ok = (data?: unknown) => reply({ error: "success", ...(data !== undefined ? { data } : {}) });
      if (!Array.isArray(command)) {
        // Named arguments ({ name: "osd-overlay", ... }).
        if (command.name === "osd-overlay") ok();
        else reply({ error: "invalid parameter" });
        continue;
      }
      const [name, ...args] = command as [string, ...unknown[]];
      if (name === "keybind") {
        binds.set(String(args[0]), String(args[1]));
        ok();
      } else if (name === "keypress") {
        // Like a key pressed in the player window: bound script-messages reach every client.
        const m = /^script-message (\S+) (\S+)$/.exec(binds.get(String(args[0])) ?? "");
        if (m) send({ event: "client-message", args: [m[1], m[2]] });
        ok();
      } else if (name === "sub-add") {
        if (String(args[0]).includes("missing")) reply({ error: "loading failed" });
        else ok();
      } else if (name === "show-text" || name === "ignore") ok();
      else if (name === "cycle") {
        set(String(args[0]), !props[String(args[0])]);
        ok();
      } else if (name === "add") {
        set(String(args[0]), Number(props[String(args[0])]) + Number(args[1]));
        ok();
      } else if (name === "observe_property") {
        observed.set(args[1] as string, args[0] as number);
        ok();
        send({ event: "property-change", id: args[0], name: args[1], data: props[args[1] as string] });
      } else if (name === "set_property") {
        set(args[0] as string, args[1]);
        ok();
      } else if (name === "get_property") ok(props[args[0] as string]);
      else if (name === "loadfile") {
        ok();
        play(args[0] as string);
      } else if (name === "seek") {
        const now = Number(props["time-pos"] ?? 0);
        set("time-pos", args[1] === "relative" ? Math.max(0, now + Number(args[0])) : args[0]);
        send({ event: "seek" });
        send({ event: "playback-restart" });
        ok();
      } else if (name === "quit") {
        ok();
        setTimeout(() => process.exit(0), 20);
      } else reply({ error: "invalid parameter" });
    }
  });
});
server.listen(pipe);
setTimeout(() => process.exit(3), 60_000).unref(); // never outlive a test run

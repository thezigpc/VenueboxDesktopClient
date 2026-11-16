// Which `show` URLs a screen loads: TV pages (http/https) and the box's data:text/html idle page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkShowUrl } from "../src/urls";

// The box's own idle pages (GameBroker apps/broker/src/registry.ts and drivers/local/index.ts).
const PAIRING_IDLE = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Pairing</title><body style="background:#101528">Bar TV is connected</body>')}`;
const BLACK_PAGE = "data:text/html,<html style='background:%23000;cursor:none'></html>";

test("allows TV pages over http and https", () => {
  assert.deepEqual(checkShowUrl("http://192.168.1.20/leaderboard/tv"), { ok: true });
  assert.deepEqual(checkShowUrl("https://play.example.com/bingo/tv?room=1"), { ok: true });
});

test("allows the box's data:text/html idle pages", () => {
  assert.deepEqual(checkShowUrl(PAIRING_IDLE), { ok: true });
  assert.deepEqual(checkShowUrl(BLACK_PAGE), { ok: true });
  assert.deepEqual(checkShowUrl("data:text/html;base64,PGgxPkhpPC9oMT4="), { ok: true });
  assert.deepEqual(checkShowUrl("DATA:Text/HTML;Charset=UTF-8,%3Cp%3Eidle%3C%2Fp%3E"), { ok: true });
});

test("still blocks other schemes and other data: types", () => {
  for (const url of [
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "about:blank",
    "ftp://box/x",
    "chrome://settings",
    "data:image/svg+xml,<svg onload='alert(1)'/>",
    "data:text/javascript,alert(1)",
    "data:,<script>alert(1)</script>", // no type = text/plain
    "data:text/htmlx,<p>",
    "data:text/html", // no comma: not a data URL body
  ]) {
    const r = checkShowUrl(url);
    assert.equal(r.ok, false, url);
  }
});

test("rejects junk", () => {
  assert.equal(checkShowUrl("").ok, false);
  assert.equal(checkShowUrl("not a url").ok, false);
  assert.equal(checkShowUrl(undefined).ok, false);
});

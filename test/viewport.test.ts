// Pages lay out at 1920x1080 CSS px and render at the panel's own pixels (src/viewport.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fitZoom, viewportFor } from "../src/viewport";

const cases: [string, number, number, number, { zoom: number; css: [number, number]; dpr: number; px: [number, number] }][] = [
  // label, window DIP w, h, OS scale → expected
  ["4K TV, Windows 150%", 2560, 1440, 1.5, { zoom: 1.3333, css: [1920, 1080], dpr: 2, px: [3840, 2160] }],
  ["4K TV, Windows 100%", 3840, 2160, 1, { zoom: 2, css: [1920, 1080], dpr: 2, px: [3840, 2160] }],
  ["4K TV, Windows 200%", 1920, 1080, 2, { zoom: 1, css: [1920, 1080], dpr: 2, px: [3840, 2160] }],
  ["1080p TV, 100%", 1920, 1080, 1, { zoom: 1, css: [1920, 1080], dpr: 1, px: [1920, 1080] }],
  ["1080p laptop, 125%", 1536, 864, 1.25, { zoom: 0.8, css: [1920, 1080], dpr: 1, px: [1920, 1080] }],
  ["720p TV", 1280, 720, 1, { zoom: 0.6667, css: [1920, 1080], dpr: 0.667, px: [1280, 720] }],
  ["ultrawide 2560x1080", 2560, 1080, 1, { zoom: 1, css: [2560, 1080], dpr: 1, px: [2560, 1080] }],
  ["16:10 1920x1200", 1920, 1200, 1, { zoom: 1, css: [1920, 1200], dpr: 1, px: [1920, 1200] }],
  ["3:2 laptop 2256x1504 at 150%", 1504, 1003, 1.5, { zoom: 0.7833, css: [1920, 1280], dpr: 1.175, px: [2256, 1505] }],
];

for (const [label, w, h, scale, want] of cases) {
  test(`viewport: ${label}`, () => {
    const v = viewportFor(w, h, scale);
    assert.equal(v.zoom, want.zoom);
    assert.deepEqual([v.css.w, v.css.h], want.css);
    assert.equal(v.dpr, want.dpr);
    assert.deepEqual([v.px.w, v.px.h], want.px);
    // Never narrower than 1920 or shorter than 1080 CSS px (±1 for rounding).
    assert.ok(v.css.w >= 1919 && v.css.h >= 1079);
  });
}

test("fitZoom guards odd sizes", () => {
  assert.equal(fitZoom(0, 1080), 1);
  assert.equal(fitZoom(NaN, 1080), 1);
  assert.equal(fitZoom(100, 50), 0.25); // tiny window: Chromium's minimum
  assert.equal(fitZoom(15360, 8640), 5); // 16K at 100%: Chromium's maximum
});

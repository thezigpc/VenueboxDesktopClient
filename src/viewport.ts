// TV pages are laid out for a 1920x1080 CSS viewport (GameBroker docs/NATIVE-CLIENTS.md).
// Each screen gets the zoom that makes its window show exactly that layout; Chromium then
// renders at the panel's own pixels: devicePixelRatio = OS scale x zoom = panel px / 1920.
// A 4K TV draws text and canvases with all 3840 px, not a 1080p image scaled up.
//
//   panel (px)   Windows scale   window (DIP)   zoom    CSS viewport   devicePixelRatio
//   3840x2160    150%            2560x1440      1.333   1920x1080      2.0  (native 4K)
//   3840x2160    100%            3840x2160      2.0     1920x1080      2.0
//   1920x1080    100%            1920x1080      1.0     1920x1080      1.0
//   1920x1080    125%            1536x864       0.8     1920x1080      1.0
//   2560x1080    100%            2560x1080      1.0     2560x1080      1.0  (ultrawide: wider)
//   1920x1200    100%            1920x1200      1.0     1920x1200      1.0  (16:10: taller)
//
// The smaller of the two ratios: the viewport is never narrower than 1920 or shorter than
// 1080 CSS px; other shapes get extra room. No electron imports (unit-tested).

export const DESIGN = { w: 1920, h: 1080 } as const;
const MIN_ZOOM = 0.25; // Chromium's range
const MAX_ZOOM = 5;

/** Zoom factor for a window whose content area is w x h DIP. */
export function fitZoom(w: number, h: number): number {
  if (!(w > 0 && h > 0)) return 1;
  const z = Math.min(w / DESIGN.w, h / DESIGN.h);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10000) / 10000));
}

export interface ViewportInfo {
  zoom: number;
  /** CSS px the page lays out in. */
  css: { w: number; h: number };
  /** window.devicePixelRatio the page sees. */
  dpr: number;
  /** Physical px the page is rendered at. */
  px: { w: number; h: number };
}

/** What a page sees on a window of w x h DIP on a display with this OS scale factor. */
export function viewportFor(w: number, h: number, scaleFactor: number): ViewportInfo {
  const zoom = fitZoom(w, h);
  return {
    zoom,
    css: { w: Math.round(w / zoom), h: Math.round(h / zoom) },
    dpr: Math.round(scaleFactor * zoom * 1000) / 1000,
    px: { w: Math.round(w * scaleFactor), h: Math.round(h * scaleFactor) },
  };
}

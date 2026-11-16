// Which URLs a screen may load from a `show`. No Electron imports (unit-tested).
//
// TV pages are http(s). The box's idle screen is a `show` with a self-contained
// `data:text/html` page (GameBroker docs/NATIVE-CLIENTS.md, "Control channel"), e.g.
// "data:text/html;charset=utf-8,%3C!doctype..." or the black page
// "data:text/html,<html style='background:%23000'></html>". Everything else stays blocked:
// file:, javascript:, about:, other data: types (data:image/svg+xml can run script), etc.

export type UrlCheck = { ok: true } | { ok: false; reason: string };

export function checkShowUrl(url: unknown): UrlCheck {
  if (typeof url !== "string" || !url) return { ok: false, reason: "no URL from the box" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "bad URL from the box" };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "data:") {
    // data:[<mediatype>][;charset=...][;base64],<data>
    const comma = url.indexOf(",");
    if (comma < 0) return { ok: false, reason: "bad data: URL from the box" };
    const mediaType = url.slice(5, comma).split(";")[0].trim().toLowerCase();
    if (mediaType === "text/html") return { ok: true };
    return { ok: false, reason: `the box sent a data: URL that isn't a web page (${mediaType || "no type"})` };
  }
  return { ok: false, reason: `the box sent a non-web URL (${parsed.protocol})` };
}

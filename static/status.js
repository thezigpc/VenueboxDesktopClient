// Renders ?title=&detail=&code= (empty → plain black).
const q = new URLSearchParams(location.search);
const title = q.get("title") || "";
const detail = q.get("detail") || "";
const code = (q.get("code") || "").replace(/\D/g, "");
if (title || detail || code) {
  document.getElementById("m").hidden = false;
  document.getElementById("foot").hidden = false;
  document.getElementById("title").textContent = title;
  document.getElementById("detail").textContent = detail;
  if (code) {
    const el = document.getElementById("code");
    el.hidden = false;
    el.textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  }
}

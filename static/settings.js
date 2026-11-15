const api = window.venuebox;
const $ = (id) => document.getElementById(id);
let typed = false;

function msg(el, text, kind) {
  el.textContent = text || "";
  el.className = `msg${kind ? ` ${kind}` : ""}`;
}

function render(s) {
  $("ver").textContent = `v${s.version}`;
  const st = s.status;
  const dot = $("dot");
  const map = {
    "no-box": ["", "No box set", "Type the box address below."],
    unreachable: ["bad", "Can't reach the box", `${st.box || ""}: ${st.error || ""}`],
    pairing: ["wait", "Waiting for pairing", st.box],
    connecting: ["wait", "Connecting…", st.error ? `${st.box}: ${st.error}` : st.box],
    connected: ["ok", `Connected as “${st.name}”`, st.box],
    replaced: ["bad", "Paired elsewhere", "Another copy of this app is using this pairing. Retrying in a few minutes."],
  };
  const [cls, text, detail] = map[st.phase] || ["", st.phase, ""];
  dot.className = `dot ${cls}`;
  $("statusText").textContent = text;
  msg($("statusDetail"), detail);
  $("pairBox").hidden = st.phase !== "pairing";
  if (st.phase === "pairing") $("code").textContent = `${st.code.slice(0, 3)} ${st.code.slice(3)}`;

  if (!typed) {
    $("box").value = s.config.box || "";
    $("name").value = s.config.name || "";
  }
  $("name").placeholder = s.defaultName;
  $("login").checked = s.startAtLogin;
  $("unpair").disabled = !s.paired;

  const list = $("screens");
  list.textContent = "";
  for (const sc of s.screens) {
    const row = document.createElement("div");
    row.className = "screen";
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = sc.label || sc.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    const what = sc.showing ? `${sc.state}: ${sc.title || sc.showing}` : "nothing showing";
    meta.textContent = `${sc.w}×${sc.h}${sc.hz ? ` @${sc.hz} Hz` : ""} · ${what}${sc.detail ? ` (${sc.detail})` : ""}`;
    meta.title = sc.showing || "";
    left.append(name, meta);
    const btn = document.createElement("button");
    btn.textContent = "Identify";
    btn.onclick = () => api.identify(sc.id);
    row.append(left, btn);
    list.append(row);
  }
}

$("box").addEventListener("input", () => (typed = true));
$("name").addEventListener("input", () => (typed = true));

$("test").onclick = async () => {
  msg($("boxMsg"), "Testing…");
  const r = await api.testBox($("box").value);
  msg($("boxMsg"), r.ok ? `Found “${r.box}” at ${r.url}` : r.error, r.ok ? "ok" : "bad");
};
$("save").onclick = async () => {
  const r = await api.setBox($("box").value);
  typed = false;
  msg($("boxMsg"), r.ok ? "Saved." : r.error, r.ok ? "ok" : "bad");
};
$("saveName").onclick = async () => {
  await api.setName($("name").value);
  typed = false;
  msg($("nameMsg"), "Saved. Staff can also rename it on the box.", "ok");
};
$("login").onchange = (e) => api.setStartAtLogin(e.target.checked);
$("unpair").onclick = async () => {
  if (!confirm("Unpair this computer? Its screens show a new pairing code, and staff must remove the old entry on the box.")) return;
  await api.unpair();
};
$("quit").onclick = () => {
  if (confirm("Quit Venuebox? The TVs on this computer go blank until it starts again.")) api.quit();
};

api.onState(render);
api.state().then(render);

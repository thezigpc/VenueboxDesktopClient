// Fetches the pinned mpv build for the Windows installer into vendor/mpv/win32-x64/
// (gitignored). Runs before `npm run dist:win`; `node scripts/fetch-mpv.mjs` by hand too.
//
// mpv (GPLv2+ as built here, with FFmpeg) is a separate program: Venuebox starts it and
// talks to it over its IPC pipe. The installer ships it with its license texts and where
// its exact source is (THIRD-PARTY-NOTICES.md).
//
// To update: pick a shinchiro/mpv-winbuild-cmake release at least two weeks old, set the
// fields below (sha256 from the release asset's "digest"), and the mpv commit for licenses.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const PIN = {
  release: "20261104",
  asset: "mpv-x86_64-20261104-git-46787be250.7z",
  sha256: "84397be53b37945b9dccdb7e8d8579eb431091d26ab362d111da68c3d4482ffa",
  mpvCommit: "46787be2502556586b6a5fea9ebd595f5cd9b713",
  buildScriptsCommit: "bda10a2816ce9908d419b3f4b564227330457e76",
};
const FILES = ["mpv.exe", "d3dcompiler_43.dll"];
const LICENSES = ["Copyright", "LICENSE.GPL", "LICENSE.LGPL"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "vendor", "mpv", "win32-x64");
const stamp = join(out, "VERSION.txt");

if (existsSync(stamp) && readFileSync(stamp, "utf8").includes(PIN.sha256) && FILES.every((f) => existsSync(join(out, f)))) {
  console.log(`mpv ${PIN.release} already in ${out}`);
  process.exit(0);
}

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "venuebox-build" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const work = join(tmpdir(), `venuebox-mpv-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "x"), { recursive: true });
try {
  const url = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${PIN.release}/${PIN.asset}`;
  console.log(`downloading ${PIN.asset}…`);
  const archive = await get(url);
  const sum = createHash("sha256").update(archive).digest("hex");
  if (sum !== PIN.sha256) throw new Error(`checksum mismatch for ${PIN.asset}: got ${sum}`);
  const file = join(work, PIN.asset);
  writeFileSync(file, archive);

  // 7za from electron-builder's 7zip-bin, else Windows' own tar (libarchive reads 7z).
  let sevenZip;
  try {
    const req = createRequire(createRequire(join(root, "package.json")).resolve("app-builder-lib"));
    sevenZip = req("7zip-bin").path7za;
  } catch {
    /* not found */
  }
  if (sevenZip && existsSync(sevenZip)) execFileSync(sevenZip, ["x", "-y", `-o${join(work, "x")}`, file], { stdio: "ignore" });
  else execFileSync(process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", file, "-C", join(work, "x")]);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of FILES) copyFileSync(join(work, "x", f), join(out, f));
  for (const f of LICENSES) writeFileSync(join(out, `mpv-${f}.txt`), await get(`https://raw.githubusercontent.com/mpv-player/mpv/${PIN.mpvCommit}/${f}`));
  writeFileSync(
    stamp,
    [
      `mpv for Windows x64, build ${PIN.release} (${PIN.asset})`,
      `sha256 ${PIN.sha256}`,
      `mpv source: https://github.com/mpv-player/mpv/tree/${PIN.mpvCommit}`,
      `build scripts (FFmpeg and libraries, with their versions): https://github.com/shinchiro/mpv-winbuild-cmake/tree/${PIN.buildScriptsCommit}`,
      `binaries: https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/${PIN.release}`,
      "",
    ].join("\n"),
  );
  console.log(`mpv ${PIN.release} → ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

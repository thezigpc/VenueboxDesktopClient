# VenueboxDesktopClient

A Venuebox (Bar Games box) display client for Windows, macOS and Linux. Turns a PC or mini PC
into a "child box": every attached screen is a TV on the box, rendering games locally in
Chromium (no encoding on the box, no delay).

Contract: `C:\CodeProjects\GameBroker\docs\NATIVE-CLIENTS.md` and
`GameBroker/apps/broker/src/venuebox/protocol.ts` (mirrored in `src/protocol.ts`).

## Install on a venue PC or laptop

In PowerShell on that machine (no admin needed; no Git or Node needed). Venuebox finds the
box on the venue network by itself (box 0.16.2+). `-Box <address>` sets it by hand, for
networks that block discovery (guest Wi-Fi with client isolation):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/thezigpc/VenueboxDesktopClient/main/scripts/install-venuebox.ps1))) -Box 192.168.1.20 -KeepAwake
```

Without `-Box`, drop that part of the line. It turns on TLS 1.2, downloads the latest installer from Releases, installs it to `C:\VenueboxDesktopClient` (`-InstallDir` to change), checks the
box answers, and starts Venuebox. Each screen then shows a 6-digit code: on the box, open the
TVs page → Venuebox apps and type it. `-KeepAwake` keeps a laptop on with the lid closed
while it's plugged in. With an installer copied over by hand:
`powershell -ExecutionPolicy Bypass -File install-venuebox.ps1 -InstallerPath .\Venuebox-Setup-0.2.0.exe -Box 192.168.1.20`.

**Updates:** from 0.3.0 on, Venuebox checks GitHub Releases at start and every 4 hours,
downloads new versions in the background and asks in its settings window before
installing (the TVs go blank for about 20 seconds while it restarts). "Later" asks again the
next day. Older copies (0.1.x, 0.2.x) update with:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/thezigpc/VenueboxDesktopClient/main/scripts/update-venuebox.ps1)))
```

It keeps the box, the pairing and the settings.

The installer isn't code-signed yet: Windows may show a SmartScreen prompt (More info →
Run anyway) the first time.

## Develop

```sh
npm install
npx install-electron          # Electron 45 downloads its binary on demand
npm test                      # typecheck + BoxClient tests against a fake box
npm run start:windowed        # small windows instead of full-screen TVs
```

Inside VS Code terminals, `ELECTRON_RUN_AS_NODE=1` is often set; unset it before `electron .`.

Flags and environment:
- `--windowed`: small window per screen (development).
- `--box=<address>`: set the box address (`192.168.1.20` → `http://192.168.1.20:7210`).
- `VENUEBOX_DATA_DIR=<dir>`: separate settings/token (test runs).

## How it works

| File | Job |
|---|---|
| `src/box-client.ts` | Pairing (`/pair/start`, poll `/pair/status`), WebSocket `/client`, `hello`/`welcome`, reconnect forever with backoff; 4401/4403 → clear token and pair again; 4409 → retry in 5 min. No Electron imports. |
| `src/discovery.ts` | DNS-SD browse for `_venuebox._tcp.local` (legacy unicast from an ephemeral port per LAN interface; no dependencies). The box is remembered by its TXT `id`: when the saved address stops answering, the client re-browses and follows the same id to its new address, keeping the pairing. |
| `src/video.ts`, `src/mpv-ipc.ts`, `src/video-caps.ts` | The video player: one mpv per screen while it plays, driven over JSON IPC; every `video` op gets one `video-reply`, `video-state` when it changes by itself (10 s progress while playing). What `hello.video` declares. Tested with a fake mpv (`test/fake-mpv.ts`). |
| `src/screens.ts` | One frameless, full-screen, always-on-top window per display; `show`/`off`/`reload`/`identify`/`preview`; reports `state`; retries failed loads, restarts crashed or hung pages; hotplug. |
| `src/store.ts` | `config.json` + `token.dat` (Electron `safeStorage`: DPAPI / Keychain / keyring) in the app's user-data folder. |
| `src/main.ts` | Wires it up: single instance, no display sleep, autoplay, tray, settings window (Ctrl+Alt+Shift+V), start at login (on by default for installed builds). |

Screens with nothing to show display the pairing code / connection status, or black once
connected.

**Video** (box 0.28.0+): the box can hand a screen a video link (the Movies app, from the
venue's Jellyfin). Venuebox plays it with a bundled **mpv**, full screen on that screen's
monitor over the page, streaming straight from the media server; when it ends or stops, mpv
closes and the page is back. `hello.video` declares H.264 always, HEVC/AV1/VP9 and 4K only
with hardware decoding (Chromium's `mediaCapabilities`), and `ranges` `sdr` (plus `hdr10`,
`hlg` when a monitor is in Windows HDR mode). The link carries the server's key: it reaches
mpv only over its IPC pipe, never its command line, logs or messages. mpv is fetched at build
time (`npm run fetch-mpv`, pinned and checksummed in `scripts/fetch-mpv.mjs`, into `vendor/`)
and ships with its licenses; see `THIRD-PARTY-NOTICES.md`. `VENUEBOX_MPV=<path>` overrides it;
on Linux/macOS an mpv on `PATH` is used.

**Touch mode** (Settings, off by default) is for touchscreens many people use. Pages get
`window.__BARGAMES_SHARED_SCREEN__ = true` before their scripts run (GameKit: kiosk games
forget the last person), pinch zoom and swipe navigation are off, pages can't leave the
origin the box showed, and pop-ups and downloads are blocked. Typing uses the Windows touch
keyboard. Its option "Use the big on-screen keyboard" also sets
`window.__BARGAMES_KEYBOARD__ = true` (GameKit's `<OnScreenKeyboard />`), for PCs set not to
show Windows' keyboard. Touch mode off sets nothing. The flags reach iframes too
(`src/screen-preload.ts`).

## Build installers

Release: bump `version` in package.json, `npm run dist:win`, then
`gh release create vX.Y.Z release/Venuebox-Setup-X.Y.Z.exe release/Venuebox-Setup-X.Y.Z.exe.blockmap release/latest.yml`
(`latest.yml` is what installed copies check). `npm run dist:win` (NSIS), `npm run dist:linux` (AppImage + deb), `npm run dist:mac` (needs
macOS). No app icon or code signing yet.

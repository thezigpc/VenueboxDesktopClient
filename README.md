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
| `src/screens.ts` | One frameless, full-screen, always-on-top window per display; `show`/`off`/`reload`/`identify`/`preview`; reports `state`; retries failed loads, restarts crashed or hung pages; hotplug. |
| `src/store.ts` | `config.json` + `token.dat` (Electron `safeStorage`: DPAPI / Keychain / keyring) in the app's user-data folder. |
| `src/main.ts` | Wires it up: single instance, no display sleep, autoplay, tray, settings window (Ctrl+Alt+Shift+V), start at login (on by default for installed builds). |

Screens with nothing to show display the pairing code / connection status, or black once
connected.

## Build installers

`npm run dist:win` (NSIS), `npm run dist:linux` (AppImage + deb), `npm run dist:mac` (needs
macOS). No app icon or code signing yet.

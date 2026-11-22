# Third-party software in Venuebox

## mpv (video player)

The Windows installer includes **mpv**, a separate media player program that Venuebox starts
to play video links full screen. Venuebox talks to it over mpv's JSON IPC pipe; it is not
linked into Venuebox.

- mpv is free software: GNU General Public License v2 or later as built here (it includes
  GPL parts of FFmpeg), and parts under the GNU Lesser General Public License. The license
  texts and copyright notice are installed next to it: `resources/mpv/mpv-Copyright.txt`,
  `mpv-LICENSE.GPL.txt`, `mpv-LICENSE.LGPL.txt`.
- The exact build, its checksum and where its complete source code is (mpv at the commit it
  was built from, and the build scripts that pin FFmpeg and every library) are in
  `resources/mpv/VERSION.txt`. The same versions are pinned in `scripts/fetch-mpv.mjs`.
- Build used: [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake)
  release 20261104 (mpv commit 46787be2502556586b6a5fea9ebd595f5cd9b713).

To get the source for the exact binaries shipped, follow those links; if one is no longer
available, open an issue on this repository and we will provide it.

## Electron and Chromium

Venuebox is built on [Electron](https://www.electronjs.org/) (MIT), which includes Chromium
and other components; their licenses ship with the app (`LICENSE.electron.txt`,
`LICENSES.chromium.html`).

// Preload for the TV screen windows (every frame: games may sit in iframes). Sandboxed;
// exposes nothing but GameKit's flags, and only in touch mode.
//
//   touch mode on                  → window.__BARGAMES_SHARED_SCREEN__ = true
//                                    (GameKit 0.10.2: many people use this screen, so kiosk
//                                    games forget the last person). Typing uses the Windows
//                                    touch keyboard, which Windows shows for a tapped field.
//   + "big on-screen keyboard"     → also window.__BARGAMES_KEYBOARD__ = true (GameKit's
//                                    <OnScreenKeyboard />, for PCs that don't show Windows').
//   touch mode off                 → nothing is set; pages behave as on any PC.
//
// GameKit reads the flags when it starts, so they must be in the page's own world before its
// scripts run: contextBridge does that synchronously (a plain window.x = ... here would land
// in the preload's isolated world, where the page can't see it).

import { contextBridge, ipcRenderer } from "electron";

let mode: { touch?: boolean; keyboard?: boolean } = {};
try {
  mode = (ipcRenderer.sendSync("venuebox:touch-mode") as typeof mode) ?? {};
} catch {
  /* main not answering: behave as before (no flags) */
}
if (mode.touch === true) {
  contextBridge.exposeInMainWorld("__BARGAMES_SHARED_SCREEN__", true);
  if (mode.keyboard === true) contextBridge.exposeInMainWorld("__BARGAMES_KEYBOARD__", true);
}

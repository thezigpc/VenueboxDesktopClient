// Start at login: the login item on Windows/macOS, an XDG autostart entry on Linux.

import { app } from "electron";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const linuxFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "venuebox.desktop");

export function getStartAtLogin(): boolean {
  if (process.platform === "linux") return existsSync(linuxFile());
  return app.getLoginItemSettings().openAtLogin;
}

export function setStartAtLogin(on: boolean): void {
  if (process.platform === "linux") {
    const file = linuxFile();
    if (!on) return void rmSync(file, { force: true });
    // An AppImage runs from a temporary mount: start the .AppImage file itself.
    const exec = process.env.APPIMAGE || process.execPath;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, ["[Desktop Entry]", "Type=Application", "Name=Venuebox", `Exec="${exec}"`, "X-GNOME-Autostart-enabled=true", ""].join("\n"));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on });
}

// Settings (config.json) and the device token (token.dat, encrypted with Electron safeStorage:
// DPAPI on Windows, Keychain on macOS, the desktop keyring on Linux).

import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenStore } from "./box-client";

export interface Config {
  /** The box address as typed ("192.168.1.20" or "http://192.168.1.20:7210"). */
  box?: string;
  /** The box's discovery id (TXT id): finds it again if its address changes. */
  boxId?: string;
  /** Venue name from discovery. */
  boxName?: string;
  /** Name sent when pairing (staff can rename it on the box). Defaults to the computer name. */
  name?: string;
  startAtLogin?: boolean;
}

function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class Store implements TokenStore {
  private readonly dir = app.getPath("userData");
  private readonly configFile = join(this.dir, "config.json");
  private readonly tokenFile = join(this.dir, "token.dat");
  private cfg: Config;
  private token?: string;

  constructor(private readonly log: (msg: string, extra?: Record<string, unknown>) => void) {
    mkdirSync(this.dir, { recursive: true });
    try {
      this.cfg = JSON.parse(readFileSync(this.configFile, "utf8")) as Config;
    } catch {
      this.cfg = {};
    }
  }

  /** Reads the saved token (call once, after app ready). */
  async load(): Promise<void> {
    this.token = await this.readToken();
  }

  get config(): Readonly<Config> {
    return this.cfg;
  }

  update(patch: Partial<Config>): Config {
    this.cfg = { ...this.cfg, ...patch };
    writeAtomic(this.configFile, JSON.stringify(this.cfg, null, 2));
    return this.cfg;
  }

  get(): string | undefined {
    return this.token;
  }

  set(token: string): void {
    this.token = token;
    void this.persist(token).catch((err) => this.log("couldn't save the token", { error: String(err) }));
  }

  private async persist(token: string) {
    // "e:" = encrypted by the OS; "p:" = plain (Linux without a keyring), file mode 0600.
    let data: Buffer;
    if (await safeStorage.isAsyncEncryptionAvailable()) {
      data = Buffer.concat([Buffer.from("e:"), await safeStorage.encryptStringAsync(token)]);
    } else {
      this.log("no OS credential store: token saved unencrypted (user-only file)");
      data = Buffer.from(`p:${token}`);
    }
    if (this.token === token) writeAtomic(this.tokenFile, data); // not cleared meanwhile
  }

  clear(): void {
    this.token = undefined;
    rmSync(this.tokenFile, { force: true });
  }

  private async readToken(): Promise<string | undefined> {
    if (!existsSync(this.tokenFile)) return undefined;
    try {
      const buf = readFileSync(this.tokenFile);
      const kind = buf.subarray(0, 2).toString();
      if (kind === "e:") {
        const r = await safeStorage.decryptStringAsync(buf.subarray(2));
        this.token = r.result;
        if (r.shouldReEncrypt) void this.persist(r.result).catch(() => {});
        return r.result;
      }
      if (kind === "p:") return buf.subarray(2).toString();
    } catch (err) {
      this.log("couldn't read the saved token: pairing again", { error: String(err) });
    }
    return undefined;
  }
}

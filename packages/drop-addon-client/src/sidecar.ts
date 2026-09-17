import type { ClientPluginSystem, CommandResult } from "@droposs/plugin-sdk";

export interface GseVersionResult {
  engine: string;
  version: string;
}

export interface GseScanResult {
  gameDir: string;
  targets: string[];
  antiCheat: string | null;
}

export interface GsePatchOptions {
  gameDir: string;
  appId: number;
  emulatorDir?: string;
  flavor?: "gbe_fork" | "gse_fork";
  targets?: string[];
  peers?: string[];
}

export interface GsePatchResult {
  patched: string[];
  backedUp: string[];
}

export interface GseRestoreOptions {
  gameDir: string;
  targets?: string[];
}

export interface GseRestoreResult {
  restored: string[];
}

export interface GseInterfacesResult {
  interfaces: string[];
}

/**
 * Client wrapper around the native `gse-engine` sidecar CLI.
 *
 * Invokes allowlisted `gse-engine` subcommands through `ctx.system.run()`.
 * All subcommands produce structured JSON on stdout or fail with an error on stderr.
 */
export class GseSidecar {
  private available: boolean | undefined;

  constructor(private readonly system?: ClientPluginSystem) {}

  /**
   * Probes whether the native `gse-engine` sidecar is present, allowlisted,
   * and functional. Caches the result for the lifetime of this instance.
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) {
      return this.available;
    }
    if (!this.system || typeof this.system.run !== "function") {
      this.available = false;
      return false;
    }

    try {
      const res = await this.system.run("gse-engine", ["version"], { timeoutMs: 3000 });
      if (res.code === 0 && res.stdout.trim().length > 0) {
        const parsed = JSON.parse(res.stdout) as Partial<GseVersionResult>;
        this.available = parsed.engine === "gse-engine";
      } else {
        this.available = false;
      }
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /**
   * Reset cached availability state (useful for test harnesses).
   */
  resetAvailability(): void {
    this.available = undefined;
  }

  /**
   * Scan a game directory for Steam API targets and anti-cheat markers.
   * Throws fail-closed on any execution or parsing error.
   */
  async scan(gameDir: string): Promise<GseScanResult> {
    const res = await this.runOrThrow(["scan", gameDir]);
    return JSON.parse(res.stdout) as GseScanResult;
  }

  /**
   * Back up original Steam binaries, deploy emulator DLLs, and stage config.
   */
  async patch(options: GsePatchOptions): Promise<GsePatchResult> {
    const args = ["patch", "--game-dir", options.gameDir, "--app-id", String(options.appId)];
    if (options.emulatorDir) {
      args.push("--emulator-dir", options.emulatorDir);
    }
    if (options.flavor) {
      args.push("--flavor", options.flavor === "gse_fork" ? "gse" : "gbe");
    }
    if (options.targets && options.targets.length > 0) {
      args.push("--targets", options.targets.join(","));
    }
    if (options.peers && options.peers.length > 0) {
      args.push("--peers", options.peers.join(","));
    }
    const res = await this.runOrThrow(args);
    return JSON.parse(res.stdout) as GsePatchResult;
  }

  /**
   * Restore original binaries and remove engine-managed config.
   */
  async restore(options: GseRestoreOptions): Promise<GseRestoreResult> {
    const args = ["restore", "--game-dir", options.gameDir];
    if (options.targets && options.targets.length > 0) {
      args.push("--targets", options.targets.join(","));
    }
    const res = await this.runOrThrow(args);
    return JSON.parse(res.stdout) as GseRestoreResult;
  }

  /**
   * Extract Steam interface identifiers from a binary.
   */
  async extractInterfaces(binaryPath: string): Promise<string[]> {
    const res = await this.runOrThrow(["interfaces", binaryPath]);
    const parsed = JSON.parse(res.stdout) as GseInterfacesResult;
    return parsed.interfaces ?? [];
  }

  private async runOrThrow(args: string[]): Promise<CommandResult> {
    if (!this.system || typeof this.system.run !== "function") {
      throw new Error("Client plugin system capability is unavailable");
    }
    const res = await this.system.run("gse-engine", args, { timeoutMs: 15_000 });
    if (res.code !== 0) {
      const detail = res.stderr.trim() || `process exited with code ${res.code}`;
      throw new Error(`gse-engine ${args[0]} failed: ${detail}`);
    }
    return res;
  }
}

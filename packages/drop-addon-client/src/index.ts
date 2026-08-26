/**
 * drop-addon-client — Drop client addon: launch lifecycle hooks, VPN
 * validation and UI extensions.
 *
 * Skeleton module layout; the lifecycle is specified in
 * docs/architecture/SPECIFICATION.md (drop-gse Phase 2).
 */

import type { MeshRoomRef } from "./vpn.js";

export type { MeshRoomRef, MeshBackend, MeshStatus, VpnValidator } from "./vpn.js";
export { ZeroTierValidator, TailscaleValidator, type TailscaleLocalAPI } from "./vpn.js";

/** Lifecycle stages executed around a game launch when a room is active. */
export type LifecycleStage =
  | "pre-launch:anticheat-check"
  | "pre-launch:dll-backup"
  | "pre-launch:config-deploy"
  | "pre-launch:mesh-join"
  | "launch"
  | "post-exit:dll-restore"
  | "post-exit:config-remove"
  | "post-exit:mesh-leave";

export interface LifecycleHook {
  stage: LifecycleStage;
  execute(context: LaunchContext): Promise<void>;
}

export interface LaunchContext {
  gameId: string;
  versionId: string;
  /** Absolute path of the installed game directory on this machine. */
  gameDir: string;
  roomId?: string;
  /** Backend-specific mesh ref, populated after a successful mesh-join. */
  meshRef?: MeshRoomRef;
}

/**
 * Ordered pipeline applied by the addon around every launch.
 *
 * Failure semantics: any pre-launch failure aborts the launch and rolls back
 * completed stages in reverse order; post-exit failures are logged but never
 * block process teardown.
 */
export const PIPELINE: ReadonlyArray<LifecycleStage> = [
  "pre-launch:anticheat-check",
  "pre-launch:dll-backup",
  "pre-launch:config-deploy",
  "pre-launch:mesh-join",
  "launch",
  "post-exit:dll-restore",
  "post-exit:config-remove",
  "post-exit:mesh-leave",
];

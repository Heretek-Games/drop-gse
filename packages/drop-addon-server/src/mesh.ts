/**
 * Mesh transport for drop-gse now lives in the canonical provider,
 * `@drop/zerotier-mesh` (maintained in `drop-zerotier`). This module only
 * re-exports it and preserves the historical `roomCidr` name used by the room
 * store, so there is exactly one mesh implementation in the workspace.
 */
export * from "@drop/zerotier-mesh";
export { networkCidr as roomCidr } from "@drop/zerotier-mesh";

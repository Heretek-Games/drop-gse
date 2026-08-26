# drop-gse Architecture Specification

> Status: draft v0.1 (Phase 2 of the initial architecture audit).
> Companion document: [`docs/research/COMPARATIVE_ANALYSIS.md`](../research/COMPARATIVE_ANALYSIS.md).

## 1. Overview

`drop-gse` is an addon for [Drop](https://github.com/Drop-OSS/drop) that turns
"launch a game" into "join a multiplayer room": it provisions a per-room
ephemeral mesh network (Tailscale or ZeroTier), deploys a Goldberg-family
Steam emulator configured to discover peers across that mesh, and restores
everything on exit.

```text
┌─────────────┐  room API / WS   ┌──────────────────┐
│ Drop Client │◄────────────────►│  Drop Server      │
│ (Tauri/Rust │                  │  addon: room mgr, │
│  + Nuxt)    │                  │  mesh coordinator │
└──────┬──────┘                  └────────┬─────────┘
       │ pre/post launch hooks            │ provisions
       ▼                                  ▼
┌─────────────┐   custom_broadcasts  ┌──────────────────┐
│ gse-engine  │                      │ Tailscale/ZeroTier│
│ DLL+config  │                      │ control plane     │
└──────┬──────┘                      └────────┬─────────┘
       │ UDP :47584 announce/lobby            │
       ▼                                      ▼
   ════════════════ mesh VPN data plane (room subnet) ════════════════
```

## 2. Platform integration seams (verified against Drop source)

| Seam                | Evidence                                                                                                                                            | Use                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Server HTTP API     | `backend/main.go` — gorilla/mux on `:3433`, route table under `/api/v1`; Nuxt3 Nitro handlers in `server/server/api/v1/**`                          | addon exposes `/api/v1/gse/rooms/*`                                                                       |
| Real-time fanout    | `server/server/api/v1/notifications/ws.get.ts` WebSocket channel                                                                                    | room lifecycle events, credential push                                                                    |
| Service manager     | `server/server/internal/services/index.ts` (`Service<T>`, healthchecks)                                                                             | host mesh-controller sidecar if ZeroTier self-hosted                                                      |
| Launch pipeline     | `desktop/src-tauri/process/src/process_manager.rs` — `ProcessHandler` trait (`process_manager.rs:627`), pluggable launchers (`process_handlers.rs`) | GseLauncher strategy wraps commands; emulator-launch config rows already exist (`emulator_launch_config`) |
| Embedded VPN client | `desktop/src-tauri/tailscale/` crate (C ABI → Go lib)                                                                                               | in-process Tailscale join/status/logout                                                                   |
| Desktop UI          | Nuxt app in `desktop/main` (`pages/`, plugins pattern)                                                                                              | "Host Multiplayer Room" / "Join via Drop" actions                                                         |

Drop has **no formal plugin registry**; integration is upstream-contributable
code (a new `ProcessHandler`, server routes, UI pages) plus this repo holding
the coordination plane and engine. The addon packages are structured so each
piece can be upstreamed independently.

## 3. Component specification

### 3.1 `gse-engine` (Rust)

Deterministic patcher library invoked by the client addon.

- **Scanner** — locate steam_api targets
  (`steam_api.dll`, `steam_api64.dll`, `libsteam_api.so`, plus `steamclient*.dll`)
  with recursive depth limits.
- **Anti-cheat gate** (see §4.2) — refuse to proceed on detection.
- **Interface extractor** — port SteamRoll's regex scan over the original DLL's
  ASCII sections to emit `steam_interfaces.txt` (required for Source/Unreal3
  engine stability).
- **Patcher** — idempotent backup (`<name>.orig` + SHA-256 manifest), replace,
  verify. Rollback = restore from manifest.
- **Config writer** — generate `steam_settings/{configs.main.ini,
steam_appid.txt, steam_interfaces.txt, custom_broadcasts.txt}` with room peer
  addresses; flavor-aware (gbe_fork vs gse_fork INI keys).

### 3.2 `drop-addon-server`

Coordination service (TypeScript) registered behind Drop's server. It is a thin
coordination layer over durable state — not stateless:

- **Room store (durable)** — rooms, memberships, credential records and TTLs
  live in Drop's existing Postgres instance (Prisma schema extension), so
  active rooms survive coordinator restart or replacement. Credentials are
  stored encrypted-at-rest and re-pushed from the store on coordinator
  recovery; nothing is reconstructed from memory alone.
- **Host lease (distributed)** — the host role is a lease in the room row:
  renewed by heartbeat every ~15 s, expired after ~45 s of silence. On expiry,
  any member may claim the lease; first writer wins via Postgres row-level
  locking. Host migration is therefore automatic and does not require the old
  host to participate.
- **Room manager** — each session gets a unique server-generated `roomId`;
  `(gameId, versionId)` is a join-time compatibility check, not the room key.
  The room pins an emulator binding (`flavor`, release tag, release digest)
  that all members must honor for bit-identical configs. Host migration on
  host loss per the lease rules above.
- **Mesh coordinator** — pluggable backend:
  - _Tailscale_: **one-off ephemeral auth key per approved member** — never a
    shared reusable room key, since any holder of a reusable key could enroll
    arbitrary extra devices and revocation does not de-register already-created
    nodes. Keys are ACL-tag-scoped; teardown revokes outstanding keys and
    removes every node registered under the room's tag. Members join via the
    embedded tailscale crate.
  - _ZeroTier_: create controller network (`POST /controller/network/<nodeId>______`)
    configured with `ipAssignmentPools`, `v4AssignMode: {"zt": true}`, a
    managed route for the room CIDR, `enableBroadcast=true`, `private=true`;
    authorize member IDs as they present room tokens (see §4.1 for why real
    per-room subnets are a ZeroTier property).
- **Credential distribution** — secrets returned only from the authenticated,
  membership-checked `provisionMeshCredential` operation; pushed over Drop's
  WebSocket channel to approved members; never logged; one-off where the
  backend allows.
- **Lobby registry** — clients relay emulator lobby announcements; the server
  publishes aggregated "joinable lobbies" per room.

### 3.3 `drop-addon-client`

Runs inside/near the Drop desktop process around every launch:

```text
pre-launch:
  anticheat-check → dll-backup → config-deploy → mesh-join → LAUNCH
post-exit (always runs):
  dll-restore → config-remove → mesh-leave
```

Failure semantics: any pre-launch failure aborts and rolls back completed
stages in reverse order; post-exit failures are logged and retried, never
block process teardown. Crash safety: a startup sweep detects stale
`.orig` backups + orphaned configs (crash marker file) and repairs state
before anything else runs.

UI: game detail page gains Host Room / Join Room actions; active room banner
with member list and teardown button.

## 4. Threat & failure-mode audit

### 4.1 Broadcast storms & multi-game isolation

_Risk:_ multiple concurrent games broadcast on UDP 47584; without isolation a
peer running Game B receives Game A announces → ghost lobbies, cross-game
corruption (both forks namespace by AppID but rely on it being correct).

_Controls:_

1. **Per-room isolation (backend-dependent)** — ZeroTier provides true
   per-room subnets: each room's controller network gets its own CIDR via
   `ipAssignmentPools` + managed routes, and `custom_broadcasts.txt` contains
   only same-room peers. Tailscale cannot do per-room subnets — tailnet IPs
   come from the shared CGNAT pool `100.64.0.0/10` — so isolation there is
   enforced by per-room ACL tags in the tailnet policy, which restrict which
   nodes a room member can reach.
2. **AppID pinning** — room membership requires matching `(gameId, versionId)`
   (join-time compatibility check against the unique room); the engine writes
   the pinned AppID into `steam_appid.txt`.
3. **Rate limiting** — announce cadence is fixed (~60 s) by the emulator; the
   mesh ACL (Tailscale tags / ZeroTier member rules) restricts traffic to
   room members, bounding blast radius to the room.

### 4.2 Anti-cheat & DLL integrity collision

_Risk:_ EasyAntiCheat/BattlEye validate `steam_api` binaries at boot; a
modified binary is rejected (game fails) or trips enforcement (account risk).

_Controls:_

1. **Pre-flight scan** — gse-engine refuses to patch when EAC/BattlEye markers
   are present (`anticheat.rs`), surfacing a hard user-facing block, not a
   warning.
2. **Server-side compatibility database** — known-incompatible titles are
   rejected at room creation; community-maintained list shipped with metadata.
3. **Integrity manifest** — backups are hash-recorded; restore verifies digests
   so a corrupted/interrupted session cannot leave silently-modified binaries.
4. Explicit user consent flow: the addon never patches a game whose original
   state cannot be provably restored.

### 4.3 Ephemeral provisioning vs long-lived mesh

|                 | Per-room ephemeral (chosen)                                                                                               | Persistent cluster tailnet/network      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Isolation       | strong — ZeroTier: per-room CIDR; Tailscale: per-room ACL tags (no true per-room subnet, §4.1); credentials die with room | weak (all users see all games' traffic) |
| Credential risk | low — one-off short-TTL keys, ephemeral nodes auto-purge (30–60 min)                                                      | high — standing keys circulate          |
| Setup cost      | join latency ~seconds at room start                                                                                       | zero at room start                      |
| Scaling         | unbounded room count                                                                                                      | flat network, ACL sprawl                |
| Failure mode    | control-plane outage blocks new rooms only                                                                                | outage breaks everyone                  |

Ephemeral wins on security and correctness; the cost is a provisioning step
amortized behind the "Host Room" click. A persistent network remains available
as a fallback backend for groups that already run one (BYO-network mode),
trading isolation for simplicity.

### 4.4 Cross-platform compatibility

| Platform                      | Mechanism                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows                       | Direct DLL swap (`steam_api64.dll`); backup/restore via engine                                                                                                                                                                              |
| Linux native                  | Swap `libsteam_api.so`; engine paths identical                                                                                                                                                                                              |
| Linux / Steam Deck via Proton | Swap inside the Proton prefix's `drive_c` game dir; emulator ships Windows binaries loaded under Wine. `WINEDLLOVERRIDES="steam_api64=n,b"` not required when physically replacing the DLL but set defensively for wrapper-mode deployments |

Engine operations must be prefix-aware: resolve the real game directory
through Drop's installed-version records rather than guessing prefix layouts.

### 4.5 Additional failure modes

- **Host disconnect mid-session** — server detects via WS heartbeat, triggers
  host-migration per the distributed lease rules (§3.2); mesh credentials
  outlive the host until room TTL expires.
- **Coordinator restart/replacement** — rooms and memberships live in the
  durable room store (§3.2); a replacement coordinator re-reads state and
  re-pushes stored credentials; in-flight operations resume from the journal.
- **Clock skew / early expiry** — ephemeral keys carry server-stamped expiry;
  clients refresh before launch if < 10 min remain.
- **Partial crash between backup and replace** — crash-marker journal written
  before first mutation; startup sweep replays/rolls back the journal.
- **Stolen Tailscale key** — one-off keys limit exposure to a single node
  enrollment; teardown additionally removes every node registered under the
  room's ACL tag (revocation alone does not de-register existing nodes).
- **Malicious room host** — host controls membership but not member binaries;
  credentials are generated server-side, never by the host.

## 5. Security posture summary

- Emulator distributions fetched over pinned, checksummed releases (LGPL-3.0
  sources: gbe_fork/gse_fork). ReFix excluded (license inconsistency, §1.5 of
  the comparative analysis).
- Mesh secrets: short-lived, membership-gated, memory-only on client, never
  persisted to disk logs.
- All binaries restored and hash-verified post-session; any drift reported.
- Addon communicates only with its own Drop instance; no third-party telemetry.

## 6. Milestones

1. **M1** — gse-engine patch/config loop complete with tests (Windows + Linux).
2. **M2** — server room manager + one mesh backend (Tailscale) end-to-end.
3. **M3** — client lifecycle integration behind a feature flag; UI actions.
4. **M4** — ZeroTier backend, compatibility database, crash-recovery sweep.

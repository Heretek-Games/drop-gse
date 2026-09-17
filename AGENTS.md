# AGENTS.md — Drop GSE contributor & AI agent guide

**Drop GSE** (`drop-gse`) is the dedicated Goldberg Steam Emulator engine and multiplayer session orchestrator for the [Drop](https://github.com/Heretek-Games/drop) game distribution platform.

It is maintained by [Heretek Games](https://github.com/Heretek-Games/drop-gse).

---

## 1. Architecture & Layout

| Package                           | Stack      | Description                                                                                                                                                                                                                                                                                     |
| :-------------------------------- | :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`packages/gse-engine/`**        | Rust crate | Core emulator patcher: target binary discovery (`scanner.rs`), anti-cheat detection (`anticheat.rs`), DLL manifest backup/restore (`dll.rs`), interface export (`interfaces.rs`), path containment (`path_guard.rs`), release staging (`dist.rs`), and atomic patch plan executor (`patch.rs`). |
| **`packages/drop-addon-client/`** | TypeScript | Desktop client hooks: launch interceptors, room configuration generator (`custom_broadcasts.txt`, `steam_appid.txt`), DLL staging manager, and UI multiplayer modal components.                                                                                                                 |
| **`packages/drop-addon-server/`** | TypeScript | Drop server plugin: room orchestration, lease heartbeats, credential lifecycle, and WebSocket event channels (`gse:credential`, `gse:heartbeat`).                                                                                                                                               |

> **Mesh dependency**: `drop-addon-server` consumes `@heretek-games/zerotier-mesh`
> (published from the `drop-zerotier` repository) as the single mesh-transport
> implementation. This repo does not vendor or clone the sibling package.

---

## 2. Key Architectural Invariants

1. **Fail-Closed Anti-Cheat Protection**:
   - `anticheat.rs` scans game directories for EasyAntiCheat (`EasyAntiCheat*.dll`, `EasyAntiCheat/`), BattlEye (`BEService*.exe`), and related anti-cheat binaries.
   - Any detection immediately and permanently aborts patching to protect user accounts.
2. **Deterministic Manifest Backup & Atomic Rollback**:
   - Original DLLs (`steam_api.dll`, `steam_api64.dll`) are backed up with SHA-256 validation before any emulator file is copied.
   - On game exit or error, the original binary is restored and verified.
3. **Symlink Traversal Prevention**:
   - `path_guard.rs` enforces that all patch and config writes are confined to the intended target game directory. Any symlinks pointing outside the install tree are rejected.
4. **Decoupled Mesh VPN Transport**:
   - `drop-gse` consumes peer addresses (`ActiveRoom`, `peers`). Network transport (ZeroTier/ZTNET, Tailscale, or LAN) is delegated to network providers such as `drop-zerotier`.

---

## 3. Toolchain & Quality Commands

- **Rust toolchain**: `cargo +nightly`
- **Node toolchain**: Node.js `>=22`, npm / pnpm

```bash
# Test the Rust GSE engine crate
cd packages/gse-engine && cargo +nightly test

# Check clippy & formatting
cd packages/gse-engine && cargo +nightly clippy -- -D warnings
cd packages/gse-engine && cargo +nightly fmt --check

# Test TypeScript client/server addons
npm test
npm run typecheck
```

### Native sidecar (`gse-engine`) provisioning

- The client addon invokes `gse-engine` through `ctx.system.run` under the
  `system:sidecar` + `system:command` capabilities with
  `client.commands: ["gse-engine"]`; probing (`gse-engine version`) fails over
  to the TypeScript pipeline harmlessly.
- Release builds bundle static binaries for `linux-x64` (musl), `windows-x64`,
  and `macos-arm64` into `plugin-bundle/sidecars/` via `cargo-zigbuild`; their
  SHA-256 digests are recorded under `client.sidecars` by
  `scripts/sidecar-manifest.mjs` (release-build only — binaries are not
  committed and `npm run validate` locally expects no `sidecars` section when
  they are absent).
- Drop Desktop stages the matching target into its per-plugin app-data bin dir
  and appends it to bare-name resolution after `PATH` and well-known dirs.

## 4. Conventions

- **Commits**: Conventional Commits (`feat(engine): ...`, `fix(client): ...`, `test(server): ...`).
- **Safety**: Do not use `unwrap()` in production engine code; return explicit `Result<T, GseError>`.

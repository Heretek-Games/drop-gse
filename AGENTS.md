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

> **Workspace dependency**: `drop-addon-server` consumes `@drop/zerotier-mesh`
> from the sibling `drop-zerotier` repository (`../drop-zerotier/packages/mesh-core`)
> as the single mesh-transport implementation. Clone `drop-zerotier` next to
> `drop-gse` (the Heretek workspace layout) and build `mesh-core` before
> installing; CI does this automatically.

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

---

## 4. Conventions

- **Commits**: Conventional Commits (`feat(engine): ...`, `fix(client): ...`, `test(server): ...`).
- **Safety**: Do not use `unwrap()` in production engine code; return explicit `Result<T, GseError>`.

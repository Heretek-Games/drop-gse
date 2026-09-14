# gse-engine

Core emulator patching engine for `drop-gse`.

> **Status: reference library.** The crate is tested in CI but is not wired
> into the shipped plugin bundle: neither addon `package.json` depends on it
> and no `system:sidecar` capability is declared. The shipping launch pipeline
> is the TypeScript `drop-addon-client`. Sidecar/napi integration is planned
> (M4 in the architecture specification).

Responsibilities (per the architecture specification, Phase 2):

- **DLL manager** — backup (`*.orig`), swap, and restore of `steam_api.dll`,
  `steam_api64.dll`, `libsteam_api.so`; integrity verification via hash manifest.
- **Config generator** — writes Goldberg-family `steam_settings/` layouts
  (`configs.main.ini`, `steam_appid.txt`, `custom_broadcasts.txt`,
  `steam_interfaces.txt`) targeting mesh peer addresses.
- **Anti-cheat detection** — pre-flight scan for EasyAntiCheat / BattlEye
  binaries and refusal to patch when present.
- **Broadcast router config** — maps emulator UDP broadcast (port 47584)
  onto mesh VPN peers.

Language: Rust (native, cross-platform: Windows + Linux/Proton prefixes).
See
[`docs/architecture/SPECIFICATION.md`](../../docs/architecture/SPECIFICATION.md).

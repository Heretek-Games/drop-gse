# gse-engine

Core emulator patching engine for `drop-gse`.

> **Status: library + `gse-engine` CLI binary.** The crate is tested in CI and
> now ships a process (`scan`, `patch`, `restore`, `interfaces`) that the Drop
> client addon can invoke as a sidecar (M4). The addon still uses its
> TypeScript pipeline for staging; wiring it to this binary is the remaining
> sidecar integration step.

```sh
# Discover targets and anti-cheat markers
gse-engine scan /path/to/game

# Patch (back up originals + write steam_settings) and restore
gse-engine patch --game-dir /path/to/game --emulator-dir ./goldberg \
  --app-id 12345 --peers 10.0.0.2,10.0.0.3 [--targets steam_api64.dll] [--flavor gse]
gse-engine restore --game-dir /path/to/game
```

Each command prints a single JSON object on success.

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

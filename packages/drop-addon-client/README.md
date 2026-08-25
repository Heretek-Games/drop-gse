# drop-addon-client

Drop desktop client addon for `drop-gse`: launch lifecycle hooks and UI.

Responsibilities:

- **Pre-launch hook** — invoke `gse-engine` to back up originals, deploy the
  emulator DLL/config set, and point `custom_broadcasts.txt` at mesh peers.
- **VPN interface validation** — verify the mesh interface is up and reachable
  before launch (Tailscale Local API / ZeroTier service API on localhost:9993).
- **Post-exit teardown** — restore original binaries, remove ephemeral routing,
  logout ephemeral mesh identity.
- **UI extensions** — "Host Multiplayer Room" / "Join via Drop" actions wired
  into the Drop desktop (Nuxt) game detail view.

Implementation note: Drop's desktop app (Tauri/Rust) already embeds a Tailscale
client crate and exposes a `ProcessHandler` trait for wrapping launch commands;
this addon targets those seams. Skeleton only in this commit — see
[`docs/architecture/SPECIFICATION.md`](../../docs/architecture/SPECIFICATION.md).

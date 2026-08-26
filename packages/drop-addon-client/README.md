# drop-addon-client

Drop desktop client addon for `drop-gse`: launch lifecycle hooks and UI.

Responsibilities:

- **Pre-launch hook** — invoke `gse-engine` to back up originals, deploy the
  emulator DLL/config set, and point `custom_broadcasts.txt` at mesh peers.
- **VPN interface validation** — verify the mesh interface is up and reachable
  before launch. Per-backend transports are documented in
  [`src/vpn.ts`](src/vpn.ts): Tailscale uses a platform-specific LocalAPI
  transport (Linux: `/var/run/tailscale/tailscaled.sock`; Windows: named pipe;
  macOS: local TCP + Basic-Auth token) — and Drop's desktop already embeds
  the tailscale Go client behind a C-ABI crate
  (`desktop/src-tauri/tailscale/`), which is the preferred integration.
  ZeroTier uses the HTTP service API on `localhost:9993` with the
  `X-ZT1-AUTH` header (token from `authtoken.secret`).
- **Post-exit teardown** — restore original binaries, remove ephemeral routing,
  logout ephemeral mesh identity.
- **UI extensions** — "Host Multiplayer Room" / "Join via Drop" actions wired
  into the Drop desktop (Nuxt) game detail view.

Implementation note: Drop's desktop app (Tauri/Rust) already embeds a Tailscale
client crate and exposes a `ProcessHandler` trait for wrapping launch commands;
this addon targets those seams. Skeleton only in this commit — see
[`docs/architecture/SPECIFICATION.md`](../../docs/architecture/SPECIFICATION.md).

# drop-addon-client

Drop desktop client addon for `drop-gse`: launch lifecycle hooks and UI.

Responsibilities:

- **Pre-launch hook** — invoke `gse-engine` to back up originals, deploy the
  emulator DLL/config set, and point `custom_broadcasts.txt` at mesh peers.
- **Mesh join is delegated** — joining/leaving the ZeroTier mesh is owned by the
  `drop-zerotier` client addon (see its `pre-launch:network` hook). This addon
  only consumes the peer addresses the GSE server reports for the room.
- **Post-exit teardown** — restore original binaries and remove staged config.
- **UI extensions** — "Host Multiplayer Room" / "Join via Drop" actions wired
  into the Drop desktop (Nuxt) game detail view.

Implementation note: Drop's desktop app (Tauri/Rust) runs client plugin launch
hooks and exposes `ctx.system.run` for allowlisted native commands; the
`drop-zerotier` client addon uses it to run `zerotier-cli`. See
[`docs/architecture/SPECIFICATION.md`](../../docs/architecture/SPECIFICATION.md).

# drop-addon-client

Drop desktop client addon for `drop-gse`: launch lifecycle hooks and UI.

Responsibilities:

- **Pre-launch hook** — back up originals through the scoped `ctx.gameFs`,
  stage the emulator config set, and point `custom_broadcasts.txt` at mesh
  peers. (`gse-engine` now ships a `gse-engine` CLI for engine-backed staging;
  invoking it as a sidecar from this hook is the remaining M4 step.)
- **Mesh join is delegated** — joining/leaving the ZeroTier mesh is owned by the
  `drop-zerotier` client addon (see its `pre-launch:network` hook). This addon
  only consumes the peer addresses the GSE server reports for the room.
- **Post-exit teardown** — restore original binaries, remove staged config, and
  report newly earned achievements to the core unlock endpoint (portable GSE
  saves only; a pre-existing `configs.user.ini` is never overwritten).
- **UI extensions** — "Host Multiplayer Room" / "Join via Drop" actions wired
  into the Drop desktop (Nuxt) game detail view.

Implementation note: Drop's desktop app (Tauri/Rust) runs client plugin launch
hooks and exposes `ctx.system.run` for allowlisted native commands; the
`drop-zerotier` client addon uses it to run `zerotier-cli`. See
[`docs/architecture/SPECIFICATION.md`](../../docs/architecture/SPECIFICATION.md).

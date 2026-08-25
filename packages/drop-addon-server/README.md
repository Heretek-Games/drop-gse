# drop-addon-server

Drop server plugin for `drop-gse`: room orchestration and mesh coordination.

Responsibilities:

- **Room manager** — create/join/list multiplayer rooms bound to a game version.
- **Mesh coordinator** — provisions per-room ephemeral mesh credentials
  (Tailscale auth keys or ZeroTier network invites), distributes them to
  approved members over authenticated Drop client API channels.
- **Lobby registry** — aggregates emulator LAN lobby announcements relayed by
  clients so rooms are discoverable before launch.
- **State sync** — room lifecycle events (member join/leave, host migration,
  teardown) fanned out to clients.

Integration target: Drop server is a Go HTTP service (`gorilla/mux`) on `:3433`
with a Nuxt3 front-end; this package provides the coordination plane and the
API contract consumed by `drop-addon-client`. Skeleton only in this commit —
see [`docs/architecture/SPECIFICATION.md`](../../docs/architecture/SPECIFICATION.md).

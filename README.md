# drop-gse

Automated peer-to-peer multiplayer over virtual mesh networks (Tailscale / ZeroTier)
for the [Drop](https://github.com/Drop-OSS/drop) gaming platform — powered by
Steam emulator wrappers (Goldberg-family forks) with managed orchestration from
the Drop server.

> **Status:** initial architecture audit. See
> [`docs/architecture/SPECIFICATION.md`](docs/architecture/SPECIFICATION.md)
> and [`docs/research/COMPARATIVE_ANALYSIS.md`](docs/research/COMPARATIVE_ANALYSIS.md).

## Packages

| Package                      | Role                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/drop-addon-server` | Drop server plugin: room orchestration, mesh token distribution, lobby registry                                                                               |
| `packages/drop-addon-client` | Drop client plugin: pre-launch hooks, VPN validation, post-exit teardown, achievement unlock bridge, UI extensions                                            |
| `packages/gse-engine`        | Emulator patcher crate + `gse-engine` CLI (`scan`/`patch`/`restore`/`interfaces`), invoked by the client addon as a native sidecar with a TypeScript fallback |

## Sidecar provisioning

Release builds ship static `gse-engine` binaries for `linux-x64` (musl),
`windows-x64`, and `macos-arm64` inside the `.dropplugin` bundle
(`plugin-bundle/sidecars/`; digests recorded under `client.sidecars` in the
manifest). Drop Desktop stages the matching platform binary at plugin
activation (SHA-256-verified) and resolves the allowlisted `gse-engine`
command against it via `ctx.system.run`. Where no binary is available
(browser mode, older hosts, or a missing target), the client addon falls back
to its TypeScript-only pipeline automatically.

Users building from source can place their own `gse-engine` binary on `PATH`
instead; capability probing degrades transparently.

## Automated review

PRs are reviewed by two bots:

- **CodeRabbit** — inline review threads and walkthrough summaries.
- **OpenCodeReview** (`alibaba/open-code-review`) — LLM-powered review via an
  OpenAI-compatible endpoint (`.github/workflows/ocr-review.yml`). Re-review on
  demand by commenting `/open-code-review` (maintainers only).

OpenCodeReview requires these **organization** Actions secrets
(Org Settings → Secrets and variables → Actions → Organization secrets):

| Secret      | Purpose                        |
| ----------- | ------------------------------ |
| `LLM_API`   | OpenAI-compatible endpoint URL |
| `LLM_KEY`   | Auth token for the endpoint    |
| `LLM_MODEL` | Model name                     |

## License

GPL-3.0 — chosen for compatibility with the LGPL-3.0 licensed Goldberg-family
emulator codebases (`gbe_fork`, `gse_fork`) this addon wraps.

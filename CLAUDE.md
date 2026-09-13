# Drop GSE — Claude Developer Guide

> **Canonical guide: read [`AGENTS.md`](./AGENTS.md)** — it is the source of truth for the architecture, safety invariants, commands, and conventions for `drop-gse`.

## Quick Reference

- **Crate**: `packages/gse-engine/` (Rust)
- **Addons**: `packages/drop-addon-client/`, `packages/drop-addon-server/` (TypeScript)
- **Run Tests**: `cargo +nightly test --manifest-path packages/gse-engine/Cargo.toml`
- **Core Invariant**: Fail-closed anti-cheat checks, SHA-256 backup/restore, strict path guards.

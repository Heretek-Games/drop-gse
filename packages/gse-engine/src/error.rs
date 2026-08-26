//! Error types shared across gse-engine operations.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("game directory not found: {0}")]
    GameDirNotFound(String),
    #[error("anti-cheat present, refusing to patch: {0}")]
    AntiCheatPresent(String),
    #[error("steam_api binary not found in: {0}")]
    SteamApiNotFound(String),
    #[error("anti-cheat scan failed (fail closed): {0}")]
    ScanFailed(String),
    #[error("backup manifest mismatch for {path}: expected {expected}, found {found}")]
    ManifestMismatch {
        path: String,
        expected: String,
        found: String,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("manifest serialization error: {0}")]
    Manifest(#[from] serde_json::Error),
}

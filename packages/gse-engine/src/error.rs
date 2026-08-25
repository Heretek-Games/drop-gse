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
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

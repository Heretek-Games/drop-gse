//! `gse-engine` — emulator scanner, patcher and `steam_settings` generator.
//!
//! Track A of the drop-gse split: everything needed to run a game under a
//! Goldberg-family Steam emulator, with or without a mesh. Track B supplies the
//! peer addresses that end up in `custom_broadcasts.txt`.

pub mod anticheat;
pub mod config;
pub mod dist;
pub mod dll;
pub mod error;
pub mod interfaces;
pub mod patch;
pub mod path_guard;
pub mod scanner;

pub use error::EngineError;
pub use patch::{PatchReport, apply_plan, restore};

/// Target emulator distributions the engine can deploy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmulatorFlavor {
    /// Detanup01/gbe_fork — drop-in replacement build.
    GbeFork,
    /// alex47exe/gse_fork — gbe_fork fork with overlay work.
    GseFork,
}

/// High-level patch operation against an installed game directory.
#[derive(Debug, Clone)]
pub struct PatchPlan {
    pub flavor: EmulatorFlavor,
    pub app_id: u32,
    /// Relative target binary names to back up and replace.
    pub targets: Vec<String>,
    /// Mesh peer addresses written into `custom_broadcasts.txt`. Empty means
    /// LAN/offline mode.
    pub broadcast_peers: Vec<String>,
}

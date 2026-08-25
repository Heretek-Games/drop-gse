//! gse-engine — core emulator patcher, DLL manager & config generator.
//!
//! Skeleton module layout; each module is specified in
//! `docs/architecture/SPECIFICATION.md` (drop-gse Phase 2).

pub mod anticheat;
pub mod config;
pub mod dll;
pub mod error;

/// Target emulator distributions the engine can deploy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmulatorFlavor {
    /// Detanup01/gbe_fork — drop-in replacement build.
    GbeFork,
    /// alex47exe/gse_fork — gbe_fork fork with overlay/HDR work.
    GseFork,
}

/// High-level patch operation performed against an installed game directory.
#[derive(Debug)]
pub struct PatchPlan {
    pub flavor: EmulatorFlavor,
    pub app_id: u32,
    /// Files to back up before replacement (relative paths).
    pub backup: Vec<String>,
    /// Mesh peer addresses to write into `custom_broadcasts.txt`.
    pub broadcast_peers: Vec<String>,
}

//! DLL / shared-library backup, swap and restore.
//!
//! Backup convention: original binaries are copied aside with a `.orig`
//! suffix before any replacement, and a hash manifest records their digests
//! so teardown can verify restoration integrity.

use std::path::Path;

use crate::error::EngineError;

/// steam_api binaries we may replace, per platform.
pub const TARGET_BINARIES: &[&str] = &[
    "steam_api.dll",
    "steam_api64.dll",
    "libsteam_api.so",
];

/// Back up `binaries` inside `game_dir` as `<name>.orig` if not already done.
pub fn backup_originals(game_dir: &Path, binaries: &[&str]) -> Result<Vec<String>, EngineError> {
    let mut backed_up = Vec::new();
    for name in binaries {
        let src = game_dir.join(name);
        let dst = game_dir.join(format!("{name}.orig"));
        if src.exists() && !dst.exists() {
            std::fs::copy(&src, &dst)?;
            backed_up.push(name.to_string());
        }
    }
    Ok(backed_up)
}

/// Restore `*.orig` backups created by [`backup_originals`].
pub fn restore_originals(game_dir: &Path, binaries: &[&str]) -> Result<(), EngineError> {
    for name in binaries {
        let dst = game_dir.join(name);
        let src = game_dir.join(format!("{name}.orig"));
        if src.exists() {
            std::fs::copy(&src, &dst)?;
            std::fs::remove_file(&src)?;
        }
    }
    Ok(())
}

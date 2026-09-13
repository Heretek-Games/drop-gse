//! Steam API binary backup, swap and restore.
//!
//! Originals are copied aside as `<name>.orig` before any replacement, and a
//! per-directory manifest (`.drop-gse-manifest.json`) records the SHA-256 of
//! each original. A backup is only reused or removed after its digest matches
//! the manifest — an unverified or stale backup is never trusted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::EngineError;
use crate::path_guard;

/// steam_api binaries we may replace, per platform.
pub const TARGET_BINARIES: &[&str] = &["steam_api.dll", "steam_api64.dll", "libsteam_api.so"];

/// Manifest file written next to the `.orig` backups.
pub const MANIFEST_FILE: &str = ".drop-gse-manifest.json";

#[derive(Debug, Serialize, Deserialize, Default)]
struct Manifest {
    entries: BTreeMap<String, String>,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_of(path: &Path) -> Result<String, EngineError> {
    let data = std::fs::read(path)?;
    Ok(to_hex(&Sha256::digest(&data)))
}

fn manifest_path(game_dir: &Path) -> Result<PathBuf, EngineError> {
    path_guard::safe_join(game_dir, MANIFEST_FILE)
}

fn load_manifest(game_dir: &Path) -> Result<Manifest, EngineError> {
    let path = manifest_path(game_dir)?;
    if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw).map_err(EngineError::Serialization)
    } else {
        Ok(Manifest::default())
    }
}

fn save_manifest(game_dir: &Path, manifest: &Manifest) -> Result<(), EngineError> {
    let raw = serde_json::to_string_pretty(manifest)?;
    path_guard::write_file(game_dir, MANIFEST_FILE, raw.as_bytes())
}

fn ensure_game_dir(game_dir: &Path) -> Result<(), EngineError> {
    match std::fs::metadata(game_dir) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(EngineError::GameDirNotFound(game_dir.display().to_string())),
        Err(e) => Err(EngineError::GameDirNotFound(format!(
            "{}: {e}",
            game_dir.display()
        ))),
    }
}

/// Outcome of backing up a single binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupState {
    /// A fresh backup was created, or an intact one already existed.
    BackedUp,
    /// The live binary is patched relative to its recorded original; the
    /// verified backup was left untouched.
    AlreadyPatched,
}

/// Per-binary result of [`backup_originals`].
#[derive(Debug, Default)]
pub struct BackupOutcome {
    pub states: BTreeMap<String, BackupState>,
}

impl BackupOutcome {
    pub fn state(&self, name: &str) -> Option<BackupState> {
        self.states.get(name).copied()
    }
}

/// Relative names currently tracked in the game's backup manifest. Used by
/// crash recovery so nested targets (e.g. `bin/x64/steam_api64.dll`) are
/// restored too, not just the default flat names.
pub fn tracked_binaries(game_dir: &Path) -> Result<Vec<String>, EngineError> {
    let manifest = load_manifest(game_dir)?;
    Ok(manifest.entries.keys().cloned().collect())
}

/// Back up `binaries` inside `game_dir` as `<name>.orig`.
pub fn backup_originals(game_dir: &Path, binaries: &[&str]) -> Result<BackupOutcome, EngineError> {
    ensure_game_dir(game_dir)?;
    let mut manifest = load_manifest(game_dir)?;
    let mut outcome = BackupOutcome::default();

    for name in binaries {
        let src = path_guard::safe_join(game_dir, name)?;
        if !std::fs::metadata(&src)
            .map(|m| m.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let dst_rel = format!("{name}.orig");
        let dst = path_guard::safe_join(game_dir, &dst_rel)?;
        let live_digest = sha256_of(&src)?;

        match manifest.entries.get(*name) {
            Some(recorded) => {
                let backup_digest = sha256_of(&dst).ok();
                if backup_digest.as_deref() == Some(recorded.as_str()) {
                    if live_digest == *recorded {
                        outcome
                            .states
                            .insert(name.to_string(), BackupState::BackedUp);
                    } else {
                        // Verified backup + modified live file: preserve original.
                        outcome
                            .states
                            .insert(name.to_string(), BackupState::AlreadyPatched);
                    }
                } else if live_digest == *recorded {
                    // The backup is missing/corrupt but the live binary is the
                    // recorded original, so refreshing the backup is safe.
                    path_guard::copy_to(game_dir, &src, &dst_rel)?;
                    manifest.entries.insert(name.to_string(), sha256_of(&dst)?);
                    outcome
                        .states
                        .insert(name.to_string(), BackupState::BackedUp);
                } else {
                    // Never re-back-up a modified live file over a missing or
                    // stale backup: that would record the patched bytes as the
                    // original and lose the real one irrecoverably.
                    return Err(EngineError::ManifestMismatch {
                        path: name.to_string(),
                        expected: recorded.clone(),
                        found: backup_digest.unwrap_or_else(|| "<backup missing>".to_string()),
                    });
                }
            }
            None => {
                path_guard::copy_to(game_dir, &src, &dst_rel)?;
                manifest.entries.insert(name.to_string(), sha256_of(&dst)?);
                outcome
                    .states
                    .insert(name.to_string(), BackupState::BackedUp);
            }
        }
    }

    save_manifest(game_dir, &manifest)?;
    Ok(outcome)
}

/// Restore `*.orig` backups created by [`backup_originals`] and remove them.
///
/// Phases: verify every tracked backup, copy them back, then remove each
/// backup and persist progress after each removal so an interruption resumes.
pub fn restore_originals(game_dir: &Path, binaries: &[&str]) -> Result<(), EngineError> {
    ensure_game_dir(game_dir)?;
    let mut manifest = load_manifest(game_dir)?;

    for name in binaries {
        let Some(recorded) = manifest.entries.get(*name) else {
            continue;
        };
        let src = path_guard::safe_join(game_dir, format!("{name}.orig"))?;
        let found = sha256_of(&src).map_err(|_| EngineError::ManifestMismatch {
            path: name.to_string(),
            expected: recorded.clone(),
            found: "<backup missing>".to_string(),
        })?;
        if found != *recorded {
            return Err(EngineError::ManifestMismatch {
                path: name.to_string(),
                expected: recorded.clone(),
                found,
            });
        }
    }

    for name in binaries {
        if !manifest.entries.contains_key(*name) {
            continue;
        }
        let src = path_guard::safe_join(game_dir, format!("{name}.orig"))?;
        path_guard::copy_to(game_dir, &src, name)?;
    }

    for name in binaries {
        if !manifest.entries.contains_key(*name) {
            continue;
        }
        path_guard::remove_file(game_dir, format!("{name}.orig"))?;
        manifest.entries.remove(*name);
        save_manifest(game_dir, &manifest)?;
    }

    // Remove an empty manifest once fully restored.
    let path = manifest_path(game_dir)?;
    if manifest.entries.is_empty() && path.exists() {
        path_guard::remove_file(game_dir, MANIFEST_FILE)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_restore_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();

        let outcome = backup_originals(dir, TARGET_BINARIES).unwrap();
        assert_eq!(
            outcome.state("steam_api64.dll"),
            Some(BackupState::BackedUp)
        );
        assert!(dir.join("steam_api64.dll.orig").exists());

        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        restore_originals(dir, TARGET_BINARIES).unwrap();

        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll")).unwrap(),
            b"original"
        );
        assert!(!dir.join("steam_api64.dll.orig").exists());
        assert!(!dir.join(MANIFEST_FILE).exists());
    }

    #[test]
    fn second_run_preserves_backup_of_patched_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(dir, &["steam_api64.dll"]).unwrap();

        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        let outcome = backup_originals(dir, &["steam_api64.dll"]).unwrap();
        assert_eq!(
            outcome.state("steam_api64.dll"),
            Some(BackupState::AlreadyPatched)
        );
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll.orig")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn tampered_backup_aborts_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(dir, &["steam_api64.dll"]).unwrap();
        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        std::fs::write(dir.join("steam_api64.dll.orig"), b"tampered").unwrap();

        let err = restore_originals(dir, &["steam_api64.dll"]).unwrap_err();
        assert!(matches!(err, EngineError::ManifestMismatch { .. }));
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll")).unwrap(),
            b"patched"
        );
    }

    #[test]
    fn stale_backup_is_not_replaced_with_patched_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(dir, &["steam_api64.dll"]).unwrap();
        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        std::fs::write(dir.join("steam_api64.dll.orig"), b"tampered").unwrap();

        let err = backup_originals(dir, &["steam_api64.dll"]).unwrap_err();
        assert!(matches!(err, EngineError::ManifestMismatch { .. }));
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll.orig")).unwrap(),
            b"tampered",
            "a stale backup must never be overwritten with patched bytes"
        );
    }

    #[test]
    fn missing_backup_is_recreated_only_from_the_recorded_original() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(dir, &["steam_api64.dll"]).unwrap();
        std::fs::remove_file(dir.join("steam_api64.dll.orig")).unwrap();

        // Live file still matches the recorded original: safe to refresh.
        let outcome = backup_originals(dir, &["steam_api64.dll"]).unwrap();
        assert_eq!(
            outcome.state("steam_api64.dll"),
            Some(BackupState::BackedUp)
        );
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll.orig")).unwrap(),
            b"original"
        );

        // Patched live file with the backup gone: refuse, keeping the patched
        // bytes out of the backup.
        std::fs::remove_file(dir.join("steam_api64.dll.orig")).unwrap();
        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        assert!(backup_originals(dir, &["steam_api64.dll"]).is_err());
        assert!(!dir.join("steam_api64.dll.orig").exists());
    }
}

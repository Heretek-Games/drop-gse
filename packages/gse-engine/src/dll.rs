//! DLL / shared-library backup, swap and restore.
//!
//! Backup convention: original binaries are copied aside with a `.orig`
//! suffix before any replacement, and a per-directory manifest
//! (`.drop-gse-manifest.json`) records the SHA-256 digest of each original.
//! Reuse, restoration and deletion of a backup are only performed after its
//! recorded digest matches — an unverified or stale backup is never trusted.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::EngineError;

/// steam_api binaries we may replace, per platform.
pub const TARGET_BINARIES: &[&str] = &["steam_api.dll", "steam_api64.dll", "libsteam_api.so"];

/// Manifest file written next to the `.orig` backups.
pub const MANIFEST_FILE: &str = ".drop-gse-manifest.json";

#[derive(Debug, Serialize, Deserialize, Default)]
struct Manifest {
    /// Relative binary name → SHA-256 of the backed-up `.orig` contents.
    entries: std::collections::BTreeMap<String, String>,
}

fn sha256_of(path: &Path) -> Result<String, EngineError> {
    let data = std::fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(&data)))
}

fn manifest_path(game_dir: &Path) -> std::path::PathBuf {
    game_dir.join(MANIFEST_FILE)
}

fn load_manifest(game_dir: &Path) -> Result<Manifest, EngineError> {
    let path = manifest_path(game_dir);
    if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw)
            .map_err(|e| EngineError::ScanFailed(format!("corrupt manifest: {e}")))
    } else {
        Ok(Manifest::default())
    }
}

fn save_manifest(game_dir: &Path, manifest: &Manifest) -> Result<(), EngineError> {
    let raw = serde_json::to_string_pretty(manifest)?;
    std::fs::write(manifest_path(game_dir), raw)?;
    Ok(())
}

/// Ensure `game_dir` exists and is accessible, failing closed otherwise.
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

/// Back up `binaries` inside `game_dir` as `<name>.orig`.
///
/// An existing `.orig` is reused only when the manifest digest still matches
/// both it and the live file; any other pre-existing `.orig` is treated as
/// stale and overwritten. Returns the names of binaries that have a valid
/// backup afterwards.
pub fn backup_originals(game_dir: &Path, binaries: &[&str]) -> Result<Vec<String>, EngineError> {
    ensure_game_dir(game_dir)?;
    let mut manifest = load_manifest(game_dir)?;
    let mut backed_up = Vec::new();
    for name in binaries {
        let src = game_dir.join(name);
        let dst = game_dir.join(format!("{name}.orig"));
        let meta = match std::fs::metadata(&src) {
            Ok(m) if m.is_file() => m,
            Ok(_) | Err(_) => continue, // target not present in this layout
        };
        let _ = meta;
        let live_digest = sha256_of(&src)?;

        let reusable = manifest.entries.get(*name).is_some_and(|recorded| {
            std::fs::metadata(&dst)
                .map(|m| m.is_file())
                .unwrap_or(false)
                && sha256_of(&dst).is_ok_and(|d| d == *recorded && d == live_digest)
        });

        if !reusable {
            std::fs::copy(&src, &dst)?;
            let backup_digest = sha256_of(&dst)?;
            manifest
                .entries
                .insert(name.to_string(), backup_digest);
        }
        backed_up.push(name.to_string());
    }
    save_manifest(game_dir, &manifest)?;
    Ok(backed_up)
}

/// Restore `*.orig` backups created by [`backup_originals`] and remove them.
///
/// Each backup's digest is verified against the manifest before anything is
/// touched; a mismatch aborts the whole restore without modifying files.
pub fn restore_originals(game_dir: &Path, binaries: &[&str]) -> Result<(), EngineError> {
    ensure_game_dir(game_dir)?;
    let manifest = load_manifest(game_dir)?;
    for name in binaries {
        let Some(recorded) = manifest.entries.get(*name) else {
            continue; // never backed up by us in this directory
        };
        let src = game_dir.join(format!("{name}.orig"));
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
    // All verified — safe to copy back and clean up.
    for name in binaries {
        if !manifest.entries.contains_key(*name) {
            continue;
        }
        let dst = game_dir.join(name);
        let src = game_dir.join(format!("{name}.orig"));
        std::fs::copy(&src, &dst)?;
        std::fs::remove_file(&src)?;
    }
    save_manifest(game_dir, &Manifest::default())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gse-dlltest-{tag}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn backup_restore_roundtrip() {
        let dir = tmpdir("roundtrip");
        fs::write(dir.join("steam_api64.dll"), b"original-bytes").unwrap();

        let backed = backup_originals(&dir, TARGET_BINARIES).unwrap();
        assert!(backed.contains(&"steam_api64.dll".to_string()));
        assert!(dir.join("steam_api64.dll.orig").exists());

        // Simulate patching.
        fs::write(dir.join("steam_api64.dll"), b"emulator-bytes").unwrap();

        restore_originals(&dir, TARGET_BINARIES).unwrap();
        assert_eq!(
            fs::read(dir.join("steam_api64.dll")).unwrap(),
            b"original-bytes"
        );
        assert!(!dir.join("steam_api64.dll.orig").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stale_backup_is_recreated_not_reused() {
        let dir = tmpdir("stale");
        fs::write(dir.join("steam_api.dll"), b"current-original").unwrap();
        // Plant a stale backup + stale manifest from an "older" run.
        fs::write(dir.join("steam_api.dll.orig"), b"ancient").unwrap();

        backup_originals(&dir, &["steam_api.dll"]).unwrap();
        assert_eq!(
            fs::read(dir.join("steam_api.dll.orig")).unwrap(),
            b"current-original",
            "stale backup must be replaced with the live original"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tampered_backup_aborts_restore() {
        let dir = tmpdir("tamper");
        fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(&dir, &["steam_api64.dll"]).unwrap();
        fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        // Corrupt the backup after backing up.
        fs::write(dir.join("steam_api64.dll.orig"), b"tampered").unwrap();

        let err = restore_originals(&dir, &["steam_api64.dll"]).unwrap_err();
        assert!(matches!(err, EngineError::ManifestMismatch { .. }));
        // Live file untouched by the aborted restore.
        assert_eq!(fs::read(dir.join("steam_api64.dll")).unwrap(), b"patched");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn inaccessible_directory_fails_closed() {
        let missing = std::env::temp_dir().join("gse-dlltest-missing-dir");
        assert!(matches!(
            backup_originals(&missing, TARGET_BINARIES),
            Err(EngineError::GameDirNotFound(_))
        ));
        assert!(matches!(
            restore_originals(&missing, TARGET_BINARIES),
            Err(EngineError::GameDirNotFound(_))
        ));
    }
}

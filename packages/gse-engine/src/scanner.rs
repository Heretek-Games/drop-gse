//! Locate Steam API binaries inside an installed game directory.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::dll::TARGET_BINARIES;
use crate::error::EngineError;

/// Maximum recursion depth when scanning for targets.
const MAX_DEPTH: usize = 4;

/// Extra target names beyond `TARGET_BINARIES` (Steam client loaders).
const EXTRA_TARGETS: &[&str] = &["steamclient.dll", "steamclient64.dll"];

fn is_target(name: &str) -> bool {
    let lower = name.to_lowercase();
    TARGET_BINARIES.contains(&lower.as_str()) || EXTRA_TARGETS.contains(&lower.as_str())
}

/// Find Steam API binaries under `game_dir`, returned as paths relative to it.
///
/// Fails closed: an unreadable `game_dir` is an error, not an empty result.
pub fn find_targets(game_dir: &Path) -> Result<Vec<PathBuf>, EngineError> {
    if !game_dir.is_dir() {
        return Err(EngineError::GameDirNotFound(game_dir.display().to_string()));
    }

    let mut found = Vec::new();
    for entry in WalkDir::new(game_dir)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry.map_err(|e| EngineError::ScanFailed(e.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if is_target(&name)
            && let Ok(rel) = entry.path().strip_prefix(game_dir)
        {
            found.push(rel.to_path_buf());
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_targets_nested_but_ignores_others() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir.join("bin/x64")).unwrap();
        std::fs::write(dir.join("steam_api64.dll"), b"x").unwrap();
        std::fs::write(dir.join("bin/x64/steamclient64.dll"), b"x").unwrap();
        std::fs::write(dir.join("bin/game.exe"), b"x").unwrap();

        let found = find_targets(dir).unwrap();
        assert_eq!(
            found,
            vec![
                PathBuf::from("bin/x64/steamclient64.dll"),
                PathBuf::from("steam_api64.dll"),
            ]
        );
    }

    #[test]
    fn missing_directory_fails_closed() {
        let missing = std::env::temp_dir().join("gse-engine-scanner-missing");
        assert!(matches!(
            find_targets(&missing),
            Err(EngineError::GameDirNotFound(_))
        ));
    }
}

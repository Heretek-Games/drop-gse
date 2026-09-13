//! Pre-flight anti-cheat detection.
//!
//! Refuses to patch a game directory when known anti-cheat payloads are
//! present: a modified `steam_api` binary is rejected by EAC/BattlEye and can
//! trip account bans. The scan is fail-closed — a traversal error aborts
//! rather than reporting a directory as clear.

use std::path::Path;

use crate::error::EngineError;

/// Well-known anti-cheat module filenames (case-insensitive match).
///
/// Covers Epic Online Services EAC, BattlEye, Riot Vanguard, PunkBuster and
/// nProtect/GameGuard. Unknown titles can still ship differently-named modules,
/// so this list is a safety net, not a guarantee.
pub const ANTICHEAT_MARKERS: &[&str] = &[
    "easyanticheat.exe",
    "easyanticheat_x64.dll",
    "easyanticheat_x86.dll",
    "easyanticheat.so",
    "easyanticheat.sys",
    "easyanticheat_eos.exe",
    "easyanticheat_eos.dll",
    "easyanticheat_eos_x64.dll",
    "beservice.exe",
    "beservice_x64.exe",
    "bedaisy.sys",
    "bedaisy64.sys",
    "battleye.dll",
    "battleye.sys",
    "battleye_x64.dll",
    "vgk.sys",
    "vgc.exe",
    "vgtray.exe",
    "pbsvc.exe",
    "pnkbstra.exe",
    "pnkbstrb.exe",
    "gamemon.des",
    "xigncode.exe",
    "npggsvc.exe",
];

/// Maximum recursion depth below `game_dir`.
const MAX_SCAN_DEPTH: usize = 4;

/// Recursively scan `game_dir` for anti-cheat markers.
///
/// Returns `Ok(Some(marker))` on detection, `Ok(None)` when clear, and `Err`
/// when the directory cannot be inspected.
pub fn detect(game_dir: &Path) -> Result<Option<String>, EngineError> {
    if !game_dir.is_dir() {
        return Err(EngineError::GameDirNotFound(game_dir.display().to_string()));
    }
    scan_dir(game_dir, 0)
}

fn scan_dir(dir: &Path, depth: usize) -> Result<Option<String>, EngineError> {
    // Fail closed: a tree deeper than the cap is reported as unscannable rather
    // than "clear", so a deeply nested anti-cheat module cannot be missed.
    if depth > MAX_SCAN_DEPTH {
        return Err(EngineError::ScanFailed(format!(
            "anti-cheat scan exceeded the maximum depth ({MAX_SCAN_DEPTH}) at {}",
            dir.display()
        )));
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| EngineError::ScanFailed(format!("{}: {e}", dir.display())))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| EngineError::ScanFailed(format!("{}: {e}", dir.display())))?;
        let name_lower = entry.file_name().to_string_lossy().to_lowercase();
        if ANTICHEAT_MARKERS.contains(&name_lower.as_str()) {
            return Ok(Some(name_lower));
        }
        if entry
            .file_type()
            .map_err(|e| EngineError::ScanFailed(e.to_string()))?
            .is_dir()
            && let Some(found) = scan_dir(&entry.path(), depth + 1)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_marker_nested_within_depth_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a/b/c");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("beservice.exe"), b"x").unwrap();
        assert_eq!(
            detect(tmp.path()).unwrap(),
            Some("beservice.exe".to_string())
        );
    }

    #[test]
    fn clear_directory_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("game.exe"), b"x").unwrap();
        assert_eq!(detect(tmp.path()).unwrap(), None);
    }

    #[test]
    fn depth_cap_fails_closed_instead_of_reporting_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let mut dir = tmp.path().to_path_buf();
        for _ in 0..(MAX_SCAN_DEPTH + 2) {
            dir.push("d");
        }
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("game.exe"), b"x").unwrap();

        assert!(matches!(
            detect(tmp.path()),
            Err(EngineError::ScanFailed(_))
        ));
    }

    #[test]
    fn missing_directory_is_error_not_clear() {
        let missing = std::env::temp_dir().join("gse-engine-missing-dir");
        assert!(matches!(
            detect(&missing),
            Err(EngineError::GameDirNotFound(_))
        ));
    }
}

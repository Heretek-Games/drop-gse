//! Pre-flight anti-cheat detection.
//!
//! Refuses to patch a game directory when known anti-cheat payloads are
//! present — modified `steam_api` binaries are rejected by EAC/BattlEye and
//! can trip account bans.

/// Well-known anti-cheat module filenames (case-insensitive match).
pub const ANTICHEAT_MARKERS: &[&str] = &[
    "easyanticheat.exe",
    "easyanticheat_x64.dll",
    "easyanticheat_x86.dll",
    "easyanticheat.so",
    "beservice.exe",
    "bedaisy.sys",
    "battleye.dll",
];

/// Returns the first detected anti-cheat marker in `game_dir`, if any.
///
/// TODO(phase-3): recursive scan with depth limit + allowlist of known-safe
/// directories; consult a per-game compatibility database from the server.
pub fn detect(game_dir: &std::path::Path) -> Option<String> {
    let entries = std::fs::read_dir(game_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_lowercase();
        if ANTICHEAT_MARKERS.contains(&name.as_str()) {
            return Some(name.to_string());
        }
    }
    None
}

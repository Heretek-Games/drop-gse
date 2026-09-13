//! Apply a [`PatchPlan`] to an installed game directory.

use std::path::Path;

use crate::error::EngineError;
use crate::path_guard;
use crate::{PatchPlan, anticheat, config::SteamSettings, dll, interfaces};

/// Result of a successful patch.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PatchReport {
    /// Target binaries replaced with the emulator payload.
    pub patched: Vec<String>,
    /// Target binaries whose original was backed up.
    pub backed_up: Vec<String>,
}

/// Patch `game_dir` using the emulator payload in `emulator_dir`.
///
/// Order: anti-cheat gate → backup originals → replace targets → write
/// `steam_settings/`. Any failure leaves verified `.orig` backups in place for
/// [`restore`].
pub fn apply_plan(
    plan: &PatchPlan,
    game_dir: &Path,
    emulator_dir: &Path,
) -> Result<PatchReport, EngineError> {
    if let Some(marker) = anticheat::detect(game_dir)? {
        return Err(EngineError::AntiCheatDetected(marker));
    }

    let targets: Vec<&str> = plan.targets.iter().map(String::as_str).collect();
    let outcome = dll::backup_originals(game_dir, &targets)?;

    let mut report = PatchReport::default();
    for name in &plan.targets {
        // The emulator payload is flat (one file per target name); the
        // destination preserves the target's relative path in the game dir.
        let Some(file_name) = Path::new(name).file_name() else {
            continue;
        };
        let src = emulator_dir.join(file_name);
        if !src.is_file() {
            continue;
        }
        path_guard::copy_to(game_dir, &src, name)?;
        report.patched.push(name.clone());
    }

    // Harvest interface names from the pre-patch (original) binaries.
    let mut interface_names = Vec::new();
    for name in &plan.targets {
        let original = path_guard::safe_join(game_dir, format!("{name}.orig"))?;
        let candidate = if original.is_file() {
            original
        } else {
            path_guard::safe_join(game_dir, name)?
        };
        if candidate.is_file() {
            interface_names.extend(interfaces::extract(&candidate)?);
        }
    }
    interface_names.sort();
    interface_names.dedup();

    let settings = SteamSettings {
        app_id: plan.app_id,
        custom_broadcasts: plan.broadcast_peers.clone(),
        interfaces: interface_names,
    };
    settings.write_to(game_dir, plan.flavor)?;

    for (name, state) in &outcome.states {
        if *state == dll::BackupState::BackedUp {
            report.backed_up.push(name.clone());
        }
    }

    Ok(report)
}

/// Restore originals and remove generated settings.
pub fn restore(game_dir: &Path, targets: &[String]) -> Result<(), EngineError> {
    let refs: Vec<&str> = targets.iter().map(String::as_str).collect();
    dll::restore_originals(game_dir, &refs)?;
    crate::config::restore_backups(game_dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EmulatorFlavor;

    fn setup() -> (tempfile::TempDir, tempfile::TempDir) {
        let game = tempfile::tempdir().unwrap();
        std::fs::write(game.path().join("steam_api64.dll"), b"original-valve").unwrap();

        let emulator = tempfile::tempdir().unwrap();
        std::fs::write(
            emulator.path().join("steam_api64.dll"),
            b"goldberg SteamUser021\0SteamNetworkingSockets012\0",
        )
        .unwrap();
        (game, emulator)
    }

    #[test]
    fn apply_then_restore_roundtrip() {
        let (game, emulator) = setup();
        let plan = PatchPlan {
            flavor: EmulatorFlavor::GbeFork,
            app_id: 480,
            targets: vec!["steam_api64.dll".to_string()],
            broadcast_peers: vec!["10.242.0.5".to_string()],
        };

        let report = apply_plan(&plan, game.path(), emulator.path()).unwrap();
        assert_eq!(report.patched, vec!["steam_api64.dll".to_string()]);
        assert_eq!(report.backed_up, vec!["steam_api64.dll".to_string()]);
        assert!(game.path().join("steam_api64.dll.orig").exists());
        assert!(
            game.path()
                .join("steam_settings/steam_interfaces.txt")
                .exists()
        );
        assert!(
            std::fs::read_to_string(game.path().join("steam_settings/custom_broadcasts.txt"))
                .unwrap()
                .contains("10.242.0.5:47584")
        );

        restore(game.path(), &plan.targets).unwrap();
        assert_eq!(
            std::fs::read(game.path().join("steam_api64.dll")).unwrap(),
            b"original-valve"
        );
        assert!(!game.path().join("steam_settings").exists());
    }

    #[test]
    fn refuses_to_patch_anti_cheat_games() {
        let (game, emulator) = setup();
        std::fs::write(game.path().join("EasyAntiCheat.exe"), b"x").unwrap();
        let plan = PatchPlan {
            flavor: EmulatorFlavor::GbeFork,
            app_id: 1,
            targets: vec!["steam_api64.dll".to_string()],
            broadcast_peers: vec![],
        };

        assert!(matches!(
            apply_plan(&plan, game.path(), emulator.path()),
            Err(EngineError::AntiCheatDetected(_))
        ));
        // Fail-closed: the live binary is untouched and no backup was written.
        assert_eq!(
            std::fs::read(game.path().join("steam_api64.dll")).unwrap(),
            b"original-valve"
        );
        assert!(!game.path().join("steam_api64.dll.orig").exists());
    }
}

use std::fs;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_gse-engine")
}

#[test]
fn scan_reports_targets_and_anticheat() {
    let game = tempfile::tempdir().unwrap();
    fs::create_dir_all(game.path().join("bin/x64")).unwrap();
    fs::write(game.path().join("steam_api64.dll"), b"x").unwrap();
    fs::write(game.path().join("bin/x64/steamclient64.dll"), b"x").unwrap();

    let output = Command::new(bin())
        .arg("scan")
        .arg(game.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let targets = json["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 2);
    assert!(json["antiCheat"].is_null());
}

#[test]
fn scan_fails_closed_for_a_missing_directory() {
    let output = Command::new(bin())
        .arg("scan")
        .arg("/nonexistent/gse-engine-test")
        .output()
        .unwrap();
    assert!(!output.status.success());
}

#[test]
fn patch_then_restore_roundtrip_through_the_cli() {
    let game = tempfile::tempdir().unwrap();
    fs::write(game.path().join("steam_api64.dll"), b"original-valve").unwrap();
    let emulator = tempfile::tempdir().unwrap();
    fs::write(
        emulator.path().join("steam_api64.dll"),
        b"goldberg SteamUser021\0SteamNetworkingSockets012\0",
    )
    .unwrap();

    let patch = Command::new(bin())
        .args(["patch", "--game-dir"])
        .arg(game.path())
        .args(["--emulator-dir"])
        .arg(emulator.path())
        .args(["--app-id", "12345", "--peers", "10.0.0.2,10.0.0.3"])
        .output()
        .unwrap();
    assert!(
        patch.status.success(),
        "{}",
        String::from_utf8_lossy(&patch.stderr)
    );

    let json: serde_json::Value = serde_json::from_slice(&patch.stdout).unwrap();
    assert_eq!(json["patched"][0], "steam_api64.dll");
    assert!(
        json["backedUp"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "steam_api64.dll")
    );

    let broadcasts =
        fs::read_to_string(game.path().join("steam_settings/custom_broadcasts.txt")).unwrap();
    assert!(broadcasts.contains("10.0.0.2:47584"));
    assert!(game.path().join("steam_api64.dll.orig").is_file());

    let restore_output = Command::new(bin())
        .args(["restore", "--game-dir"])
        .arg(game.path())
        .output()
        .unwrap();
    assert!(
        restore_output.status.success(),
        "{}",
        String::from_utf8_lossy(&restore_output.stderr)
    );
    assert_eq!(
        fs::read(game.path().join("steam_api64.dll")).unwrap(),
        b"original-valve"
    );
}

#[test]
fn version_reports_engine_and_package_version() {
    let output = Command::new(bin()).arg("version").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["engine"], "gse-engine");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn patch_with_optional_emulator_dir_and_restore_via_manifest() {
    let game = tempfile::tempdir().unwrap();
    fs::create_dir_all(game.path().join("bin/x64")).unwrap();
    fs::write(
        game.path().join("bin/x64/steam_api64.dll"),
        b"valve-x64-binary",
    )
    .unwrap();

    // Patch without specifying --emulator-dir (defaults to game_dir, backs up and writes config)
    let patch = Command::new(bin())
        .args(["patch", "--game-dir"])
        .arg(game.path())
        .args(["--app-id", "9999", "--peers", "10.0.0.5"])
        .output()
        .unwrap();
    assert!(
        patch.status.success(),
        "{}",
        String::from_utf8_lossy(&patch.stderr)
    );
    assert!(game.path().join("bin/x64/steam_api64.dll.orig").is_file());
    assert!(game.path().join(".drop-gse-manifest.json").is_file());

    // Restore without --targets flag should find targets from tracked manifest
    let restore_output = Command::new(bin())
        .args(["restore", "--game-dir"])
        .arg(game.path())
        .output()
        .unwrap();
    assert!(
        restore_output.status.success(),
        "{}",
        String::from_utf8_lossy(&restore_output.stderr)
    );

    let json: serde_json::Value = serde_json::from_slice(&restore_output.stdout).unwrap();
    let restored = json["restored"].as_array().unwrap();
    assert!(restored.iter().any(|v| v == "bin/x64/steam_api64.dll"));
    assert!(!game.path().join("bin/x64/steam_api64.dll.orig").exists());
    assert!(!game.path().join(".drop-gse-manifest.json").exists());
}

#[test]
fn patch_without_emulator_dir_does_not_cross_copy_root_dll_over_nested_targets() {
    let game = tempfile::tempdir().unwrap();
    fs::create_dir_all(game.path().join("bin/x64")).unwrap();
    fs::write(game.path().join("steam_api64.dll"), b"ROOT-ORIGINAL").unwrap();
    fs::write(
        game.path().join("bin/x64/steam_api64.dll"),
        b"NESTED-ORIGINAL",
    )
    .unwrap();

    let patch = Command::new(bin())
        .args(["patch", "--game-dir"])
        .arg(game.path())
        .args(["--app-id", "480", "--peers", "10.0.0.9"])
        .output()
        .unwrap();
    assert!(
        patch.status.success(),
        "{}",
        String::from_utf8_lossy(&patch.stderr)
    );

    let json: serde_json::Value = serde_json::from_slice(&patch.stdout).unwrap();
    let patched = json["patched"].as_array().unwrap();
    assert!(patched.is_empty(), "expected patched to be empty when no emulator-dir is provided, but got: {:?}", patched);

    assert_eq!(
        fs::read(game.path().join("bin/x64/steam_api64.dll")).unwrap(),
        b"NESTED-ORIGINAL",
        "nested target must not be overwritten by root DLL!"
    );
    assert_eq!(
        fs::read(game.path().join("steam_api64.dll")).unwrap(),
        b"ROOT-ORIGINAL"
    );
}


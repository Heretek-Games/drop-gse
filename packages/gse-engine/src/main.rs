//! `gse-engine` command-line interface.
//!
//! Ships the engine as a process that the Drop client addon can invoke as a
//! sidecar: `scan`, `patch`, `restore`, and `interfaces`. Each command prints a
//! single JSON object on success and a message on stderr with a non-zero exit
//! code on failure.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use gse_engine::{
    EmulatorFlavor, PatchPlan, anticheat, apply_plan, dll, interfaces, restore, scanner,
};

fn flag(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

fn list_flag(args: &[String], name: &str) -> Vec<String> {
    flag(args, name)
        .map(|value| {
            value
                .split(',')
                .map(|part| part.trim().to_string())
                .filter(|part| !part.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        eprintln!("usage: gse-engine <scan|patch|restore|interfaces|version> [options]");
        return ExitCode::from(2);
    };
    let rest = &args[1..];

    let result = match command.as_str() {
        "scan" => cmd_scan(rest),
        "patch" => cmd_patch(rest),
        "restore" => cmd_restore(rest),
        "interfaces" => cmd_interfaces(rest),
        "version" | "--version" | "-v" => cmd_version(),
        other => {
            eprintln!("unknown command '{other}'");
            return ExitCode::from(2);
        }
    };

    match result {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_version() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "engine": "gse-engine",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn cmd_scan(args: &[String]) -> Result<serde_json::Value, String> {
    let game_dir = args
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| "scan requires <game_dir>".to_string())?;
    let targets: Vec<String> = scanner::find_targets(&game_dir)
        .map_err(|error| error.to_string())?
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();
    let anti_cheat = anticheat::detect(&game_dir).map_err(|error| error.to_string())?;

    Ok(serde_json::json!({
        "gameDir": game_dir.to_string_lossy(),
        "targets": targets,
        "antiCheat": anti_cheat,
    }))
}

fn cmd_patch(args: &[String]) -> Result<serde_json::Value, String> {
    let game_dir = PathBuf::from(flag(args, "--game-dir").ok_or("--game-dir is required")?);
    let emulator_dir = flag(args, "--emulator-dir").map(PathBuf::from);
    let app_id: u32 = flag(args, "--app-id")
        .ok_or("--app-id is required")?
        .parse()
        .map_err(|_| "--app-id must be a positive integer".to_string())?;
    let flavor = match flag(args, "--flavor").as_deref() {
        Some("gse") => EmulatorFlavor::GseFork,
        _ => EmulatorFlavor::GbeFork,
    };

    let mut targets = list_flag(args, "--targets");
    if targets.is_empty() {
        targets = scanner::find_targets(&game_dir)
            .map_err(|error| error.to_string())?
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
    }
    if targets.is_empty() {
        return Err("no patch targets found; pass --targets".to_string());
    }

    let plan = PatchPlan {
        flavor,
        app_id,
        targets,
        broadcast_peers: list_flag(args, "--peers"),
    };
    let report =
        apply_plan(&plan, &game_dir, emulator_dir.as_deref()).map_err(|error| error.to_string())?;

    Ok(serde_json::json!({
        "patched": report.patched,
        "backedUp": report.backed_up,
    }))
}

fn cmd_restore(args: &[String]) -> Result<serde_json::Value, String> {
    let game_dir = PathBuf::from(flag(args, "--game-dir").ok_or("--game-dir is required")?);
    let mut targets = list_flag(args, "--targets");
    if targets.is_empty() {
        let mut all_targets = std::collections::BTreeSet::new();
        if let Ok(scanned) = scanner::find_targets(&game_dir) {
            for t in scanned {
                all_targets.insert(t.to_string_lossy().replace('\\', "/"));
            }
        }
        if let Ok(tracked) = dll::tracked_binaries(&game_dir) {
            for t in tracked {
                all_targets.insert(t.replace('\\', "/"));
            }
        }
        targets = all_targets.into_iter().collect();
    }
    restore(&game_dir, &targets).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "restored": targets }))
}

fn cmd_interfaces(args: &[String]) -> Result<serde_json::Value, String> {
    let binary = args
        .first()
        .map(String::as_str)
        .ok_or_else(|| "interfaces requires <binary>".to_string())?;
    let names = interfaces::extract(Path::new(binary)).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "interfaces": names }))
}

//! Extract Steam interface names from a binary.
//!
//! Goldberg-family emulators read `steam_interfaces.txt` for Source/Unreal
//! engine stability. Interface names are ASCII strings of the form
//! `Steam<Name><Version>` (e.g. `SteamUser021`, `SteamNetworkingSockets012`).

use std::collections::BTreeSet;
use std::path::Path;

use regex::Regex;
use std::sync::LazyLock;

use crate::error::EngineError;

/// Matches Steam interface identifiers embedded as printable ASCII.
static INTERFACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Steam[A-Z][A-Za-z0-9_]*[0-9]{3}").expect("valid regex"));

/// Extract unique interface names from a binary, sorted.
///
/// The scan is a plain ASCII pass; it is intentionally conservative and only
/// used to populate `steam_interfaces.txt`.
pub fn extract(binary: &Path) -> Result<Vec<String>, EngineError> {
    let bytes = std::fs::read(binary)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut names = BTreeSet::new();
    for mat in INTERFACE_RE.find_iter(&text) {
        names.insert(mat.as_str().to_string());
    }
    Ok(names.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_sorts_interface_names() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("steam_api64.dll");
        // Interface strings are typically NUL-separated in the binary.
        let mut data = Vec::new();
        data.extend_from_slice(b"SteamUser021\0");
        data.extend_from_slice(b"SteamNetworkingSockets012\0");
        data.extend_from_slice(b"not_an_interface\0");
        data.extend_from_slice(b"SteamUser021\0"); // duplicate
        std::fs::write(&path, &data).unwrap();

        let names = extract(&path).unwrap();
        assert_eq!(
            names,
            vec!["SteamNetworkingSockets012", "SteamUser021"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn returns_empty_for_clean_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("steam_api.dll");
        std::fs::write(&path, b"MZ\x00\x01no interfaces here").unwrap();
        assert!(extract(&path).unwrap().is_empty());
    }
}

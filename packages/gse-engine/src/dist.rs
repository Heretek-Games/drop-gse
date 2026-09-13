//! Emulator release staging with SHA-256 verification.
//!
//! Releases are fetched at runtime (never vendored). A staged release directory
//! carries a `release.json` manifest mapping each payload file to its SHA-256;
//! files are verified before being copied into a game directory.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::EmulatorFlavor;
use crate::error::EngineError;

/// Release manifest filename inside a staged release directory.
pub const RELEASE_MANIFEST: &str = "release.json";

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a file as lowercase hex.
pub fn sha256_file(path: &Path) -> Result<String, EngineError> {
    let data = std::fs::read(path)?;
    Ok(to_hex(&Sha256::digest(&data)))
}

/// Split a URL into `(scheme, host)`, both lowercased, ignoring userinfo and
/// port. Returns `None` for relative or malformed URLs. Deliberately does not
/// pull in a full URL parser.
fn split_url(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') {
        // Bracketed IPv6 literal (e.g. `[::1]:8080`).
        authority
            .split_once(']')
            .map_or(authority, |(inner, _)| inner.trim_start_matches('['))
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

/// Public accessor for a URL's `(scheme, host)` origin, used to keep release
/// payloads on the same origin as a trusted manifest.
pub fn url_origin(url: &str) -> Option<(String, String)> {
    split_url(url)
}

/// Whether a release manifest URL may be fetched.
///
/// Only `https` origins are trusted, except loopback hosts (development), which
/// may also use `http`. Non-loopback hosts must appear in `allowlist`; an empty
/// allowlist therefore rejects every remote manifest (fail closed).
pub fn is_trusted_manifest_url(url: &str, allowlist: &[&str]) -> bool {
    let Some((scheme, host)) = split_url(url) else {
        return false;
    };
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    if loopback {
        return scheme == "http" || scheme == "https";
    }
    if scheme != "https" {
        return false;
    }
    allowlist.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        !entry.is_empty() && entry == host
    })
}

/// Pinned release descriptor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseSpec {
    pub flavor: EmulatorFlavor,
    pub tag: String,
    /// Expected SHA-256 of each payload file, relative to the release dir.
    pub files: BTreeMap<String, String>,
}

/// Confine a release manifest key to a single file name (no directories, `..`
/// or absolute paths) so a crafted manifest cannot read/write elsewhere.
fn confined_release_name(name: &str) -> Result<PathBuf, EngineError> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(segment)), None) => Ok(PathBuf::from(segment)),
        _ => Err(EngineError::ScanFailed(format!(
            "invalid release file name: {name}"
        ))),
    }
}

/// Verify every payload file in `release_dir` against `spec`.
pub fn verify_release(release_dir: &Path, spec: &ReleaseSpec) -> Result<(), EngineError> {
    for (name, expected) in &spec.files {
        let path = release_dir.join(confined_release_name(name)?);
        let found = sha256_file(&path)?;
        if found != *expected {
            return Err(EngineError::ManifestMismatch {
                path: name.clone(),
                expected: expected.clone(),
                found,
            });
        }
    }
    Ok(())
}

/// Load a release manifest (`release.json`) from a staged directory.
pub fn load_spec(release_dir: &Path) -> Result<ReleaseSpec, EngineError> {
    let raw = std::fs::read_to_string(release_dir.join(RELEASE_MANIFEST))?;
    Ok(serde_json::from_str(&raw)?)
}

/// Verify `release_dir` and copy its payload files into `dest`.
pub fn stage_release(release_dir: &Path, dest: &Path) -> Result<(), EngineError> {
    let spec = load_spec(release_dir)?;
    verify_release(release_dir, &spec)?;
    std::fs::create_dir_all(dest)?;
    for name in spec.files.keys() {
        let file_name = confined_release_name(name)?;
        std::fs::copy(release_dir.join(name), dest.join(file_name))?;
    }
    Ok(())
}

/// Fetch, verify and write a release's payload files into `dest_dir`.
///
/// `fetch` is supplied by the caller (e.g. a reqwest-backed closure) so the
/// engine stays transport-agnostic. Each file must match its pinned SHA-256
/// before it is written; a mismatch aborts without writing it.
pub fn fetch_release<F>(spec: &ReleaseSpec, fetch: F, dest_dir: &Path) -> Result<(), EngineError>
where
    F: Fn(&str) -> Result<Vec<u8>, EngineError>,
{
    std::fs::create_dir_all(dest_dir)?;
    for (name, expected) in &spec.files {
        let bytes = fetch(name)?;
        let digest = to_hex(&Sha256::digest(&bytes));
        if digest != *expected {
            return Err(EngineError::ManifestMismatch {
                path: name.clone(),
                expected: expected.clone(),
                found: digest,
            });
        }
        let file_name = confined_release_name(name)?;
        std::fs::write(dest_dir.join(file_name), bytes)?;
    }
    Ok(())
}

/// Serialize a `EmulatorFlavor` for JSON.
impl Serialize for EmulatorFlavor {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            EmulatorFlavor::GbeFork => "gbe_fork",
            EmulatorFlavor::GseFork => "gse_fork",
        })
    }
}

impl<'de> Deserialize<'de> for EmulatorFlavor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "gbe_fork" => Ok(EmulatorFlavor::GbeFork),
            "gse_fork" => Ok(EmulatorFlavor::GseFork),
            other => Err(serde::de::Error::unknown_variant(
                other,
                &["gbe_fork", "gse_fork"],
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_release(dir: &Path, payload: &[(&str, &[u8])]) -> ReleaseSpec {
        let mut files = BTreeMap::new();
        for (name, bytes) in payload {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            files.insert((*name).to_string(), sha256_file(&path).unwrap());
        }
        let spec = ReleaseSpec {
            flavor: EmulatorFlavor::GbeFork,
            tag: "test".into(),
            files,
        };
        std::fs::write(
            dir.join(RELEASE_MANIFEST),
            serde_json::to_string_pretty(&spec).unwrap(),
        )
        .unwrap();
        spec
    }

    #[test]
    fn stages_verified_release() {
        let release = tempfile::tempdir().unwrap();
        write_release(release.path(), &[("steam_api64.dll", b"emulator")]);
        let dest = tempfile::tempdir().unwrap();

        stage_release(release.path(), dest.path()).unwrap();
        assert_eq!(
            std::fs::read(dest.path().join("steam_api64.dll")).unwrap(),
            b"emulator"
        );
    }

    #[test]
    fn fetch_release_downloads_and_verifies_payloads() {
        let mut files = BTreeMap::new();
        files.insert(
            "steam_api64.dll".to_string(),
            to_hex(&Sha256::digest(b"emulator")),
        );
        let spec = ReleaseSpec {
            flavor: EmulatorFlavor::GbeFork,
            tag: "v1".into(),
            files,
        };

        let dest = tempfile::tempdir().unwrap();
        fetch_release(
            &spec,
            |name| {
                assert_eq!(name, "steam_api64.dll");
                Ok(b"emulator".to_vec())
            },
            dest.path(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(dest.path().join("steam_api64.dll")).unwrap(),
            b"emulator"
        );

        // A payload whose digest does not match is refused.
        let mut bad_files = BTreeMap::new();
        bad_files.insert(
            "steam_api64.dll".to_string(),
            to_hex(&Sha256::digest(b"expected")),
        );
        let bad = ReleaseSpec {
            flavor: EmulatorFlavor::GbeFork,
            tag: "v1".into(),
            files: bad_files,
        };
        let dest2 = tempfile::tempdir().unwrap();
        assert!(matches!(
            fetch_release(&bad, |_| Ok(b"tampered".to_vec()), dest2.path()),
            Err(EngineError::ManifestMismatch { .. })
        ));
    }

    #[test]
    fn manifest_url_trust_is_fail_closed() {
        // Allow-listed HTTPS origin.
        assert!(is_trusted_manifest_url(
            "https://cdn.example.com/r/release.json",
            &["cdn.example.com"]
        ));
        // Loopback over http is allowed for local development.
        assert!(is_trusted_manifest_url(
            "http://localhost:8080/release.json",
            &[]
        ));
        assert!(is_trusted_manifest_url("http://127.0.0.1/r.json", &[]));
        assert!(is_trusted_manifest_url("http://[::1]:9000/r.json", &[]));
        // HTTPS but not allow-listed.
        assert!(!is_trusted_manifest_url(
            "https://evil.example.com/release.json",
            &["cdn.example.com"]
        ));
        // Remote plaintext is never trusted.
        assert!(!is_trusted_manifest_url(
            "http://cdn.example.com/release.json",
            &["cdn.example.com"]
        ));
        // Empty allowlist rejects every remote manifest.
        assert!(!is_trusted_manifest_url(
            "https://cdn.example.com/release.json",
            &[]
        ));
        // Userinfo/port are stripped; host match is case-insensitive.
        assert!(is_trusted_manifest_url(
            "https://user:pass@CDN.example.com:8443/r.json",
            &["cdn.example.com"]
        ));
        assert!(!is_trusted_manifest_url("not a url", &["cdn.example.com"]));
    }

    #[test]
    fn rejects_tampered_release() {
        let release = tempfile::tempdir().unwrap();
        write_release(release.path(), &[("steam_api64.dll", b"emulator")]);
        std::fs::write(release.path().join("steam_api64.dll"), b"tampered").unwrap();
        let dest = tempfile::tempdir().unwrap();

        assert!(matches!(
            stage_release(release.path(), dest.path()),
            Err(EngineError::ManifestMismatch { .. })
        ));
    }
}

use std::fmt;

/// Errors produced by the GSE engine.
#[derive(Debug)]
pub enum EngineError {
    /// The game directory does not exist or is not a directory.
    GameDirNotFound(String),
    /// The directory could not be scanned.
    ScanFailed(String),
    /// A `.orig` backup's digest does not match the recorded manifest entry.
    ManifestMismatch {
        path: String,
        expected: String,
        found: String,
    },
    /// No emulator payload was provided for a requested target binary.
    MissingEmulatorBinary(String),
    /// An anti-cheat payload was detected; patching is refused.
    AntiCheatDetected(String),
    /// A path escaped the game directory or traversed a symlink.
    UnsafePath(String),
    /// Filesystem failure.
    Io(std::io::Error),
    /// Manifest (de)serialization failure.
    Serialization(serde_json::Error),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::GameDirNotFound(path) => {
                write!(f, "game directory not found or not a directory: {path}")
            }
            EngineError::ScanFailed(detail) => write!(f, "scan failed: {detail}"),
            EngineError::ManifestMismatch {
                path,
                expected,
                found,
            } => write!(
                f,
                "backup digest mismatch for {path}: expected {expected}, found {found}"
            ),
            EngineError::MissingEmulatorBinary(name) => {
                write!(f, "emulator payload is missing target binary '{name}'")
            }
            EngineError::AntiCheatDetected(marker) => write!(
                f,
                "anti-cheat payload detected ({marker}); patching aborted for safety"
            ),
            EngineError::UnsafePath(detail) => write!(f, "unsafe path: {detail}"),
            EngineError::Io(err) => write!(f, "io error: {err}"),
            EngineError::Serialization(err) => write!(f, "manifest error: {err}"),
        }
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            EngineError::Io(err) => Some(err),
            EngineError::Serialization(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for EngineError {
    fn from(err: std::io::Error) -> Self {
        EngineError::Io(err)
    }
}

impl From<serde_json::Error> for EngineError {
    fn from(err: serde_json::Error) -> Self {
        EngineError::Serialization(err)
    }
}

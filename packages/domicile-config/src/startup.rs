//! Commands a desk runs at startup.
//!
//! These start session programs, such as a notification daemon, that a shell
//! page cannot start. Each runs like a launched application, with this desk's
//! `WAYLAND_DISPLAY`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ConfigError;

/// The commands a desk starts with.
///
/// Run once, when the compositor starts. A reload does not rerun them, which
/// would start duplicates, or stop them, which would kill programs in use.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct StartupConfig {
    /// Each an argv, run without a shell. For shell syntax, use
    /// `["sh", "-c", "…"]`.
    pub commands: Vec<Vec<String>>,
}

impl StartupConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if self.commands.iter().any(Vec::is_empty) {
            Err(ConfigError::Validation(
                "startup.commands holds an empty command, which names no program to run"
                    .to_string(),
            ))
        } else {
            Ok(())
        }
    }
}

//! The extensions installed in the engine's profile, which the Settings app
//! lists, enables, disables and configures.
//!
//! The same shape crosses three hops, as [`crate::media_devices`] does: the
//! engine's command socket, the control socket and `domicile-app-host`.

use serde::{Deserialize, Serialize};

/// An extension's chrome://extensions settings, as the config's
/// `extensions.settings` spells them. Absent where the extension cannot use
/// one; when configuring, absent where it stays as it is.
pub use domicile_protocol::{ExtensionSettings, SiteAccess, SiteAccessMode};

/// One installed extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The manifest's version, such as `1.0`.
    pub version: String,
    pub enabled: bool,
    /// The extension's options page, or none when it has no options page.
    pub options_url: Option<String>,
    /// Its settings, each one it can use.
    pub settings: ExtensionSettings,
    /// The file of its manifest icon closest to 128px, or none when its
    /// manifest names no icon. `domicile-app-host` sends the Settings app the
    /// image itself.
    #[serde(default)]
    pub icon_path: Option<String>,
}

//! The desk's browser profiles as the Settings app lists them: each profile's
//! extension switches, and the sites that open outside the default profile,
//! the config's and the ones the user pinned.
//!
//! The same shape crosses three hops, as [`crate::extensions`] does: the
//! engine's command socket, the control socket and `domicile-app-host`. See
//! `docs/architecture/BROWSER-PROFILES.md`.

use serde::{Deserialize, Serialize};

/// Every browser profile, and where each listed site opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserProfileList {
    pub default_profile: String,
    pub default_private_profile: String,
    pub profiles: Vec<ListedBrowserProfile>,
    pub sites: Vec<ListedBrowserSite>,
}

/// One browser profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedBrowserProfile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub private: bool,
    /// Every extension in the profile, switched on or off. Empty while the
    /// profile loads.
    pub extensions: Vec<ProfileExtension>,
}

/// One extension's switch in a profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileExtension {
    pub id: String,
    pub enabled: bool,
    /// The config switches it, so the user cannot.
    pub locked: bool,
}

/// A site that opens in a profile other than the default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedBrowserSite {
    pub site: String,
    pub profile: String,
    /// The user pinned it, from a browser window or Settings; otherwise the
    /// config lists it, and only the config changes it.
    pub pinned: bool,
}

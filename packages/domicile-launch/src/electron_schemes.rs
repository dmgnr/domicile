//! The apps' own schemes the engine registers as it starts, from the record
//! `electron-host` keeps of the schemes apps registered on earlier runs. See
//! "Requests" in `docs/architecture/ELECTRON-APPS.md`.
//!
//! Chromium registers schemes only as each process starts, so an app that
//! brings a new one runs on its own Electron until the next engine start.

use std::collections::BTreeMap;

use serde::Deserialize;

/// The record's file name in Domicile's state directory. Matches
/// `recordPath` in `packages/electron-host/src/main.ts`.
pub const RECORD: &str = "electron-schemes.json";

/// The engine switch the schemes go in.
const SWITCH: &str = "--domicile-electron-schemes=";

/// The privileges the engine grants, by Electron's names, in the order the
/// switch names them.
const GRANTED: [&str; 5] = [
    "standard",
    "secure",
    "bypassCSP",
    "corsEnabled",
    "supportFetchAPI",
];

/// Schemes the engine or the web gives a meaning. Matches
/// `IsElectronHandleableScheme` in
/// `components/domicile/common/electron_schemes.cc`, plus the schemes
/// Electron's Chromium already has.
const RESERVED: [&str; 22] = [
    "about",
    "blob",
    "chrome",
    "chrome-error",
    "chrome-extension",
    "chrome-native",
    "chrome-search",
    "chrome-untrusted",
    "data",
    "devtools",
    "domicile",
    "file",
    "filesystem",
    "googlechrome",
    "http",
    "https",
    "intent",
    "isolated-app",
    "javascript",
    "view-source",
    "ws",
    "wss",
];

#[derive(Deserialize)]
struct Kept {
    scheme: String,
    privileges: Vec<String>,
}

/// The engine switch registering every scheme in `record`, the text of the
/// record, or `None` when it names none. Two apps' copies of one scheme get
/// the privileges either asked for.
///
/// `electron-host` writes the record, so one it can't have written is
/// refused whole, as the engine refuses a wrong switch.
pub fn schemes_switch(record: &str) -> Result<Option<String>, String> {
    let apps: BTreeMap<String, Vec<Kept>> =
        serde_json::from_str(record).map_err(|why| why.to_string())?;
    let mut schemes: BTreeMap<String, Vec<&'static str>> = BTreeMap::new();
    for (app, kept) in &apps {
        for Kept { scheme, privileges } in kept {
            if !registrable(scheme) {
                return Err(format!("{app} keeps {scheme}:, which no app may register"));
            }
            let granted = schemes.entry(scheme.clone()).or_default();
            for privilege in privileges {
                let known = GRANTED
                    .iter()
                    .find(|known| **known == privilege)
                    .ok_or_else(|| {
                        format!(
                            "{app} keeps {privilege} for {scheme}:, which the engine doesn't grant"
                        )
                    })?;
                if !granted.contains(known) {
                    granted.push(known);
                }
            }
        }
    }
    if schemes.is_empty() {
        return Ok(None);
    }
    let entries: Vec<String> = schemes
        .into_iter()
        .map(|(scheme, granted)| {
            let ordered: Vec<&str> = GRANTED
                .into_iter()
                .filter(|privilege| granted.contains(privilege))
                .collect();
            format!("{scheme}:{}", ordered.join(","))
        })
        .collect();
    Ok(Some(format!("{SWITCH}{}", entries.join(";"))))
}

/// The schemes known apps register, by package name, as `electron-host`
/// records them: the engine registers these from its first start, so a known
/// app's first run is on the engine too. Taken from each app's own run.
pub const KNOWN: &str = r#"{
  "element-desktop": [
    { "scheme": "vector", "privileges": ["standard", "secure", "supportFetchAPI"] }
  ],
  "@ant/desktop": [
    { "scheme": "app", "privileges": ["standard", "secure", "supportFetchAPI"] },
    { "scheme": "claude-mcp-app", "privileges": ["standard", "secure"] },
    { "scheme": "claude-media", "privileges": ["standard", "secure", "bypassCSP"] },
    { "scheme": "claude-simulator", "privileges": ["standard", "secure", "bypassCSP", "corsEnabled", "supportFetchAPI"] },
    { "scheme": "cowork-artifact", "privileges": ["standard", "secure", "supportFetchAPI"] },
    { "scheme": "cowork-artifact-read", "privileges": ["standard", "secure", "corsEnabled", "supportFetchAPI"] },
    { "scheme": "cowork-file", "privileges": ["standard", "secure", "supportFetchAPI"] },
    { "scheme": "sentry-ipc", "privileges": ["secure", "bypassCSP", "corsEnabled", "supportFetchAPI"] }
  ],
  "openai-codex-electron": [
    { "scheme": "codex-sandbox", "privileges": ["standard", "secure", "corsEnabled", "supportFetchAPI"] }
  ],
  "slack-desktop": [
    { "scheme": "slack-webapp-dev", "privileges": ["standard", "secure", "bypassCSP", "corsEnabled", "supportFetchAPI"] }
  ]
}"#;

/// `record` with [`KNOWN`]'s schemes added, for [`schemes_switch`].
pub fn with_known(record: &str) -> Result<String, String> {
    type Record = BTreeMap<String, Vec<serde_json::Value>>;
    let mut apps: Record = serde_json::from_str(record).map_err(|why| why.to_string())?;
    let known: Record = serde_json::from_str(KNOWN).expect("the known schemes are a record");
    for (app, schemes) in known {
        apps.entry(app).or_default().extend(schemes);
    }
    serde_json::to_string(&apps).map_err(|why| why.to_string())
}

/// Whether the engine can register `scheme` for an app.
fn registrable(scheme: &str) -> bool {
    scheme.starts_with(|c: char| c.is_ascii_lowercase())
        && scheme
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+-.".contains(c))
        && !RESERVED.contains(&scheme)
}

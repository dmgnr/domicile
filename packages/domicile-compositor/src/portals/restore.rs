//! RemoteDesktop restore tokens: a grant the user made once, handed back
//! without a dialog.
//!
//! `persist_mode` 1 keeps a grant while the compositor runs; 2 keeps it in
//! `$XDG_STATE_HOME/domicile/remote-desktop.json` until the user deletes it.
//! Each token restores once, and the restored session gets a new one.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use domicile_protocol::Devices;
use serde_json::{json, Map, Value};

/// What a token restores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub app_id: String,
    pub devices: Devices,
    pub clipboard: bool,
}

/// The kept grants, by token.
pub struct Tokens {
    path: Option<PathBuf>,
    transient: HashMap<String, Grant>,
    saved: HashMap<String, Grant>,
}

/// Where grants kept until revoked live, from `XDG_STATE_HOME` and `HOME`.
/// `None` without either, and then they last as long as the compositor.
pub fn path(state_home: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    state_home
        .or_else(|| home.map(|home| home.join(".local/state")))
        .map(|state| state.join("domicile/remote-desktop.json"))
}

impl Tokens {
    /// The grants saved at `path`. A file that cannot be read is logged and
    /// read as none, so the user is asked again.
    pub fn load(path: Option<PathBuf>) -> Tokens {
        let saved = path.as_ref().map(read).unwrap_or_default();
        Tokens {
            path,
            transient: HashMap::new(),
            saved,
        }
    }

    /// Keep `grant` for `persist_mode`, and return its token. `None` for mode
    /// 0, which keeps nothing.
    pub fn keep(&mut self, grant: Grant, persist_mode: u32) -> Option<String> {
        let token = token();
        match persist_mode {
            0 => None,
            1 => {
                self.transient.insert(token.clone(), grant);
                Some(token)
            }
            _ => {
                self.saved.insert(token.clone(), grant);
                self.save();
                Some(token)
            }
        }
    }

    /// The grant `token` restores for `app_id`, once.
    pub fn take(&mut self, app_id: &str, token: &str) -> Option<Grant> {
        let ours = |grant: &Grant| grant.app_id == app_id;
        if self.transient.get(token).is_some_and(ours) {
            self.transient.remove(token)
        } else if self.saved.get(token).is_some_and(ours) {
            let taken = self.saved.remove(token);
            self.save();
            taken
        } else {
            None
        }
    }

    /// Write the saved grants. A failure is logged: the grants still last
    /// while the compositor runs.
    fn save(&self) {
        if let Some(path) = &self.path {
            if let Err(why) = write(path, &self.saved) {
                tracing::error!(%why, path = %path.display(), "could not save remote desktop grants");
            }
        }
    }
}

fn read(path: &PathBuf) -> HashMap<String, Grant> {
    let parsed = fs::read(path)
        .map_err(|why| why.to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<Map<String, Value>>(&bytes).map_err(|why| why.to_string())
        });
    match parsed {
        Ok(kept) => kept
            .into_iter()
            .filter_map(|(token, grant)| parsed_grant(grant).map(|grant| (token, grant)))
            .collect(),
        Err(why) => {
            if path.exists() {
                tracing::error!(%why, path = %path.display(), "remote desktop grants unreadable; asking again");
            }
            HashMap::new()
        }
    }
}

fn parsed_grant(value: Value) -> Option<Grant> {
    Some(Grant {
        app_id: value.get("app_id")?.as_str()?.to_owned(),
        devices: serde_json::from_value(value.get("devices")?.clone()).ok()?,
        clipboard: value.get("clipboard")?.as_bool()?,
    })
}

fn write(path: &PathBuf, saved: &HashMap<String, Grant>) -> io::Result<()> {
    let kept: Map<String, Value> = saved
        .iter()
        .map(|(token, grant)| {
            (
                token.clone(),
                json!({
                    "app_id": grant.app_id,
                    "devices": grant.devices,
                    "clipboard": grant.clipboard,
                }),
            )
        })
        .collect();
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }
    fs::write(path, serde_json::to_vec(&kept)?)
}

/// 128 random bits, as hex.
fn token() -> String {
    let mut bytes = [0u8; 16];
    // SAFETY: `getrandom` writes at most `bytes.len()` bytes into `bytes`,
    // which it borrows only for the call.
    let filled = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    assert_eq!(
        filled, 16,
        "the kernel gives 16 random bytes without blocking"
    );
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use domicile_protocol::Devices;

    fn grant(app_id: &str) -> Grant {
        Grant {
            app_id: app_id.into(),
            devices: Devices {
                keyboard: true,
                pointer: true,
                touchscreen: false,
            },
            clipboard: true,
        }
    }

    #[test]
    fn a_kept_grant_restores_once_for_its_own_application() {
        let mut tokens = Tokens::load(None);
        let token = tokens.keep(grant("org.example.App"), 1).expect("kept");

        assert_eq!(tokens.take("org.example.Other", &token), None);
        assert_eq!(
            tokens.take("org.example.App", &token),
            Some(grant("org.example.App"))
        );
        assert_eq!(tokens.take("org.example.App", &token), None, "once");
    }

    #[test]
    fn a_grant_not_to_persist_gets_no_token() {
        assert_eq!(Tokens::load(None).keep(grant("org.example.App"), 0), None);
    }

    #[test]
    fn a_grant_kept_until_revoked_outlives_the_compositor() {
        let state = tempfile::tempdir().expect("a directory");
        let path = state.path().join("domicile/remote-desktop.json");
        let token = Tokens::load(Some(path.clone()))
            .keep(grant("org.example.App"), 2)
            .expect("kept");
        let transient = Tokens::load(Some(path.clone()))
            .keep(grant("org.example.App"), 1)
            .expect("kept");

        let mut restarted = Tokens::load(Some(path.clone()));
        assert_eq!(restarted.take("org.example.App", &transient), None);
        assert_eq!(
            restarted.take("org.example.App", &token),
            Some(grant("org.example.App"))
        );
        assert_eq!(
            Tokens::load(Some(path)).take("org.example.App", &token),
            None,
            "taking it rewrote the file"
        );
    }

    #[test]
    fn the_file_lives_under_the_state_directory() {
        assert_eq!(
            path(Some("/state".into()), Some("/home/me".into())),
            Some(PathBuf::from("/state/domicile/remote-desktop.json"))
        );
        assert_eq!(
            path(None, Some("/home/me".into())),
            Some(PathBuf::from(
                "/home/me/.local/state/domicile/remote-desktop.json"
            ))
        );
        assert_eq!(path(None, None), None);
    }
}

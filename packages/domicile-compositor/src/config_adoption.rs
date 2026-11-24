//! Taking up a reloaded config, apart from its displays (see
//! `DomicileCompositor::adopt_the_desktop`). `crate::restatement` says what
//! changed.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::Instant;

use tracing::{debug, error, warn};

use domicile_config::{
    BrowserConfig, ExtensionsConfig, IdleConfig, KeyRepeat, KeyboardConfig, Keymap, LockConfig,
    Omit, ThemeMode,
};
use domicile_host::keymaps::Listed;
use domicile_host::Host;
use domicile_protocol::{KeymapChoice, Theme};

use crate::file_indexing::Heard;
use crate::idle::Idle;
use crate::keymap::{compiled_keymap, listed_keymaps};
use crate::portals::shell_appearance;
use crate::restatement::Restatement;
use crate::scale::output_scale;
use crate::{grepped, DomicileCompositor};
use crate::{pam, shell_config};

/// Convert a config theme to the protocol's.
///
/// Kept as two enums because `domicile-protocol` depends only on serde, like
/// `DisplayTransform` and `domicile_config::Transform`.
/// `packages/domicile-engine/tests/test-themes-agree.sh` keeps them in sync.
pub fn theme_on_the_wire(mode: ThemeMode) -> Theme {
    match mode {
        ThemeMode::Dark => Theme::Dark,
        ThemeMode::Light => Theme::Light,
    }
}

/// Give the host the config's `extensions`, for chromes that connect later.
///
/// Config paths came from JSON, so they are UTF-8 and `display` is lossless.
pub fn hand_over_the_extensions(host: &mut Host, extensions: &ExtensionsConfig) {
    host.set_extensions(
        extensions.web_store.clone(),
        extensions
            .unpacked
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        extensions
            .settings
            .iter()
            .map(|(id, settings)| (id.clone(), settings_on_the_wire(settings)))
            .collect(),
    );
}

/// Give the host the config's `browser`, for chromes that connect later.
pub fn hand_over_the_browser_profiles(host: &mut Host, browser: &BrowserConfig) {
    host.set_browser_profiles(
        browser
            .ordered_profiles()
            .map(|(id, profile)| domicile_protocol::BrowserProfile {
                id: id.clone(),
                name: profile.name.clone(),
                color: String::from(profile.color),
                private: profile.private,
                extensions: profile.extensions.clone(),
            })
            .collect(),
        browser.default_profile.clone(),
        browser.default_private_profile.clone(),
        browser.sites.clone(),
    );
}

/// One extension's config settings, as [`HostMessage::Extensions`] carries
/// them.
fn settings_on_the_wire(
    settings: &domicile_config::ExtensionSettings,
) -> domicile_protocol::ExtensionSettings {
    use domicile_config::{SiteAccess, SiteAccessMode};
    use domicile_protocol::SiteAccess as WireAccess;
    use domicile_protocol::SiteAccessMode as WireMode;
    domicile_protocol::ExtensionSettings {
        file_access: settings.file_access,
        user_scripts: settings.user_scripts,
        site_access: settings.site_access.as_ref().map(|access| match access {
            SiteAccess::Mode(SiteAccessMode::OnClick) => WireAccess::Mode(WireMode::OnClick),
            SiteAccess::Mode(SiteAccessMode::AllSites) => WireAccess::Mode(WireMode::AllSites),
            SiteAccess::Sites(sites) => WireAccess::Sites(sites.clone()),
        }),
    }
}

/// Give the host the resolved shell keybindings and the shell's options, for
/// chromes that connect later.
pub fn hand_over_the_shell_config(host: &mut Host, keys: BTreeMap<String, u32>, options: String) {
    host.set_shell_config(keys, options);
}

impl DomicileCompositor {
    /// Apply everything in a reloaded config except the display list.
    ///
    /// [`Restatement`] computes what changed beforehand, so an unrelated edit
    /// does not resend the keymap to every client. See
    /// [`adopt_the_desktop`](DomicileCompositor::adopt_the_desktop) for
    /// displays.
    pub fn adopt_the_rest_of_the_config(&mut self, restated: &Restatement) {
        if let Some(keyboard) = &restated.keyboard {
            self.take_up_the_keymaps(keyboard);
        }
        if let Some(repeat) = restated.key_repeat {
            self.repeat_keys_at(repeat);
        }
        // After the keyboard, whose layout chords are resolved on.
        if restated.shell_config {
            self.rebind_the_keys();
        }
        if restated.input_devices {
            if let Some(session) = &self.engine {
                session.configure_input(&self.config.current().input);
            }
        }
        if restated.pointers {
            self.bind_the_pointers();
        }
        if let Some(max_scale) = restated.max_scale {
            self.cap_the_scale_at(max_scale);
        }
        if let Some(idle) = &restated.idle {
            self.reset_the_idle_clock(idle);
        }
        if let Some(apps) = &restated.electron_apps {
            match &self.electron_entries {
                Some(out) => crate::electron_apps::write_the_electron_entries(out, apps),
                None => debug!("no --electron-entries, so `electron.apps` changes nothing"),
            }
        }
        if let Some(omit) = &restated.omit {
            self.omit_from_the_index(omit);
        }
        if let Some(extensions) = &restated.extensions {
            // Store then broadcast, so the next chrome to connect gets the new
            // list.
            let told = {
                let mut host = self.hub.host.lock().unwrap();
                hand_over_the_extensions(&mut host, extensions);
                host.describe_extensions()
            };
            self.hub.broadcast(
                told.expect("a host that has just been given extensions has them to state"),
            );
        }
        if let Some(browser) = &restated.browser {
            // Store then broadcast, like the extensions.
            let told = {
                let mut host = self.hub.host.lock().unwrap();
                hand_over_the_browser_profiles(&mut host, browser);
                host.describe_browser_profiles()
            };
            self.hub.broadcast(
                told.expect("a host that has just been given profiles has them to state"),
            );
        }
        if let Some(sites) = &restated.force_dark {
            // Store then broadcast, like the extensions.
            let told = {
                let mut host = self.hub.host.lock().unwrap();
                host.set_force_dark(sites.clone());
                host.describe_force_dark()
            };
            self.hub.broadcast(told);
        }
        if let Some(spellcheck) = &restated.spellcheck {
            // Store then broadcast, like the extensions.
            let told = {
                let mut host = self.hub.host.lock().unwrap();
                host.set_spellcheck(spellcheck.enabled, spellcheck.languages.clone());
                host.describe_spellcheck()
            };
            self.hub.broadcast(
                told.expect("a host that has just been told how to check spelling has it to state"),
            );
        }
        if let Some(agents) = &restated.agents {
            self.web_agents.set(agents.web);
        }
        if let Some(lockdown) = &restated.lockdown {
            self.hub.portals.lock_down(lockdown.clone());
        }
        if let Some(lock) = &restated.lock {
            self.rekey_the_lock(lock);
        }
        if let Some(theme) = restated.theme {
            // The config overrides the shell's toggle. The toggle writes
            // nothing back because the config is generated, so a `theme` edit
            // is the source of truth.
            self.hub.take_up_the_theme(theme_on_the_wire(theme));
        }
        if let Some(theme) = &restated.appearance {
            self.hub.portals.restyle(theme);
            if let Some(tray) = self.hub.tray.get() {
                tray.retheme(theme.icon_theme.clone());
            }
            if let Some(server) = self.hub.notifications.get() {
                server.retheme(theme.icon_theme.clone());
            }
            // Release the host before broadcasting.
            let told = self
                .hub
                .host
                .lock()
                .unwrap()
                .set_appearance(shell_appearance(theme));
            if let Some(message) = told {
                self.hub.broadcast(message);
            }
        }
    }

    /// Take up a reloaded keyboard's keymaps, staying on the active keymap
    /// when the config still names it and going to the first when not.
    ///
    /// Every keymap must compile, or none is taken up and the desktop keeps
    /// typing on the keymap it has. At startup the same failure is fatal so
    /// the desktop never runs on xkb's fallback.
    pub fn take_up_the_keymaps(&mut self, keyboard: &KeyboardConfig) {
        let keymaps = keyboard.keymaps();
        let compiled: Result<Vec<String>, _> = keymaps.iter().map(compiled_keymap).collect();
        let Ok(compiled) = compiled.map_err(|why| error!(%why, "{}", grepped::KEYMAP_REFUSED))
        else {
            return;
        };
        let active = self.active_keymap_name();
        let at = keymaps
            .iter()
            .position(|keymap| keymap.name == active)
            .unwrap_or(0);
        self.hub.keymaps.list(Listed {
            keymaps: listed_keymaps(&keymaps),
            active: keymaps[at].name.clone(),
        });
        self.retype_the_desktop(&keymaps[at], compiled[at].clone());
    }

    /// Tell every client's keyboard how held keys repeat. The engine hears it
    /// with the input settings.
    pub fn repeat_keys_at(&mut self, repeat: KeyRepeat) {
        self.seat
            .get_keyboard()
            .expect("the seat has a keyboard from startup")
            .change_repeat_info(repeat.rate.into(), repeat.delay_ms.into());
    }

    /// Switch every keyboard to the keymap `choice` picks, until the desktop
    /// restarts.
    ///
    /// Retypes the desktop and the shell's keybindings, then tells the pages
    /// listening. Switching to the active keymap does nothing.
    pub fn switch_the_keymap(&mut self, choice: &KeymapChoice) {
        let listed = self
            .hub
            .keymaps
            .listed()
            .expect("the keymaps are listed at startup");
        let Some(name) = listed.chosen(choice) else {
            // The connection checked it, so a reload dropped it since.
            debug!(?choice, "keymap: a keymap the config no longer has");
            return;
        };
        if name == listed.active {
            return;
        }
        let keymap = self.keymap_named(&name);
        match compiled_keymap(&keymap) {
            Err(why) => error!(%why, "{}", grepped::KEYMAP_REFUSED),
            Ok(compiled) => {
                self.hub.keymaps.list(Listed {
                    keymaps: listed.keymaps,
                    active: name,
                });
                self.retype_the_desktop(&keymap, compiled);
                self.rebind_the_keys();
            }
        }
    }

    /// The name of the keymap the desktop types on.
    fn active_keymap_name(&self) -> String {
        self.hub
            .keymaps
            .listed()
            .expect("the keymaps are listed at startup")
            .active
    }

    /// The live config's keymap named `name`.
    fn keymap_named(&self, name: &str) -> Keymap {
        self.config
            .current()
            .input
            .keyboard
            .keymaps()
            .into_iter()
            .find(|keymap| keymap.name == name)
            .expect("the listed keymaps are the live config's")
    }

    /// Send `keymap`, compiled as `compiled`, to every consumer.
    ///
    /// One compilation feeds the seat (each client's `wl_keyboard.keymap`), the
    /// browser process (over the chrome socket), and later chromes (stored
    /// copy). See [`crate::keymap`].
    fn retype_the_desktop(&mut self, keymap: &Keymap, compiled: String) {
        debug!(
            keymap = %keymap.name,
            layout = %keymap.xkb_layout,
            variant = %keymap.xkb_variant,
            "the desktop types on the keymap the config names"
        );
        // The seat first: Smithay writes the keymap and sends the new
        // fd to each bound `wl_keyboard`.
        //
        // From the text, not `XkbConfig`, so the seat and the chrome
        // get the same bytes from one compilation.
        let typing = self
            .seat
            .get_keyboard()
            .expect("the seat was given a keyboard at startup");
        typing
            .set_keymap_from_string(self, compiled.clone())
            .expect("xkb reads back the keymap text it has just written");
        // Then the browser process. Store then broadcast, so the next
        // chrome to connect gets the new keymap.
        let told = {
            let mut host = self.hub.host.lock().unwrap();
            host.set_keymap(compiled);
            host.describe_keymap()
        };
        self.hub
            .broadcast(told.expect("a host that has just been given a keymap has one to state"));
    }

    /// Resolve the config's keybindings on the active keymap and send them and
    /// the shell's options to every chrome.
    ///
    /// A keymap that does not compile is refused and logged, not fatal, as in
    /// [`take_up_the_keymaps`]. The host keeps the last good keys for new
    /// chromes.
    ///
    /// [`take_up_the_keymaps`]: DomicileCompositor::take_up_the_keymaps
    pub fn rebind_the_keys(&mut self) {
        match shell_config::keys(&self.keymap_named(&self.active_keymap_name())) {
            Err(why) => error!(%why, "{}", grepped::KEYS_REFUSED),
            Ok(resolved) => {
                // Store then broadcast, as in `retype_the_desktop`.
                let told = {
                    let mut host = self.hub.host.lock().unwrap();
                    hand_over_the_shell_config(
                        &mut host,
                        resolved,
                        shell_config::options(self.config.current()),
                    );
                    host.describe_shell_config()
                };
                self.hub.broadcast(
                    told.expect("a host that has just been given keys has them to state"),
                );
            }
        }
    }

    /// Apply a new `output.max_scale`.
    ///
    /// Updates the hub's copy, which bounds future chrome densities, and
    /// re-applies the cap to the current desktop using the chrome's last
    /// reported ratio.
    ///
    /// [`set_output`](DomicileCompositor::set_output) skips unchanged outputs,
    /// and a described desktop refuses this (see
    /// [`set_output_scale`](DomicileCompositor::set_output_scale)).
    pub fn cap_the_scale_at(&mut self, max_scale: u32) {
        self.hub.max_scale.store(max_scale, Ordering::Relaxed);
        self.set_output_scale(output_scale(self.device_pixel_ratio, max_scale));
    }

    /// Apply new `idle` timeouts.
    ///
    /// The clock restarts from now, for blanking, locking and the shell's idle
    /// watches alike.
    ///
    /// A dark desktop is woken. The new clock starts awake ([`Idle::after`]),
    /// so it can never report [`Blanking::ComeBack`] for screens the old clock
    /// turned off. Relight them now; the desktop blanks again after the new
    /// timeout.
    pub fn reset_the_idle_clock(&mut self, idle: &IdleConfig) {
        let was_dark = self.the_screens_are_dark();
        // Keep client inhibitors; see [`Idle::takes_over_from`].
        self.idle = Idle::after(idle, Instant::now()).takes_over_from(&mut self.idle);
        debug!("the idle clock starts over from the reloaded timeouts");
        // Not fatal on reload, unlike at startup: the desktop just stops
        // blanking and locking on its own. Logged so it is not silent.
        if let Err(why) = self.arm_the_idle_clock() {
            error!(
                %why,
                "no clock for the reloaded idle timeouts, so this desktop will not \
                 blank or lock on its own until it is restarted"
            );
        }
        // The new clock starts from now, and may blank at another time.
        self.settle_the_idle_watches();
        self.tell_the_shells_what_holds_the_desktop_awake();
        if was_dark {
            debug!("the idle timeout changed while the screens were off; they come back on");
            // Tell the shells. They were told the desktop is idle, and the
            // clock that would announce waking is gone. A shell would otherwise
            // stay in its idle state over a lit desktop. Unguarded, so this
            // works even if the timeout was removed.
            self.tell_the_chromes_whether_anybody_is_here();
            self.state_the_connectors();
        }
    }

    /// Apply a new `files.omit`.
    ///
    /// The index thread re-walks the home, which both drops newly omitted paths
    /// and finds newly included ones. The launcher keeps its results until
    /// then.
    pub fn omit_from_the_index(&self, omit: &Omit) {
        match &self.index {
            Some(index) => {
                if index.send(Heard::Omitting(omit.clone())).is_err() {
                    // The thread has exited, after logging why (unreadable
                    // home, or a watch failed to start).
                    warn!(
                        "the file index is no longer kept, so `files.omit` \
                         reaches it at the next start"
                    );
                }
            }
            None => debug!("no home is indexed, so `files.omit` has nothing to change"),
        }
    }

    /// Apply a new `lock`. See [`Lock::rekeyed`].
    ///
    /// PAM that startup would refuse keeps the current verifier.
    pub fn rekey_the_lock(&mut self, lock: &LockConfig) {
        match pam::for_the_desk(lock.service(), &self.pam_confdir) {
            Err(why) => error!(%why, "the reloaded lock cannot be used; the current one stays"),
            Ok(verifier) => {
                self.lock.rekeyed(Box::new(verifier));
                debug!("taking up a reloaded lock");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use domicile_config::{SiteAccess, SiteAccessMode};
    use domicile_protocol::{ExtensionSettings, HostMessage};

    use super::hand_over_the_extensions;

    const DARK_READER: &str = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
    const TAMPERMONKEY: &str = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

    #[test]
    fn the_configs_extensions_go_to_the_host() {
        let mut host = domicile_host::Host::new();
        hand_over_the_extensions(
            &mut host,
            &domicile_config::ExtensionsConfig {
                web_store: vec![DARK_READER.to_string(), TAMPERMONKEY.to_string()],
                unpacked: vec![std::path::PathBuf::from("/home/u/my-extension")],
                settings: [
                    (
                        DARK_READER.to_string(),
                        domicile_config::ExtensionSettings {
                            file_access: Some(true),
                            site_access: Some(SiteAccess::Sites(vec!["github.com".into()])),
                            ..Default::default()
                        },
                    ),
                    (
                        TAMPERMONKEY.to_string(),
                        domicile_config::ExtensionSettings {
                            file_access: Some(false),
                            user_scripts: Some(true),
                            site_access: Some(SiteAccess::Mode(SiteAccessMode::OnClick)),
                        },
                    ),
                ]
                .into(),
            },
        );
        assert_eq!(
            host.describe_extensions(),
            Some(HostMessage::Extensions {
                web_store: vec![DARK_READER.to_string(), TAMPERMONKEY.to_string()],
                unpacked: vec!["/home/u/my-extension".to_string()],
                settings: [
                    (
                        DARK_READER.to_string(),
                        ExtensionSettings {
                            file_access: Some(true),
                            site_access: Some(domicile_protocol::SiteAccess::Sites(vec![
                                "github.com".into()
                            ])),
                            ..Default::default()
                        },
                    ),
                    (
                        TAMPERMONKEY.to_string(),
                        ExtensionSettings {
                            file_access: Some(false),
                            user_scripts: Some(true),
                            site_access: Some(domicile_protocol::SiteAccess::Mode(
                                domicile_protocol::SiteAccessMode::OnClick
                            )),
                        },
                    ),
                ]
                .into(),
            })
        );
    }
}

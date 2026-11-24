//! The logic behind the `domicile` binary and the compositor's command line.
//!
//! - `domicile <shell>`: parse the command line ([`cli`]), resolve the shell
//!   ([`shell_path`]), config ([`config_path`]), profile ([`profile_path`],
//!   [`profile_claim`]), platform ([`platform`]) and components
//!   ([`components`]), then start ([`spawn`]), order ([`supervise`]) and
//!   restart ([`restart`]) them. A slow first build of the shell runs behind
//!   the [`splash`]. The engine loads each shell through [`serving`].
//! - `domicile which-shell`: query a running desktop ([`control`],
//!   [`control_socket`]).
//! - `domicile open`: a file, folder or link, opened with what opens its type
//!   ([`open`]). Web links go to the engine ([`command`], [`command_socket`],
//!   [`address`]), as does `load-shell`.
//! - `domicile open --app`: a site or an app module ([`app_entry`]),
//!   forwarded to the engine like `load-shell`.
//! - `domicile screenshot`: forwarded to the compositor
//!   ([`compositor_socket`]).
//! - `domicile monitor`: a virtual monitor the compositor keeps while the
//!   command runs, lent over the control socket ([`monitor_lending`]).
//! - `domicile power-off`, `domicile reboot` and `domicile log-out`: asked in
//!   the desktop's Access dialog ([`power`]).
//! - `domicile install-app`: reads a site's web app manifest ([`web_app`],
//!   [`web_address`]) and writes a desktop entry ([`desktop_entry`],
//!   [`install_app`]).
//! - `domicile uninstall-app`: removes that entry and its icon
//!   ([`uninstall_app`]).
//! - `domicile mcp`: a Model Context Protocol server that runs the other
//!   verbs for an agent ([`mcp`]).
//! - `domicile accessibility`: a native window's AT-SPI tree, and acting on
//!   its elements ([`accessibility`]).
//! - Failed runs report the compositor's last output ([`heard`]).
//! - The components' stderr goes to the journal as entries with priorities
//!   ([`component_log`], [`engine_log`], [`journal`]), or to stderr as said.
//! - The compositor's side: its command line ([`arguments`]), the session
//!   document it publishes ([`session`]), and whether a page connected
//!   ([`handshake`]).
//!
//! This lives in a library so it can be tested without a GPU or a display. See
//! `docs/architecture/THE-DOMICILE-BINARY.md`.

pub mod accessibility;
pub mod address;
pub mod agent_lending;
pub mod app_entry;
pub mod app_host;
pub mod arguments;
pub mod browser_profiles;
pub mod build_progress;
pub mod cli;
pub mod command;
pub mod command_socket;
pub mod commands;
pub mod component_log;
pub mod components;
pub mod compositor_socket;
pub mod config_check;
pub mod config_path;
pub mod config_watch;
pub mod control;
pub mod control_socket;
pub mod desktop_entry;
pub mod dev;
pub mod electron_app;
pub mod electron_schemes;
pub mod electron_wrapper;
pub mod email;
pub mod engine_log;
pub mod engine_log_levels;
pub mod extensions;
pub mod folder_chooser;
pub mod graphical_session;
pub mod handshake;
pub mod heard;
pub mod help;
pub mod history;
pub mod idle_inhibit;
pub mod install_app;
pub mod journal;
pub mod launcher_log;
pub mod listing;
pub mod log_export;
pub mod log_levels;
pub mod man;
pub mod mcp;
pub mod media_devices;
pub mod milestones;
pub mod monitor_lending;
pub mod notification;
pub mod open;
pub mod paint;
pub mod platform;
pub mod power;
pub mod profile_claim;
pub mod profile_path;
pub mod recent_log;
pub mod redact;
pub mod restart;
pub mod serving;
pub mod session;
mod shell_manifest;
mod shell_options;
pub mod shell_path;
pub mod shell_source;
pub mod site_data;
pub mod site_permissions;
pub mod software_compositing;
pub mod spawn;
pub mod splash;
pub mod startup;
pub mod subscription;
pub mod supervise;
pub mod trace;
pub mod uninstall_app;
pub mod version;
pub mod web_address;
pub mod web_app;

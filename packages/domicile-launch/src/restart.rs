//! Restarts failed components with backoff.
//!
//! - An engine that dies is restarted under the running compositor
//!   ([`keep_the_parts_up`]). Wayland clients keep their windows. On a TTY
//!   the screen is dark between engines.
//! - A compositor that dies is restarted under the running engine
//!   ([`keep_the_parts_up`]). Apps lose their Wayland display; browser
//!   windows and the shell stay, and the shell's control channel dials the
//!   new compositor.
//! - A part that keeps failing ends its desktop, and a new desktop starts
//!   ([`keep_a_desktop_up`]).
//! - An engine that finds no usable GPU soon after it starts
//!   ([`renderer_unavailable`]) ends the run. Chromium has already tried every
//!   GPU mode, and a new engine would try them again on the same card.
//!
//! The engine, the compositor and the desktop share [`Policy`] but count
//! failures separately, so a crashing engine does not use up the compositor's
//! or the desktop's restarts. Startup checks in `bin/domicile.rs` are not
//! retried; they give the same answer each time.
//!
//! See "Crashes are recovered" in `docs/architecture/THE-DOMICILE-BINARY.md`.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::spawn::Runtime;
use crate::supervise::Exit;

/// Backoff and give-up limits for restarts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Wait after the first failure in a row.
    pub first_wait: Duration,
    /// Maximum wait between attempts.
    pub longest_wait: Duration,
    /// Consecutive failures that end the run.
    pub give_up_after: u32,
    /// Uptime after which a failure resets the count.
    pub long_enough: Duration,
}

impl Default for Policy {
    /// Four restarts over about 15 seconds, then stop.
    ///
    /// A 1 s first wait keeps a component that crashes on startup from
    /// spinning a core; startup takes longer than that anyway. Faults that
    /// survive several restarts won't be fixed by more, and stopping soon hands
    /// the tty back while someone is watching.
    fn default() -> Self {
        Policy {
            first_wait: Duration::from_secs(1),
            longest_wait: Duration::from_secs(8),
            give_up_after: 5,
            long_enough: Duration::from_secs(60),
        }
    }
}

/// The [`Exit`] status text for a clean exit.
///
/// A string because [`Exit`] stores the status as displayed, which tells
/// signals apart from exit codes.
pub const CLEANLY: &str = "exit status: 0";

/// The [`Exit`] status text for an engine that found no usable GPU process,
/// in any mode, the CPU included. Patch 0178 exits 69 (`EX_UNAVAILABLE`)
/// where Chromium crashes with "GPU process isn't usable".
pub const NO_USABLE_GPU: &str = "exit status: 69";

/// Whether `exit` is an engine that cannot draw at all: a renderer
/// unavailable, which ends the run instead of restarting.
///
/// An engine that ran for [`Policy::long_enough`] drew on its card, and lost
/// its GPU modes to a cluster of crashes. A new engine starts on the GPU
/// again, so that exit restarts like any other failure.
pub fn renderer_unavailable(exit: &Exit, lived: Duration, policy: &Policy) -> bool {
    exit.what == "engine" && exit.how == NO_USABLE_GPU && lived < policy.long_enough
}

/// Which part an exit restarts under the part still serving, or `None` when
/// it ends the desktop.
///
/// - An engine or compositor that fails is restarted.
/// - A compositor that exits 0 ends the run.
/// - An engine that exits 0 is restarted only on `drm`. There is no window to
///   close there, so any exit is a death, and Chromium exits 0 on `SIGTERM`.
///   Elsewhere a clean exit is the window being closed, which ends the run.
pub fn restarts(exit: &Exit, platform: &str) -> Option<Started> {
    match exit.what {
        "engine" if exit.how != CLEANLY || platform == "drm" => Some(Started::Engine),
        "compositor" if exit.how != CLEANLY => Some(Started::Compositor),
        _ => None,
    }
}

/// What is being restarted, for the message the user sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Started {
    Desktop,
    Engine,
    Compositor,
}

impl std::fmt::Display for Started {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Started::Desktop => "desktop",
            Started::Engine => "engine",
            Started::Compositor => "compositor",
        })
    }
}

/// What happens after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Next {
    #[error(
        "starting the {started} again in {after:?} — that is failure {failures} of {of} in a row."
    )]
    Again {
        started: Started,
        after: Duration,
        failures: u32,
        of: u32,
    },
    // `bin/domicile.rs` prints the compositor's error under this message; see
    // `crate::heard`.
    #[error(
        "{failures} {started}s in a row have failed, so this one is not being \
         started again."
    )]
    GiveUp { started: Started, failures: u32 },
}

/// The outcome of one desktop or engine run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt {
    /// A component exited cleanly. Nothing to restart.
    Ended,
    /// It stopped unexpectedly after running for `lived`. The cause is
    /// reported where it happened.
    Failed { lived: Duration },
    /// Its engine could not draw. See [`renderer_unavailable`].
    RendererUnavailable,
}

/// The outcome of a desktop's parts running until one exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartAttempt {
    /// A part exited in a way that ends the desktop.
    Ended,
    /// `part` stopped unexpectedly after running for `lived`.
    Failed { part: Started, lived: Duration },
    /// The engine could not draw. See [`renderer_unavailable`].
    RendererUnavailable,
}

/// How a run of desktops finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    /// A desktop ended cleanly.
    Over,
    /// A stop was asked for.
    Stopped,
    /// Enough of `started` failed in a row.
    GaveUp { started: Started, failures: u32 },
    /// The engine could not draw. See [`renderer_unavailable`].
    RendererUnavailable,
}

/// A file from the last desktop that could not be removed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "{path} is what the last desktop left behind and it cannot be taken away \
     ({kind:?}), so there is nowhere to start another one"
)]
pub struct Leftover {
    pub path: String,
    pub kind: std::io::ErrorKind,
}

/// Runs desktops, starting a new one whenever one fails.
///
/// `attempt` runs one desktop and blocks while it is up. `wait` sleeps for the
/// backoff. `say` reports each restart.
///
/// `stopped` is checked after each attempt and after each wait. A Ctrl-C also
/// kills components, which looks like a crash, so the check after an attempt
/// prevents a restart on shutdown. The check after a wait catches a stop
/// requested while nothing was running.
pub fn keep_a_desktop_up(
    policy: &Policy,
    attempt: &mut dyn FnMut() -> Attempt,
    stopped: &dyn Fn() -> bool,
    wait: &mut dyn FnMut(Duration),
    say: &mut dyn FnMut(&Next),
) -> Ending {
    keep_the_parts_up(
        policy,
        &mut || match attempt() {
            Attempt::Ended => PartAttempt::Ended,
            Attempt::Failed { lived } => PartAttempt::Failed {
                part: Started::Desktop,
                lived,
            },
            Attempt::RendererUnavailable => PartAttempt::RendererUnavailable,
        },
        stopped,
        wait,
        say,
    )
}

/// Runs a desktop's parts, restarting each one that dies under the one still
/// serving.
///
/// Each part counts its own failures. [`PartAttempt::Ended`] ends the
/// desktop. On [`Ending::GaveUp`] the caller tears down the desktop and
/// [`keep_a_desktop_up`] starts a new one.
pub fn keep_the_parts_up(
    policy: &Policy,
    attempt: &mut dyn FnMut() -> PartAttempt,
    stopped: &dyn Fn() -> bool,
    wait: &mut dyn FnMut(Duration),
    say: &mut dyn FnMut(&Next),
) -> Ending {
    let mut failures: HashMap<Started, u32> = HashMap::new();
    loop {
        match attempt() {
            PartAttempt::Ended => return Ending::Over,
            PartAttempt::RendererUnavailable => return Ending::RendererUnavailable,
            PartAttempt::Failed { part, lived } => {
                if stopped() {
                    return Ending::Stopped;
                }
                let failed = failures.entry(part).or_insert(0);
                let next = next(policy, part, *failed, lived);
                say(&next);
                match next {
                    Next::GiveUp { started, failures } => {
                        return Ending::GaveUp { started, failures }
                    }
                    Next::Again {
                        after,
                        failures: again,
                        ..
                    } => {
                        *failed = again;
                        wait(after);
                        if stopped() {
                            return Ending::Stopped;
                        }
                    }
                }
            }
        }
    }
}

/// Decides the next step after a failure.
///
/// `failures` counts earlier consecutive failures, so the first is `0`.
fn next(policy: &Policy, started: Started, failures: u32, lived: Duration) -> Next {
    let failures = match lived >= policy.long_enough {
        true => 1,
        false => failures + 1,
    };
    match failures >= policy.give_up_after {
        true => Next::GiveUp { failures, started },
        false => Next::Again {
            after: doubling(policy, failures),
            failures,
            of: policy.give_up_after,
            started,
        },
    }
}

/// Removes the sockets and session file the last desktop left.
///
/// - A stale session file would make the launcher report the next compositor
///   as ready before it binds anything (see the milestone in
///   `bin/domicile.rs`).
/// - A stale socket makes the next bind fail. The engine `CHECK`s its command
///   socket bind, so it would crash.
///
/// - The launched clients' record goes, so a new desktop launches none of the
///   last one's again.
///
/// The profile is kept so the user stays signed in. Chromium recovers its own
/// stale singleton lock. The control socket belongs to this process and stays.
///
/// A missing path is success. Any other error is returned.
pub fn clear_the_last_one(runtime: &Runtime) -> Result<(), Leftover> {
    clear_the_last_compositor(runtime)?;
    clear_the_last_engine(runtime)?;
    gone(&runtime.launches, std::fs::remove_file(&runtime.launches))
}

/// Removes the last compositor's chrome socket and session file.
///
/// Leaves the broker, command and Electron sockets, which belong to the engine that is
/// still running, and the launched clients' record, which the next compositor
/// reads.
pub fn clear_the_last_compositor(runtime: &Runtime) -> Result<(), Leftover> {
    gone(
        &runtime.chrome_socket,
        std::fs::remove_file(&runtime.chrome_socket),
    )?;
    gone(&runtime.session, std::fs::remove_file(&runtime.session))
}

/// Removes the last engine's broker, command and Electron sockets.
///
/// Leaves the chrome socket and session file, which belong to the compositor
/// that is still running.
pub fn clear_the_last_engine(runtime: &Runtime) -> Result<(), Leftover> {
    gone(&runtime.broker, std::fs::remove_file(&runtime.broker))?;
    gone(&runtime.command, std::fs::remove_file(&runtime.command))?;
    gone(&runtime.electron, std::fs::remove_file(&runtime.electron))
}

fn doubling(policy: &Policy, failures: u32) -> Duration {
    // `failures` is at least 1. The shift is capped so a policy that never
    // gives up cannot overflow it.
    let doubled = policy
        .first_wait
        .saturating_mul(1u32 << (failures - 1).min(31));
    doubled.min(policy.longest_wait)
}

fn gone(path: &Path, removed: std::io::Result<()>) -> Result<(), Leftover> {
    match removed {
        Ok(()) => Ok(()),
        Err(why) => match why.kind() {
            std::io::ErrorKind::NotFound => Ok(()),
            kind => Err(Leftover {
                path: path.display().to_string(),
                kind,
            }),
        },
    }
}

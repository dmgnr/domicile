//! Starts, watches and stops the engine and compositor processes.
//!
//! The engine starts first and creates the broker socket. The compositor then
//! connects to it. The engine dials the compositor's control socket later,
//! when the page needs it, so nothing waits on it here.
//!
//! Command lines come from `spawn`. This module makes sure no child outlives
//! the run.

use std::io::{BufRead, BufReader};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::spawn::Spawn;

/// How often the short waits (startup, backoff, shutdown) check for an exit
/// or a stop. 100 ms is not a noticeable delay. The session-long wait,
/// [`Running::until_one_exits`], blocks instead.
pub const ASK_EVERY: Duration = Duration::from_millis(100);

/// A component could not be started.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("could not start the {what} at {}: {source}", .program.display())]
    Start {
        what: &'static str,
        program: std::path::PathBuf,
        source: std::io::Error,
    },
}

/// A component that is no longer running.
///
/// `how` is the formatted status, such as `signal: 11 (SIGSEGV)`, so a
/// signal is not confused with an exit code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the {what} exited ({how})")]
pub struct Exit {
    pub what: &'static str,
    pub how: String,
}

/// Grace period between `SIGTERM` and `SIGKILL`.
///
/// `SIGTERM` lets Chromium save its profile and record a clean exit. It waits
/// up to 10 s for those writes (`kEndSessionTimeout`), so 3 s cut it short
/// and every start counted a crash. The console does not depend on it: logind
/// restores the VT when the engine's bus connection closes, however the
/// engine exits.
const TO_STOP: Duration = Duration::from_secs(15);

/// How long the end of a run waits for the last of a component's stderr.
const LAST_WORDS: Duration = Duration::from_secs(3);

/// Children killed when the run ends, however it ends.
///
/// A leftover engine would hold sockets the next desktop needs.
pub struct Running {
    components: Vec<(&'static str, Child)>,
    listeners: Vec<JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        for (what, child) in &mut self.components {
            end_the_group(what, child);
        }
        // Join after the groups are gone: a listener's read ends only when
        // every writer to the pipe has exited, so the caller sees the last
        // lines of stderr. A process that left the group, such as an app the
        // engine started with its own session, can hold the pipe open for as
        // long as it runs; after `LAST_WORDS` its listener is left to carry
        // on alone rather than holding up the end of the run.
        //
        // Ignore a panicked listener. Panicking in `Drop` during an unwind
        // would abort.
        let deadline = std::time::Instant::now() + LAST_WORDS;
        while self
            .listeners
            .iter()
            .any(|listener| !listener.is_finished())
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(ASK_EVERY);
        }
        for listener in self.listeners.drain(..) {
            if listener.is_finished() {
                let _ = listener.join();
            }
        }
    }
}

/// Stops a component and everything it started.
///
/// `SIGTERM` goes to the component alone. Chromium ends its own GPU, zygote
/// and other processes, and needs them until it does: signaling them with it
/// is a crash under it. Once it exits, or after [`TO_STOP`], its whole process
/// group gets `SIGKILL`, since an orphaned GPU process can keep DRM master and
/// lock up the console. `Child::kill` would miss the group.
///
/// The group outlives its leader while it has members, so signaling it by the
/// leader's pid works after the leader is reaped.
fn end_the_group(what: &str, child: &mut Child) {
    let group = child.id() as libc::pid_t;
    // Already exited, so its pid may be someone else's by now. Its group is
    // not reused while it has members.
    if let Ok(Some(_)) = child.try_wait() {
        signal_group(group, libc::SIGKILL);
        return;
    }
    // SAFETY: `kill` takes a pid and a signal. The pid is our unreaped
    // child's. The only reachable error is `ESRCH`.
    unsafe {
        libc::kill(group, libc::SIGTERM);
    }

    let asked = std::time::Instant::now();
    let mut stopped = None;
    while stopped.is_none() && asked.elapsed() < TO_STOP {
        match child.try_wait() {
            Ok(Some(status)) => stopped = Some(status),
            _ => std::thread::sleep(ASK_EVERY),
        }
    }

    signal_group(group, libc::SIGKILL);
    match stopped {
        Some(status) => crate::launcher_log::info(&format!(
            "the {what} stopped {} ms after SIGTERM ({status})",
            asked.elapsed().as_millis()
        )),
        None => {
            let _ = child.wait();
            crate::launcher_log::error(&format!(
                "the {what} was still running {} s after SIGTERM, so it was killed",
                TO_STOP.as_secs()
            ));
        }
    }
}

/// Starts one component with the given stderr and stdout.
fn started(
    what: &'static str,
    spawn: &Spawn,
    stderr: fn() -> Stdio,
    stdout: fn() -> Stdio,
) -> Result<Child, RunError> {
    let child = command(spawn)
        .stderr(stderr())
        .stdout(stdout())
        .spawn()
        .map_err(|source| RunError::Start {
            program: spawn.program.clone(),
            source,
            what,
        })?;
    if crate::launcher_log::showing(domicile_protocol::LogLevel::Debug) {
        crate::launcher_log::debug(&format!(
            "started the {what} as pid {}: {} {}",
            child.id(),
            spawn.program.display(),
            spawn
                .args
                .iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    Ok(child)
}

/// Where each line of a heard component's stderr goes, without its newline.
pub type Listener = Box<dyn FnMut(&str) + Send>;

/// Hands each line of a component's stderr or stdout to `listener`.
///
/// Reads bytes rather than `lines()`, which stops at the first invalid UTF-8.
fn overhear(what: &'static str, said: impl std::io::Read, mut listener: Listener) {
    let mut reader = BufReader::new(said);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            // The component exited.
            Ok(0) => return,
            Ok(_) => {
                let said = String::from_utf8_lossy(&line);
                listener(said.trim_end_matches(['\n', '\r']));
            }
            // Unrecoverable. Report it; this thread has no caller to return to.
            Err(why) => {
                eprintln!("domicile: lost the rest of what the {what} said: {why}");
                return;
            }
        }
    }
}

/// Calls `killpg`, ignoring failure. The only reachable error is `ESRCH`: the
/// group is already gone.
fn signal_group(group: libc::pid_t, signal: libc::c_int) {
    unsafe {
        libc::killpg(group, signal);
    }
}

impl Running {
    pub fn new() -> Self {
        Running {
            components: Vec::new(),
            listeners: Vec::new(),
        }
    }

    /// Starts a component that inherits our stderr.
    pub fn start(&mut self, what: &'static str, spawn: &Spawn) -> Result<(), RunError> {
        let child = started(what, spawn, Stdio::inherit, Stdio::inherit)?;
        self.components.push((what, child));
        Ok(())
    }

    /// Starts a component, handing each line of its stderr to `listener`.
    ///
    /// Every line reaches `listener` before the [`Running`] is dropped.
    pub fn start_heard(
        &mut self,
        what: &'static str,
        spawn: &Spawn,
        listener: Listener,
    ) -> Result<(), RunError> {
        let mut child = started(what, spawn, Stdio::piped, Stdio::inherit)?;
        let listening = child.stderr.take().expect("stderr was asked for a pipe");
        self.listeners.push(std::thread::spawn(move || {
            overhear(what, listening, listener)
        }));
        self.components.push((what, child));
        Ok(())
    }

    /// [`Running::start_heard`], handing each line of its stdout to `stdout`
    /// too.
    pub fn start_heard_whole(
        &mut self,
        what: &'static str,
        spawn: &Spawn,
        listener: Listener,
        stdout: Listener,
    ) -> Result<(), RunError> {
        let mut child = started(what, spawn, Stdio::piped, Stdio::piped)?;
        let listening = child.stderr.take().expect("stderr was asked for a pipe");
        let out = child.stdout.take().expect("stdout was asked for a pipe");
        self.listeners.push(std::thread::spawn(move || {
            overhear(what, listening, listener)
        }));
        self.listeners
            .push(std::thread::spawn(move || overhear(what, out, stdout)));
        self.components.push((what, child));
        Ok(())
    }

    /// Stops the named component's process group and forgets it.
    ///
    /// Used to replace a dead engine, whose GPU and zygote processes may still
    /// hold the card. The entry must be removed, or [`Running::exited`] would
    /// report the old exit forever. An unknown name is a no-op.
    pub fn let_go_of(&mut self, what: &'static str) {
        crate::launcher_log::debug(&format!("stopping the {what}'s processes"));
        for (held, child) in self.components.iter_mut().filter(|(held, _)| *held == what) {
            end_the_group(held, child);
        }
        self.components.retain(|(held, _)| *held != what);
    }

    /// Returns the first component that has exited, without blocking.
    ///
    /// Panics if `try_wait` fails, which cannot happen for our own child.
    pub fn exited(&mut self) -> Option<Exit> {
        self.components.iter_mut().find_map(|(what, child)| {
            child
                .try_wait()
                .expect("a child this process started can be waited on")
                .map(|status| exit(what, status))
        })
    }

    /// Blocks until any component exits or a stop is requested.
    pub fn until_one_exits(&mut self) -> Exit {
        loop {
            if let Some(exit) = self.exited() {
                return exit;
            }
            if interrupted() {
                return Exit {
                    what: "desktop",
                    how: "interrupted".to_string(),
                };
            }
            self.until_something_happens();
        }
    }

    /// Blocks until a component's pid fd or the interrupt pipe is readable.
    ///
    /// A pid fd becomes readable when its process exits. A signal that lands
    /// between the caller's checks and the `poll` still wakes it, through the
    /// pipe.
    fn until_something_happens(&self) {
        let pid_fds: Vec<OwnedFd> = self
            .components
            .iter()
            .map(|(_, child)| pid_fd(child))
            .collect();
        // `poll` skips a negative fd: no pipe before `catch_interrupts`.
        let mut polled: Vec<libc::pollfd> = pid_fds
            .iter()
            .map(AsRawFd::as_raw_fd)
            .chain([INTERRUPT_READ.load(Ordering::Relaxed)])
            .map(|fd| libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            })
            .collect();
        // SAFETY: `polled` is a live array of `polled.len()` entries.
        let ready = unsafe { libc::poll(polled.as_mut_ptr(), polled.len() as libc::nfds_t, -1) };
        if ready < 0 {
            let why = std::io::Error::last_os_error();
            // A signal: the caller checks for a stop.
            assert_eq!(
                why.kind(),
                std::io::ErrorKind::Interrupted,
                "polling the components failed: {why}"
            );
        }
    }
}

/// A pid fd for `child`, which is not reaped yet, so its pid is still its own.
fn pid_fd(child: &Child) -> OwnedFd {
    // SAFETY: `pidfd_open` takes a pid and flags, and returns a new fd or -1.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id() as libc::pid_t, 0) };
    assert!(
        fd >= 0,
        "a child this process started has a pid fd: {}",
        std::io::Error::last_os_error()
    );
    // SAFETY: the kernel just opened `fd`, and nothing else owns it.
    unsafe { OwnedFd::from_raw_fd(fd as RawFd) }
}

impl Default for Running {
    fn default() -> Self {
        Running::new()
    }
}

/// Set by the signal handler and read by the wait loops. An atomic is all a
/// signal handler may safely touch.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// The pipe the signal handler writes to, so [`Running::until_one_exits`]
/// wakes for a stop. -1 until [`catch_interrupts`] opens it.
static INTERRUPT_READ: AtomicI32 = AtomicI32::new(-1);
static INTERRUPT_WRITE: AtomicI32 = AtomicI32::new(-1);

/// `/dev/null`, opened by [`catch_interrupts`] for [`note_the_hangup`].
static DEV_NULL: AtomicI32 = AtomicI32::new(-1);

/// A hangup is a stop, and what stdout and stderr wrote to (the tty, or the
/// display manager's `systemd-cat`) is ending with the session: they go to
/// `/dev/null` so writes during the teardown don't fail and panic.
extern "C" fn note_the_hangup(signal: libc::c_int) {
    // SAFETY: `dup2` is async-signal-safe. `errno` is put back for the code
    // the signal interrupted.
    unsafe {
        let errno = *libc::__errno_location();
        let null = DEV_NULL.load(Ordering::Relaxed);
        libc::dup2(null, libc::STDOUT_FILENO);
        libc::dup2(null, libc::STDERR_FILENO);
        *libc::__errno_location() = errno;
    }
    note_the_interrupt(signal);
}

extern "C" fn note_the_interrupt(_signal: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Relaxed);
    // SAFETY: `write` is async-signal-safe. The end is non-blocking, so a
    // full pipe, which is already readable, drops the byte. `errno` is put
    // back for the code the signal interrupted.
    unsafe {
        let errno = *libc::__errno_location();
        libc::write(
            INTERRUPT_WRITE.load(Ordering::Relaxed),
            [0u8].as_ptr().cast(),
            1,
        );
        *libc::__errno_location() = errno;
    }
}

/// Makes `SIGINT`, `SIGTERM` and `SIGHUP` end the run instead of killing this
/// process.
///
/// Components run in their own process groups, so Ctrl-C reaches only this
/// process. Without a handler it would die before `Running::drop` stopped
/// them and before the graphical session ended. A logout, from a display
/// manager or a tty, sends `SIGTERM` and then `SIGHUP` to every process in the
/// login session (logind's scopes have `SendSIGHUP=yes`). The handler sets a
/// flag, which the wait loops check, and wakes [`Running::until_one_exits`].
///
/// Panics if the pipe or `/dev/null` cannot be opened.
pub fn catch_interrupts() {
    let mut ends = [0; 2];
    // SAFETY: `ends` has room for the two fds `pipe2` writes.
    let piped = unsafe { libc::pipe2(ends.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) };
    assert_eq!(
        piped,
        0,
        "opening the interrupt pipe failed: {}",
        std::io::Error::last_os_error()
    );
    // Open for the life of the process: the handler may fire at any time.
    INTERRUPT_READ.store(ends[0], Ordering::Relaxed);
    INTERRUPT_WRITE.store(ends[1], Ordering::Relaxed);
    // SAFETY: the path is a NUL-terminated C string.
    let null = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
    assert!(
        null >= 0,
        "opening /dev/null failed: {}",
        std::io::Error::last_os_error()
    );
    DEV_NULL.store(null, Ordering::Relaxed);
    let handlers: [(libc::c_int, extern "C" fn(libc::c_int)); 3] = [
        (libc::SIGINT, note_the_interrupt),
        (libc::SIGTERM, note_the_interrupt),
        (libc::SIGHUP, note_the_hangup),
    ];
    for (signal, handler) in handlers {
        // SAFETY: the handlers call only async-signal-safe functions and
        // touch only atomics.
        unsafe {
            libc::signal(signal, handler as *const () as libc::sighandler_t);
        }
    }
}

/// Whether a stop has been asked for since the run began.
pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::Relaxed)
}

fn exit(what: &'static str, status: ExitStatus) -> Exit {
    Exit {
        how: status.to_string(),
        what,
    }
}

fn command(spawn: &Spawn) -> Command {
    let mut command = Command::new(&spawn.program);
    command.args(&spawn.args);
    for (name, value) in &spawn.env {
        command.env(name, value);
    }
    // A new process group led by the child, so `end_the_group` reaches its
    // forks. This also removes it from the terminal's foreground group; see
    // `catch_interrupts`.
    command.process_group(0);
    command
}

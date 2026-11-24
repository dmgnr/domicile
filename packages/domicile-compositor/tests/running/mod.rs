//! Test fixture: a real compositor, started the way a shell starts one.
//!
//! Each run gets its own runtime directory, config and home, and waits for the
//! published session rather than for the socket.
//!
//! The compositor is killed on drop. A leaked one would outlive the run, since
//! `cargo test` waits for its children and nothing else reaps it.

// Each test binary compiles its own copy of this module and uses only part of
// it, so the rest is dead code in that binary.
#![allow(dead_code)]

pub mod bus;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use domicile_test_chrome::Chrome;

/// How long a compositor gets to publish its session.
///
/// Generous because an EGL probe without a GPU falls back to software
/// rendering, which is slow.
const PATIENCE: Duration = Duration::from_secs(20);

/// The passphrase the run's `domicile` PAM service takes.
pub const THE_PASSPHRASE: &str = "open sesame";

/// A compositor process and the directory it was given.
pub struct Compositor {
    child: Child,
    /// The compositor's `XDG_RUNTIME_DIR`, where its Wayland sockets live.
    /// Clients this fixture starts use it too.
    runtime_dir: PathBuf,
    complaint: Arc<Mutex<String>>,
    config_file: PathBuf,
    /// Held only so that dropping it removes the run directory.
    _directory: tempfile::TempDir,
    session: Session,
}

/// What the compositor published, as this fixture needs it.
pub struct Session {
    pub chrome_socket: PathBuf,
    /// The display for the chrome's own window. The compositor tells the
    /// chrome from apps only by which display a client connects to.
    pub chrome_wayland_display: String,
    /// The display applications connect to, as the compositor named it.
    ///
    /// Read from the session, not assumed: the compositor picks the first
    /// free name.
    pub wayland_display: String,
}

impl Compositor {
    /// Start one on `config`, the JSON a shell would generate.
    ///
    /// Panics on failure, with the compositor's output in the message.
    pub fn started_with(config: &str) -> Compositor {
        Compositor::started_in_a_home(config, None)
    }

    /// The same, over a home directory the test laid out.
    ///
    /// `None` gives an empty home. The compositor indexes and watches `$HOME`
    /// (see `crate::file_indexing`), so tests must never see the runner's.
    pub fn started_in_a_home(config: &str, home: Option<&std::path::Path>) -> Compositor {
        Compositor::started_with_env(config, home, &[])
    }

    /// The same, on the session bus at `address`, for the portals.
    pub fn started_on_a_bus(config: &str, address: &str) -> Compositor {
        Compositor::started_with_env(config, None, &[("DBUS_SESSION_BUS_ADDRESS", address)])
    }

    /// The same, with the system bus at `address`, for logind.
    pub fn started_on_a_system_bus(config: &str, address: &str) -> Compositor {
        Compositor::started_with_env(config, None, &[("DBUS_SYSTEM_BUS_ADDRESS", address)])
    }

    /// The same, with `env` set, such as a session bus for the portals.
    pub fn started_with_env(
        config: &str,
        home: Option<&std::path::Path>,
        env: &[(&str, &str)],
    ) -> Compositor {
        Compositor::started(config, home, env, true)
    }

    /// The same, on a machine that declares no PAM service.
    pub fn started_where_pam_declares_nothing(config: &str) -> Compositor {
        Compositor::started(config, None, &[], false)
    }

    /// Every run reads PAM services from its own directory, never the
    /// runner's `/etc/pam.d`. When `declared`, it holds a `domicile` service
    /// that takes [`THE_PASSPHRASE`].
    fn started(
        config: &str,
        home: Option<&std::path::Path>,
        env: &[(&str, &str)],
        declared: bool,
    ) -> Compositor {
        let directory = tempfile::tempdir().expect("a runtime directory");
        let pam_confdir = directory.path().join("pam.d");
        std::fs::create_dir_all(&pam_confdir).expect("a directory of PAM services");
        if declared {
            declare_the_service(directory.path(), &pam_confdir);
        }
        let config_file = directory.path().join("config.json");
        std::fs::write(&config_file, config).expect("the config is written");
        let session_file = directory.path().join("session.json");
        let chrome_socket = directory.path().join("chrome.sock");
        let empty_home = directory.path().join("home");
        std::fs::create_dir_all(&empty_home).expect("a home to index");

        let child = Command::new(env!("CARGO_BIN_EXE_domicile-compositor"))
            .arg("--chrome-socket")
            .arg(&chrome_socket)
            .arg("--session")
            .arg(&session_file)
            .arg("--config")
            .arg(&config_file)
            .arg("--pam-confdir")
            .arg(&pam_confdir)
            // Its own, so its displays cannot collide with the runner's.
            .env("XDG_RUNTIME_DIR", directory.path())
            // The file index's source and cache, both private to this run.
            .env("HOME", home.unwrap_or(&empty_home))
            .env("XDG_CACHE_HOME", directory.path().join("cache"))
            // Read icons from the test home only, not the machine's.
            .env_remove("XDG_DATA_HOME")
            .env("XDG_DATA_DIRS", directory.path().join("no-data"))
            // A decoy. The compositor must set `WAYLAND_DISPLAY` for what it
            // spawns. Without this, a child could inherit the runner's value,
            // often `wayland-1`, which is also the compositor's first display
            // name, and a test could not tell the two apart.
            .env("WAYLAND_DISPLAY", "not-domicile")
            // Debug, because some decisions (such as a refused density)
            // leave no trace on the socket, only in the log.
            .env("RUST_LOG", "info,domicile_compositor=debug")
            // No system bus, so a run never reaches the runner's logind.
            .env(
                "DBUS_SYSTEM_BUS_ADDRESS",
                format!(
                    "unix:path={}",
                    directory.path().join("no-system-bus").display()
                ),
            )
            .envs(env.iter().copied())
            // Both into one buffer: logs go to stdout and panics to stderr.
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the compositor starts");

        let mut child = child;
        let complaint = Arc::new(Mutex::new(String::new()));
        drain(child.stdout.take().expect("stdout was piped"), &complaint);
        drain(child.stderr.take().expect("stderr was piped"), &complaint);

        let mut compositor = Compositor {
            child,
            complaint,
            config_file: config_file.clone(),
            runtime_dir: directory.path().to_path_buf(),
            _directory: directory,
            session: Session {
                chrome_socket: chrome_socket.clone(),
                chrome_wayland_display: String::new(),
                // Filled in from the published session below.
                wayland_display: String::new(),
            },
        };
        let published = compositor.await_session(&session_file);
        compositor.session.wayland_display = published.wayland_display;
        compositor.session.chrome_wayland_display = published.chrome_wayland_display;
        compositor
    }

    /// The chrome socket, for a test that plays the chrome itself without the
    /// handshake.
    pub fn socket(&self) -> &std::path::Path {
        &self.session.chrome_socket
    }

    /// The compositor process, as the bus names it.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Where this run keeps its caches, which is where its file index goes.
    pub fn cache_home(&self) -> PathBuf {
        self.runtime_dir.join("cache")
    }

    /// A stand-in chrome, connected and past the handshake.
    ///
    /// It reads only inside `Chrome::wait_for`, so its socket can fill while a
    /// test waits on something else. Most messages still get processed, but
    /// a `hello` needs the writer lock and can block behind the full socket.
    /// Hundreds of unread `hello`s hang the test, so read the socket if you
    /// send many.
    pub fn chrome(&self) -> Chrome {
        Chrome::connect(&self.session.chrome_socket, PATIENCE)
            .expect("a chrome can connect to a compositor that published a session")
    }

    /// Start a traced `domicile-test-client` on the apps' display.
    ///
    /// Its trace shows what the client was told, which the chrome socket does
    /// not. Killed on drop.
    pub fn client(&self, title: &str) -> Client {
        self.client_on(&self.session.wayland_display, title)
    }

    /// The same, on the chrome's display.
    ///
    /// The compositor classifies a client only by its display, so this
    /// stands in for the chrome without a browser.
    pub fn chrome_side_client(&self, title: &str) -> Client {
        self.client_on(&self.session.chrome_wayland_display, title)
    }

    /// A client with extra command-line flags, for checks that combine them.
    pub fn client_with(&self, title: &str, extra: &[&str]) -> Client {
        self.client_on_with(&self.session.wayland_display, title, extra)
    }

    /// The same, on `display`: a name in the runtime directory or a path.
    pub fn client_on(&self, display: &str, title: &str) -> Client {
        self.client_on_with(display, title, &[])
    }

    /// The same, on the session bus at `address`, for a client that notifies.
    pub fn client_on_a_bus(&self, title: &str, extra: &[&str], address: &str) -> Client {
        self.client_on_with_env(
            &self.session.wayland_display,
            title,
            extra,
            &[("DBUS_SESSION_BUS_ADDRESS", address)],
        )
    }

    fn client_on_with(&self, display: &str, title: &str, extra: &[&str]) -> Client {
        self.client_on_with_env(display, title, extra, &[])
    }

    fn client_on_with_env(
        &self,
        display: &str,
        title: &str,
        extra: &[&str],
        env: &[(&str, &str)],
    ) -> Client {
        // The client is a target of this crate so cargo builds it first and
        // gives its path, whatever the profile or target directory.
        let mut child = Command::new(env!("CARGO_BIN_EXE_domicile-test-client"))
            .arg("--title")
            .arg(title)
            .arg("--trace")
            .args(extra)
            .env("WAYLAND_DISPLAY", display)
            .env("XDG_RUNTIME_DIR", &self.runtime_dir)
            .envs(env.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|why| panic!("the test client starts: {why}"));
        let said = Arc::new(Mutex::new(String::new()));
        drain(child.stdout.take().expect("stdout was piped"), &said);
        drain(child.stderr.take().expect("stderr was piped"), &said);
        Client {
            child,
            said,
            title: title.to_string(),
        }
    }

    /// `program` set up to connect to the apps' display, for a test that runs
    /// a real tool such as `wl-copy` instead of the test client.
    pub fn command(&self, program: &str) -> Command {
        let mut command = Command::new(program);
        command
            .env("WAYLAND_DISPLAY", &self.session.wayland_display)
            .env("XDG_RUNTIME_DIR", &self.runtime_dir);
        command
    }

    /// The socket the compositor listens on for applications.
    pub fn wayland_socket(&self) -> PathBuf {
        self.runtime_dir.join(self.wayland_display())
    }

    /// The display the compositor published for applications.
    pub fn wayland_display(&self) -> &str {
        &self.session.wayland_display
    }

    /// A path in the run directory for a spawned program to write to, removed
    /// with the compositor.
    pub fn scratch_file(&self, name: &str) -> PathBuf {
        self.runtime_dir.join(name)
    }

    /// Wait for `path` to exist and return its contents.
    ///
    /// Fails with the compositor's log, which explains why a spawn did not
    /// happen.
    pub fn await_file(&self, path: &std::path::Path) -> String {
        let until = Instant::now() + PATIENCE;
        loop {
            if let Ok(said) = std::fs::read_to_string(path) {
                return said;
            }
            assert!(
                Instant::now() < until,
                "nothing wrote {} in {PATIENCE:?}; the compositor said:\n{}",
                path.display(),
                self.complaint()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Rewrite the config the compositor is watching.
    ///
    /// By rename, as editors save. A plain write can expose a truncated file,
    /// which parses as a desktop with no displays.
    pub fn reconfigure(&self, config: &str) {
        let staging = self.config_file.with_extension("json.new");
        std::fs::write(&staging, config).expect("the new config is written");
        std::fs::rename(&staging, &self.config_file).expect("it replaces the old one");
    }

    /// Wait for the session document and parse it.
    ///
    /// It is published by rename, so it is safe to read once it exists.
    fn await_session(
        &mut self,
        session_file: &std::path::Path,
    ) -> domicile_launch::session::Session {
        let until = Instant::now() + PATIENCE;
        while !session_file.exists() {
            if let Some(status) = self.child.try_wait().expect("the child is waitable") {
                let said = self.complaint();
                panic!(
                    "the compositor exited with {status} instead of publishing a session:\n{said}"
                );
            }
            if Instant::now() >= until {
                let said = self.complaint();
                panic!("the compositor never published a session in {PATIENCE:?}:\n{said}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let published = std::fs::read_to_string(session_file).expect("the session is readable");
        // Parsed with the launcher's type, so this reads what a shell would.
        serde_json::from_str::<domicile_launch::session::Session>(&published).unwrap_or_else(
            |why| {
                let said = self.complaint();
                panic!(
                "the compositor published a session no shell could read: {why}\n{published}\n{said}"
            )
            },
        )
    }

    /// Wait until the compositor's log contains `pattern`.
    ///
    /// For decisions that leave no trace on the socket, such as a refusal.
    pub fn wait_for_log(&self, pattern: &str) {
        let until = Instant::now() + PATIENCE;
        loop {
            let said = self.complaint();
            if said.contains(pattern) {
                return;
            }
            assert!(
                Instant::now() < until,
                "the compositor never said {pattern:?} in {PATIENCE:?}:\n{said}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Wait until the compositor has said `pattern` at least `wanted` times.
    ///
    /// For a line logged more than once, where `wait_for_log` would match an
    /// earlier occurrence.
    pub fn wait_for_log_times(&self, pattern: &str, wanted: usize) {
        let until = Instant::now() + PATIENCE;
        loop {
            let said = self.complaint();
            if said.matches(pattern).count() >= wanted {
                return;
            }
            assert!(
                Instant::now() < until,
                "the compositor said {pattern:?} fewer than {wanted} times in \
                 {PATIENCE:?}:\n{said}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Everything read from the compositor's output so far.
    ///
    /// A background thread reads the output, so a line the compositor has
    /// written may not be here yet. To check for a line, use
    /// [`wait_for_log`](Self::wait_for_log). This is for checking what the log
    /// does not contain, such as a refused passphrase in `tests/lock.rs`.
    pub fn complaint(&self) -> String {
        let said = self.complaint.lock().expect("nothing panics holding this");
        if said.trim().is_empty() {
            "(it said nothing)".to_string()
        } else {
            said.clone()
        }
    }
}

impl Drop for Compositor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Copy a pipe into `said` on a background thread.
///
/// A pipe nobody reads fills and blocks the writer. Bytes are decoded lossily
/// so a stray non-UTF-8 byte does not truncate the log.
/// Writes a `domicile` PAM service into `confdir` that takes
/// [`THE_PASSPHRASE`] and refuses anything else.
///
/// Real PAM, with the password check replaced by a script in `scripts`, as in
/// `crate::pam`'s tests: `pam_unix` needs a real user's password, which no
/// runner has.
fn declare_the_service(scripts: &std::path::Path, confdir: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    let script = scripts.join("check-the-passphrase");
    // Builtins only: `pam_exec` runs this with no `PATH`. `read` fails on input
    // with no trailing newline, which `pam_exec` sends, so the comparison
    // gives the verdict.
    std::fs::write(
        &script,
        format!("#!/bin/sh\nIFS= read -r typed\n[ \"$typed\" = '{THE_PASSPHRASE}' ]\n"),
    )
    .expect("the script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .expect("the script runs");
    std::fs::write(
        confdir.join("domicile"),
        format!(
            "auth [success=1 default=ignore] pam_exec.so expose_authtok quiet {}\n\
             auth requisite pam_deny.so\n\
             auth required pam_permit.so\n",
            script.display()
        ),
    )
    .expect("the service");
}

fn drain(mut pipe: impl std::io::Read + Send + 'static, said: &Arc<Mutex<String>>) {
    let writing = said.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        // A partial character from the last read. A read can split a
        // multi-byte character.
        let mut pending = Vec::new();
        loop {
            let read = match pipe.read(&mut buffer) {
                // Keep the tail, even a partial character: the compositor may
                // have been killed mid-write.
                Ok(0) => return flush(&pending, &writing),
                Ok(read) => read,
                // Note the failure in the log, since the rest of it is lost.
                Err(err) => {
                    flush(&pending, &writing);
                    let mut said = writing.lock().expect("nothing panics holding this");
                    said.push_str(&format!("\n(the test could not read on: {err})\n"));
                    return;
                }
            };
            pending.extend_from_slice(&buffer[..read]);
            let mut said = writing.lock().expect("nothing panics holding this");
            said.push_str(&decoded(&mut pending));
        }
    });
}

/// Put whatever is left of a pipe into `said`, whole character or not.
fn flush(pending: &[u8], said: &Mutex<String>) {
    if !pending.is_empty() {
        let mut said = said.lock().expect("nothing panics holding this");
        said.push_str(&String::from_utf8_lossy(pending));
    }
}

/// Remove and decode the complete characters at the start of `pending`.
///
/// Leaves only an incomplete trailing character. Invalid bytes become
/// replacement characters.
fn decoded(pending: &mut Vec<u8>) -> String {
    let mut taken = String::new();
    loop {
        let whole = match std::str::from_utf8(pending) {
            Ok(_) => pending.len(),
            Err(err) => match err.error_len() {
                // Incomplete: wait for the next read.
                None => err.valid_up_to(),
                // Invalid: take it so `from_utf8_lossy` replaces it, and loop
                // so the valid bytes after it are not held for the next read.
                Some(bad) => err.valid_up_to() + bad,
            },
        };
        if whole == 0 {
            return taken;
        }
        taken.push_str(&String::from_utf8_lossy(&pending[..whole]));
        pending.drain(..whole);
    }
}

/// The names of the screens a client's window is on now, from its trace.
///
/// Every output entered and not since left. Names, not object ids, so results
/// compare across clients. Output ids are never reused, because the test
/// client never destroys a `wl_output`.
///
/// A trace line is written in several `write` calls, so a line may be read
/// half-written. Each parse requires the closing bracket and skips the line
/// otherwise.
///
/// The compositor sends no `leave` when a display is removed, so a removed
/// screen stays in this answer. Checks using this only add displays.
fn screens_entered(trace: &str) -> Vec<String> {
    screens_entered_by(trace, None)
}

/// The names of the screens `surface` is on now, as [`screens_entered`], or
/// those of the client's one surface when `None`.
fn screens_entered_by(trace: &str, surface: Option<&str>) -> Vec<String> {
    let mut named: Vec<(String, String)> = Vec::new();
    let mut window: Option<String> = surface.map(str::to_string);
    let mut on: Vec<String> = Vec::new();
    for line in trace.lines() {
        let Some((object, event)) = line.trim().split_once('.') else {
            continue;
        };
        if let Some(called) = event.strip_prefix("name(") {
            if object.starts_with("wl_output") {
                let Some(whole) = called.strip_suffix(')') else {
                    continue;
                };
                named.push((object.to_string(), whole.trim_matches('"').to_string()));
            }
            continue;
        }
        if !object.starts_with("wl_surface") {
            continue;
        }
        let (entering, rest) = match (event.strip_prefix("enter("), event.strip_prefix("leave(")) {
            (Some(rest), _) => (true, rest),
            (_, Some(rest)) => (false, rest),
            _ => continue,
        };
        let Some(output) = rest.strip_suffix(')') else {
            continue;
        };
        if surface.is_some_and(|surface| surface != object) {
            continue;
        }
        let window = window.get_or_insert_with(|| object.to_string());
        // Unless told which surface, the test client has one surface. A second (such as a popup) would
        // mix its enters and leaves into the window's, so fail loudly.
        assert_eq!(
            window.as_str(),
            object,
            "the client has more than one surface ({window} and {object}), so \
             which of them this is answering about is no longer obvious; give \
             it a rule rather than letting it pick the first"
        );
        on.retain(|already| already != output);
        if entering {
            on.push(output.to_string());
        }
    }
    let mut screens: Vec<String> = on
        .into_iter()
        .map(|output| {
            named
                .iter()
                .find(|(id, _)| id == &output)
                // A compositor fault: a toolkit cannot pick a density for an
                // output with no name.
                .unwrap_or_else(|| {
                    panic!("the client entered {output}, which it was never told the name of")
                })
                .1
                .clone()
        })
        .collect();
    // Sorted, because arrival order is not part of the claim.
    screens.sort_unstable();
    screens
}

/// A trace is read for both the enters and the leaves.
#[test]
fn the_screens_a_window_is_on_are_the_ones_it_entered_and_did_not_leave() {
    let whole = "\
wl_output@3.name(\"left\")
wl_output@4.name(\"right\")
wl_surface@13.enter(wl_output@3)
wl_surface@13.enter(wl_output@4)";
    assert_eq!(screens_entered(whole), ["left", "right"]);

    let left_again = format!("{whole}\nwl_surface@13.leave(wl_output@4)");
    assert_eq!(screens_entered(&left_again), ["left"]);

    let back = format!("{left_again}\nwl_surface@13.enter(wl_output@4)");
    assert_eq!(screens_entered(&back), ["left", "right"]);
}

/// Asked about one surface, a trace with a popup's enters answers for that
/// surface alone.
#[test]
fn the_screens_one_surface_is_on_leave_out_the_others() {
    let both = "\
wl_output@3.name(\"left\")
wl_output@4.name(\"right\")
wl_surface@13.enter(wl_output@3)
wl_surface@13.enter(wl_output@4)
wl_surface@20.enter(wl_output@4)";
    assert_eq!(
        screens_entered_by(both, Some("wl_surface@13")),
        ["left", "right"]
    );
    assert_eq!(screens_entered_by(both, Some("wl_surface@20")), ["right"]);
}

/// A half-written trace line is skipped, not misread.
///
/// No torn-`name` case: smithay sends `name` before any `enter` for that
/// output, so a torn `name` is never for an output already entered.
#[test]
fn a_trace_line_still_being_written_is_skipped() {
    let described = "wl_output@3.name(\"left\")\nwl_surface@13.enter(wl_output@3)";
    let torn = format!("{described}\nwl_surface@13.enter(wl_output@");

    assert_eq!(
        screens_entered(&torn),
        ["left"],
        "a half-written enter is not a screen"
    );
}

/// A character split across two reads decodes as one character.
#[test]
fn a_character_cut_in_half_by_a_read_is_waited_for() {
    let em_dash = "—".as_bytes();
    let (first, rest) = em_dash.split_at(1);

    let mut pending = first.to_vec();
    assert_eq!(decoded(&mut pending), "", "nothing whole has arrived yet");
    pending.extend_from_slice(rest);

    assert_eq!(decoded(&mut pending), "—");
    assert!(pending.is_empty(), "and nothing is left waiting");
}

/// An invalid byte is replaced at once, not held for the next read.
#[test]
fn a_byte_that_is_not_a_character_costs_one_character_rather_than_the_rest() {
    let mut pending = b"before\xffafter".to_vec();

    let taken = decoded(&mut pending);

    assert!(taken.starts_with("before"), "got {taken:?}");
    assert!(
        taken.ends_with("after"),
        "everything after the bad byte is still there: {taken:?}"
    );
    assert!(pending.is_empty());
}

/// A pipe that ends mid-character still yields its tail.
///
/// `Drop` kills the compositor, which can cut a write short.
#[test]
fn what_a_pipe_was_cut_off_mid_character_saying_is_still_reported() {
    let em_dash = "—".as_bytes();
    let (head, _) = em_dash.split_at(2);
    let said = Arc::new(Mutex::new(String::new()));

    drain(
        std::io::Cursor::new([b"cut here: ".as_slice(), head].concat()),
        &said,
    );

    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let text = said.lock().expect("nothing panics holding this").clone();
        if text.starts_with("cut here: ") && text.len() > "cut here: ".len() {
            // The tail becomes a replacement character, not nothing.
            assert!(text.ends_with('\u{fffd}'), "got {text:?}");
            return;
        }
        assert!(Instant::now() < until, "the tail never arrived: {text:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A `domicile-test-client` talking to the compositor.
pub struct Client {
    child: Child,
    said: Arc<Mutex<String>>,
    title: String,
}

impl Client {
    /// The client process.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Wait for the client to exit, and return whether it exited cleanly.
    ///
    /// Bounded, so a client that never exits fails the test instead of
    /// hanging it.
    pub fn wait_for_exit(&mut self) -> bool {
        let until = Instant::now() + PATIENCE;
        loop {
            match self.child.try_wait().expect("the client is waitable") {
                Some(status) => return status.success(),
                None if Instant::now() >= until => panic!(
                    "the client {:?} was still running after {PATIENCE:?}:\n{}",
                    self.title,
                    self.trace()
                ),
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }

    /// Whether this client is still running, without waiting.
    ///
    /// Tells a closed window apart from a dead client.
    pub fn is_running(&mut self) -> bool {
        self.child
            .try_wait()
            .expect("the client is waitable")
            .is_none()
    }

    /// Wait until the client has finished tracing at least `wanted` lines
    /// matching `pattern`, and return whether it did.
    ///
    /// Bounded, so a missing line fails the test instead of hanging it.
    pub fn wait_for_trace(&mut self, pattern: &str, wanted: usize) -> bool {
        let until = Instant::now() + PATIENCE;
        loop {
            if whole_lines(&self.trace()).matches(pattern).count() >= wanted {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// What the client was told each screen is, one entry per `wl_output`.
    ///
    /// Includes every field a client acts on. Physical size and refresh rate
    /// are included to catch a compositor that invents them.
    pub fn screens(&self) -> Vec<String> {
        let trace = self.trace();
        let mut found: Vec<(String, Screen)> = Vec::new();
        for line in trace.lines() {
            let Some((object, event)) = line.split_once('.') else {
                continue;
            };
            let object = object.trim();
            if !object.contains("wl_output") {
                continue;
            }
            let slot = match found.iter().position(|(id, _)| id == object) {
                Some(at) => at,
                None => {
                    found.push((object.to_string(), Screen::default()));
                    found.len() - 1
                }
            };
            found[slot].1.take(event.trim());
        }
        found.into_iter().map(|(_, screen)| screen.said()).collect()
    }

    /// The screens this client's window is on now, by name. See
    /// [`screens_entered`].
    pub fn on_screens(&self) -> Vec<String> {
        screens_entered(&self.trace())
    }

    /// The screens `surface` (`wl_surface@N`) is on now, by name, for a
    /// client with more than one surface. See [`screens_entered`].
    pub fn surface_on_screens(&self, surface: &str) -> Vec<String> {
        screens_entered_by(&self.trace(), Some(surface))
    }

    /// Whatever the client has traced so far.
    pub fn trace(&self) -> String {
        let said = self.said.lock().expect("nothing panics holding this");
        if said.trim().is_empty() {
            "(it said nothing)".to_string()
        } else {
            said.clone()
        }
    }
}

/// The lines of `trace` the client has finished writing. A line still being
/// written may end before the part a check reads.
fn whole_lines(trace: &str) -> &str {
    trace.rfind('\n').map_or("", |end| &trace[..=end])
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One screen, as the client was told about it.
///
/// Built from the separate `name`, `geometry`, `mode` and `scale` events.
#[derive(Default)]
struct Screen {
    name: Option<String>,
    position: Option<String>,
    scale: Option<String>,
    mode: Option<String>,
    physical: Option<String>,
    refresh: Option<String>,
}

impl Screen {
    /// Apply one traced event to this screen. Unknown events are ignored.
    fn take(&mut self, event: &str) {
        let Some((name, rest)) = event.split_once('(') else {
            return;
        };
        let args: Vec<&str> = rest.trim_end_matches(')').split(", ").collect();
        match (name, args.as_slice()) {
            ("name", [called]) => self.name = Some(called.trim_matches('"').to_string()),
            ("geometry", [x, y, millimeters_wide, millimeters_high, ..]) => {
                self.position = Some(format!("{x},{y}"));
                self.physical = Some(format!("{millimeters_wide}x{millimeters_high}"));
            }
            ("scale", [factor]) => self.scale = Some((*factor).to_string()),
            ("mode", [flags, width, height, refresh]) => {
                self.mode = Some(format!("{width}x{height}({})", Self::flags(flags)));
                self.refresh = Some((*refresh).to_string());
            }
            _ => {}
        }
    }

    /// `wl_output.mode`'s flags, by their protocol names, for readable
    /// failures.
    fn flags(said: &str) -> String {
        // Torn lines never reach here, so a parse failure is a trace format
        // change. Defaulting to 0 would misreport it as a compositor fault.
        let bits: u32 = said
            .parse()
            .expect("the client traces a mode's flags as a number");
        let mut named = Vec::new();
        if bits & 1 != 0 {
            named.push("current");
        }
        if bits & 2 != 0 {
            named.push("preferred");
        }
        if named.is_empty() {
            named.push("none");
        }
        named.join(" ")
    }

    /// This screen on one line, or which field is missing.
    fn said(&self) -> String {
        match (
            &self.name,
            &self.position,
            &self.scale,
            &self.mode,
            &self.physical,
            &self.refresh,
        ) {
            (
                Some(name),
                Some(position),
                Some(scale),
                Some(mode),
                Some(physical),
                Some(refresh),
            ) => format!("{name}@{position}@{scale}={mode} {refresh}mHz {physical}mm"),
            _ => format!(
                "an output described only as name={:?} position={:?} scale={:?} mode={:?} physical={:?} refresh={:?}",
                self.name, self.position, self.scale, self.mode, self.physical, self.refresh
            ),
        }
    }
}

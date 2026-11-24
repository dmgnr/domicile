//! Agents on the web, such as claude.ai: while the config's `agents.web` is
//! set, the desk runs `domicile mcp --relay`, which keeps it reachable
//! through Domicile's relay, and runs it again if it exits. See
//! `docs/AGENTS.md#agents-on-the-web`.

use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tracing::{error, info};

/// The longest it waits before running it again after it exits.
const MOST_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// How often it checks whether `domicile mcp --relay` exited.
const CHECK_EVERY: Duration = Duration::from_millis(500);

/// Makes the command that serves agents on the web.
pub type Serving = Arc<dyn Fn() -> Option<Command> + Send + Sync>;

/// `domicile mcp --relay`, while it should run.
pub struct WebAgents {
    serving: Serving,
    running: Option<Running>,
}

struct Running {
    stopped: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl WebAgents {
    pub fn new(serving: Serving) -> WebAgents {
        WebAgents {
            serving,
            running: None,
        }
    }

    /// Runs it when `on`, and stops it when not.
    pub fn set(&mut self, on: bool) {
        match (on, self.running.take()) {
            (true, None) => {
                info!("serving agents on the web");
                self.running = Some(self.run());
            }
            (false, Some(running)) => {
                info!("no longer serving agents on the web");
                running.stopped.store(true, Ordering::SeqCst);
                if let Some(child) = running.child.lock().unwrap().as_mut() {
                    let _ = child.kill();
                }
            }
            (_, running) => self.running = running,
        }
    }

    fn run(&self) -> Running {
        let stopped = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None::<Child>));
        let (serving, watched_stop, watched) = (
            Arc::clone(&self.serving),
            Arc::clone(&stopped),
            Arc::clone(&child),
        );
        thread::spawn(move || {
            let mut backoff = Duration::from_secs(1);
            while !watched_stop.load(Ordering::SeqCst) {
                let started = Instant::now();
                let spawned = serving()
                    .ok_or_else(|| "there is no command".to_string())
                    .and_then(|mut command| {
                        dies_with_this_thread(&mut command);
                        command.spawn().map_err(|why| why.to_string())
                    });
                match spawned {
                    Ok(spawned) => {
                        *watched.lock().unwrap() = Some(spawned);
                        // Checked now and then, not waited on under the
                        // lock, so `set` can kill it meanwhile.
                        let status = loop {
                            let exited = watched
                                .lock()
                                .unwrap()
                                .as_mut()
                                .map(|child| child.try_wait());
                            match exited {
                                Some(Ok(Some(status))) => break Some(status),
                                Some(Ok(None)) => thread::sleep(CHECK_EVERY),
                                Some(Err(_)) | None => break None,
                            }
                        };
                        watched.lock().unwrap().take();
                        if watched_stop.load(Ordering::SeqCst) {
                            break;
                        }
                        error!(?status, "domicile mcp --relay exited; agents on the web can't reach the desk until it runs again");
                    }
                    Err(why) => {
                        error!(%why, "domicile mcp --relay did not run; agents on the web can't reach the desk");
                    }
                }
                if started.elapsed() > MOST_BACKOFF {
                    backoff = Duration::from_secs(1);
                }
                thread::sleep(backoff);
                backoff = (backoff * 2).min(MOST_BACKOFF);
            }
        });
        Running { stopped, child }
    }
}

/// Has `command` end when the thread that starts it does, as when the
/// compositor crashes: the next one runs its own, and two for one desk would
/// keep taking the relay's connection from each other.
fn dies_with_this_thread(command: &mut Command) {
    // SAFETY: prctl is async-signal-safe, as pre_exec needs.
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

impl Drop for WebAgents {
    fn drop(&mut self) {
        self.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs of a command that notes each run in `file` and lasts `lasting`.
    fn noting(file: &std::path::Path, lasting: &str) -> Serving {
        let (file, lasting) = (file.to_path_buf(), lasting.to_string());
        Arc::new(move || {
            let mut command = Command::new("sh");
            command.arg("-c").arg(format!(
                "echo run >> '{}'; exec sleep {lasting}",
                file.display()
            ));
            Some(command)
        })
    }

    fn runs(file: &std::path::Path) -> usize {
        std::fs::read_to_string(file).map_or(0, |text| text.lines().count())
    }

    fn file(name: &str) -> std::path::PathBuf {
        let file = std::env::temp_dir().join(format!("web-agents-{name}-{}", std::process::id()));
        let _ = std::fs::remove_file(&file);
        file
    }

    #[test]
    fn it_runs_while_on_and_again_when_it_exits() {
        let file = file("again");
        let mut web = WebAgents::new(noting(&file, "0"));
        web.set(true);
        thread::sleep(Duration::from_millis(2500));
        assert!(runs(&file) >= 2, "{}", runs(&file));
        web.set(false);
        thread::sleep(Duration::from_millis(1500));
        let stopped = runs(&file);
        thread::sleep(Duration::from_millis(2500));
        assert_eq!(runs(&file), stopped);
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn turning_it_off_ends_it_and_on_twice_runs_one() {
        let file = file("off");
        let mut web = WebAgents::new(noting(&file, "30"));
        web.set(true);
        web.set(true);
        thread::sleep(Duration::from_millis(500));
        assert_eq!(runs(&file), 1);
        let child = Arc::clone(&web.running.as_ref().unwrap().child);
        web.set(false);
        thread::sleep(Duration::from_millis(1000));
        assert!(child.lock().unwrap().is_none(), "it was reaped");
        assert_eq!(runs(&file), 1);
        let _ = std::fs::remove_file(file);
    }
}

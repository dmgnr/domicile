//! The splash the engine shows while `domicile` builds the shell on first
//! start.
//!
//! The splash is a prebuilt shell, copied into the run's directory so that
//! `progress.json` can sit beside it. The page polls that file. Once the shell
//! is built, the page writes [`ENDED`] when it has been on screen long enough
//! to give way. See `packages/shell-splash`.
//!
//! The file is a contract with the page, which ships in the same install, so
//! it carries no version.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::build_progress::Step;
use crate::shell_path::{Shell, ShellFiles};

/// The file the page polls, in the splash's root.
pub const PROGRESS: &str = "progress.json";

/// The file the page writes when it is ready to give way, in the splash's root.
pub const ENDED: &str = "ended";

/// How often [`the_page_ends`] looks for [`ENDED`].
const LOOK_EVERY: Duration = Duration::from_millis(50);

/// What the page shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Progress<'a> {
    /// The builder has not reported a step yet.
    Starting,
    Resolving,
    Installing {
        packages: &'a [String],
    },
    Bundling,
    /// The shell is built. The page writes `ended` once it has shown that.
    Built {
        ended: &'a Path,
    },
    /// The build failed. `supervisor` is the pid the page stops to log out.
    Failed {
        supervisor: u32,
        why: &'a str,
    },
}

impl<'a> From<&'a Step> for Progress<'a> {
    fn from(step: &'a Step) -> Self {
        match step {
            Step::Resolving => Progress::Resolving,
            Step::Installing(packages) => Progress::Installing { packages },
            Step::Bundling => Progress::Bundling,
        }
    }
}

/// Copies the prebuilt splash at `bundle` into `splash`, beside its progress
/// file.
///
/// A copy, because the install is read-only and the progress file must be
/// inside the root the engine serves.
pub fn lay_out(bundle: &Path, splash: &Path) -> io::Result<Shell> {
    copy_tree(bundle, splash)?;
    Ok(Shell {
        module: PathBuf::from("shell.js"),
        root: splash.to_path_buf(),
        files: ShellFiles::Directory,
    })
}

/// Writes `progress` for the page in `splash`.
///
/// Renamed into place, so the page never reads half a file.
pub fn tell(splash: &Path, progress: &Progress) -> io::Result<()> {
    let staged = splash.join(format!("{PROGRESS}.next"));
    std::fs::write(&staged, serde_json::to_vec(progress)?)?;
    std::fs::rename(&staged, splash.join(PROGRESS))
}

/// Waits up to `within` for the page to write `ended`. Returns whether it did.
pub fn the_page_ends(ended: &Path, within: Duration) -> bool {
    let asked = Instant::now();
    while !ended.exists() && asked.elapsed() < within {
        std::thread::sleep(LOOK_EVERY);
    }
    ended.exists()
}

/// Copies the files under `from` to `to`.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        // `metadata` follows links, since the install's shells are store links.
        match std::fs::metadata(entry.path())?.is_dir() {
            true => copy_tree(&entry.path(), &target)?,
            false => {
                std::fs::copy(entry.path(), &target)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::build_progress::Step;

    fn told(splash: &Path) -> serde_json::Value {
        let text = std::fs::read_to_string(splash.join(PROGRESS)).expect("progress was written");
        serde_json::from_str(&text).expect("progress is JSON")
    }

    #[test]
    fn each_step_reaches_the_page_by_name() {
        let splash = tempfile::tempdir().expect("a temp dir");
        let packages = vec!["react".to_string(), "zod".to_string()];
        for (step, expected) in [
            (Step::Resolving, serde_json::json!({ "state": "resolving" })),
            (
                Step::Installing(packages.clone()),
                serde_json::json!({ "state": "installing", "packages": ["react", "zod"] }),
            ),
            (Step::Bundling, serde_json::json!({ "state": "bundling" })),
        ] {
            tell(splash.path(), &Progress::from(&step)).expect("told");
            assert_eq!(told(splash.path()), expected);
        }
    }

    #[test]
    fn a_failure_names_who_to_stop() {
        let splash = tempfile::tempdir().expect("a temp dir");
        tell(
            splash.path(),
            &Progress::Failed {
                supervisor: 42,
                why: "no Shell export",
            },
        )
        .expect("told");
        assert_eq!(
            told(splash.path()),
            serde_json::json!({ "state": "failed", "supervisor": 42, "why": "no Shell export" })
        );
    }

    #[test]
    fn telling_replaces_the_file_whole() {
        let splash = tempfile::tempdir().expect("a temp dir");
        tell(splash.path(), &Progress::Bundling).expect("told");
        tell(
            splash.path(),
            &Progress::Built {
                ended: Path::new("/run/splash/ended"),
            },
        )
        .expect("told");
        assert_eq!(
            told(splash.path()),
            serde_json::json!({ "state": "built", "ended": "/run/splash/ended" })
        );
        let names: Vec<_> = std::fs::read_dir(splash.path())
            .expect("readable")
            .map(|entry| entry.expect("an entry").file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(PROGRESS)]);
    }

    #[test]
    fn the_ending_is_heard_once_the_page_writes_it() {
        let splash = tempfile::tempdir().expect("a temp dir");
        let ended = splash.path().join(ENDED);
        let writing = ended.clone();
        let page = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::write(writing, "").expect("written");
        });
        assert!(the_page_ends(&ended, Duration::from_secs(5)));
        page.join().expect("the page wrote");
    }

    #[test]
    fn a_page_that_never_ends_is_given_up_on() {
        let splash = tempfile::tempdir().expect("a temp dir");
        assert!(!the_page_ends(
            &splash.path().join(ENDED),
            Duration::from_millis(100)
        ));
    }

    #[test]
    fn laying_out_copies_the_bundle_beside_the_progress() {
        let bundle = tempfile::tempdir().expect("a temp dir");
        std::fs::write(
            bundle.path().join("shell.js"),
            "export const Shell = () => {};",
        )
        .expect("written");
        std::fs::create_dir(bundle.path().join("assets")).expect("made");
        std::fs::write(bundle.path().join("assets/mark.svg"), "<svg/>").expect("written");
        let run = tempfile::tempdir().expect("a temp dir");
        let splash = run.path().join("splash");
        std::fs::create_dir(&splash).expect("made");
        tell(&splash, &Progress::Bundling).expect("told");

        let shell = lay_out(bundle.path(), &splash).expect("laid out");

        assert_eq!(
            shell,
            Shell {
                module: PathBuf::from("shell.js"),
                root: splash.clone(),
                files: ShellFiles::Directory,
            }
        );
        assert_eq!(
            std::fs::read_to_string(splash.join("assets/mark.svg")).expect("copied"),
            "<svg/>"
        );
        assert_eq!(told(&splash), serde_json::json!({ "state": "bundling" }));
    }
}

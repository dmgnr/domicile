//! The thread that builds the launcher's file index and keeps it current.
//!
//! The logic lives in [`domicile_host::file_index`],
//! [`domicile_host::home_walk`] and [`domicile_host::file_changes`]. This
//! module runs them and decides when to republish the index and how long to
//! gather a burst of filesystem events.
//!
//! [`FileIndex`] stays on this thread. Connections answering `search_files`
//! read an immutable [`Offered`] snapshot, so they never wait for a walk.
//!
//! Walking a home directory blocks on disk for seconds, so it runs on its own
//! thread instead of the Wayland event loop.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use domicile_config::Omit;
use domicile_host::file_changes::{changes, Change};
use domicile_host::file_index::FileIndex;
use domicile_host::file_search::FileSearch;
use domicile_host::home_walk::{walk, walk_within, Directory, RealDirectory};
use domicile_host::home_watch::HomeWatcher;
use domicile_host::index_file::{read, write, IndexFileError};
use domicile_host::index_location::index_file;
use tracing::{debug, error, warn};

/// How many walked paths are added to the index at a time. Small enough for an
/// early launcher to fill in gradually, large enough to keep loop overhead low.
const BATCH: usize = 2_000;

/// How often to announce the index while a walk runs.
///
/// Each announcement rebuilds a [`FileSearch`] from the whole list.
const WHILE_BUILDING: Duration = Duration::from_millis(500);

/// How long to gather a burst of filesystem events before announcing.
const SETTLE: Duration = Duration::from_millis(250);

/// How long the on-disk cache may lag the index in memory.
///
/// The cache holds the whole list, so writing it on every change would rewrite
/// megabytes often. Only the next session reads it, and its own walk corrects
/// any drift.
const KEPT_FRESH: Duration = Duration::from_secs(300);

/// The snapshot a launcher's search runs against.
///
/// Pages receive only a query's matches, never the whole index. See
/// `domicile_host::file_search`.
#[derive(Debug)]
pub struct Offered {
    pub search: FileSearch,
    /// Whether the walk is still running. See
    /// `domicile_protocol::HostMessage::FoundFiles`.
    pub indexing: bool,
}

/// A message to the index thread.
///
/// Filesystem events and config changes share one channel so the thread can
/// wait on both.
#[derive(Debug)]
pub enum Heard {
    /// An event from the home directory watch.
    Filesystem(notify::Result<notify::Event>),
    /// A config reload changed `files.omit`, which requires a new walk.
    Omitting(Omit),
}

/// Builds the index, caches it, and keeps it current. Runs on its own thread.
///
/// `omit` is the config's exclusion rule; updates arrive on `heard`. The watch
/// sends events through `told`. `tell` receives each changed [`Offered`].
///
/// Errors below the home (cache, unreadable directories, watch setup) are
/// logged and skipped. Only an unreadable home returns, leaving the launcher
/// with no list instead of a misleading empty one.
pub fn keep_the_index(
    home: PathBuf,
    kept_at: Option<PathBuf>,
    mut omit: Omit,
    (told, heard): (Sender<Heard>, Receiver<Heard>),
    tell: impl Fn(Offered),
) {
    if kept_at.is_none() {
        debug!("nowhere to keep a file index, so every start walks the home");
    }
    let mut index = FileIndex::building(remembered(kept_at.as_deref()));

    loop {
        // Announce the cached list before the walk, so a launcher opened early
        // has rows and shows that indexing is in progress. Skip it if the home
        // cannot be read, or the launcher would show a stale list marked as
        // indexing for the whole session.
        if let Err(err) = fs::read_dir(&home) {
            error!(
                %err, home = %home.display(),
                "the home directory could not be read, so a launcher has \
                 nothing to be offered"
            );
            return;
        }
        announce(&mut index, &tell);

        // The walk watches each directory before reading it, so no file
        // written during the walk is missed. See `domicile_host::home_watch`.
        // Events queue on the unbounded `heard`, and the index is a set, so a
        // path reported by both lands once.
        //
        // Each walk gets a new watcher, so directories a new rule omits stop
        // being watched.
        let watched = watch_the_home(&home, told.clone());
        let walked = match &watched {
            Some(watcher) => {
                let walked = walk_the_home(&home, &omit, watcher, &mut index, &tell);
                report_unwatched(watcher);
                walked
            }
            None => walk_the_home(&home, &omit, &RealDirectory, &mut index, &tell),
        };
        if !walked {
            return;
        }
        // Write the cache once the walk is complete.
        write_it_down(kept_at.as_deref(), &index);
        // Without a watch, the index stays as walked.
        let Some(watcher) = watched else {
            return;
        };

        match hold_it_current(
            &heard,
            &home,
            &omit,
            &watcher,
            kept_at.as_deref(),
            &mut index,
            &tell,
        ) {
            Held::Lost => {
                debug!("the kernel dropped filesystem events, so the home is being walked again");
            }
            Held::Omitting(new) => {
                debug!("the desk's config moved `files.omit`, so the home is being walked again");
                omit = new;
            }
            Held::Ended => return,
        }
        index.rebuilding();
    }
}

/// A watcher for the walk to read the home through, or `None` if it cannot be
/// created.
///
/// Without a watcher the index is still walked but not kept current. The error
/// is logged, not retried, since retrying would not fix the cause.
fn watch_the_home(home: &Path, told: Sender<Heard>) -> Option<HomeWatcher> {
    match HomeWatcher::new(move |event| {
        // Fails only when the index thread has exited at shutdown.
        let _ = told.send(Heard::Filesystem(event));
    }) {
        Ok(watcher) => Some(watcher),
        Err(err) => {
            error!(
                %err, home = %home.display(),
                "the home directory cannot be watched, so what a launcher is \
                 offered is what was there at startup"
            );
            None
        }
    }
}

/// Logs one line for directories that were read but could not be watched.
fn report_unwatched(watcher: &HomeWatcher) {
    if let Some(unwatched) = watcher.unwatched() {
        error!(
            err = %unwatched.first, directories = unwatched.count,
            "directories in the home could not be watched -- check \
             fs.inotify.max_user_watches -- so what a launcher is offered \
             from them is what was there when they were read"
        );
    }
}

/// Fills the index from a walk of the home and announces progress.
///
/// Returns `false` if the home cannot be read. Errors below the home are
/// handled by [`domicile_host::home_walk`].
fn walk_the_home(
    home: &Path,
    omit: &Omit,
    directory: &impl Directory,
    index: &mut FileIndex,
    tell: &impl Fn(Offered),
) -> bool {
    let omitted = |path: &str| omit.omits(path);
    let mut walking = match walk(home, directory, &omitted) {
        Ok(walking) => walking,
        Err(err) => {
            error!(
                %err, home = %home.display(),
                "the home directory could not be read, so a launcher has \
                 nothing to be offered"
            );
            return false;
        }
    };

    let started = Instant::now();
    let mut last_told = Instant::now();
    loop {
        let batch: Vec<String> = walking.by_ref().take(BATCH).collect();
        if batch.is_empty() {
            break;
        }
        index.found(batch);
        // Throttled by time, not per batch. See `WHILE_BUILDING`.
        if last_told.elapsed() >= WHILE_BUILDING {
            announce(index, tell);
            last_told = Instant::now();
        }
    }

    index.built();
    announce(index, tell);
    debug!(
        files = index.files().len(),
        took_ms = started.elapsed().as_millis(),
        "the home directory is indexed"
    );
    true
}

/// The cached list from the last run, or empty if there is no usable cache.
///
/// The cache only fills the launcher during the first seconds of a session,
/// so a missing or corrupt file is logged below `error!`.
fn remembered(kept_at: Option<&Path>) -> Vec<String> {
    let Some(path) = kept_at else {
        return Vec::new();
    };
    match read(path) {
        Ok(files) => {
            debug!(
                files = files.len(),
                "a launcher has last session's list while the home is walked"
            );
            files
        }
        Err(IndexFileError::Missing) => {
            debug!(
                index = %path.display(),
                "nothing written down yet, so a launcher fills in as the home is walked"
            );
            Vec::new()
        }
        Err(err) => {
            error!(
                %err, index = %path.display(),
                "the file index on disk was not usable, so the home is walked from nothing"
            );
            Vec::new()
        }
    }
}

/// Writes the index cache for the next run.
fn write_it_down(kept_at: Option<&Path>, index: &FileIndex) {
    let Some(path) = kept_at else {
        return;
    };
    if let Err(err) = write(path, &index.files()) {
        // Only the next session's first few seconds are affected.
        error!(
            %err, index = %path.display(),
            "the file index could not be written down for the next run"
        );
    }
}

/// Why [`hold_it_current`] returned.
enum Held {
    /// The kernel dropped events, so the home must be walked again.
    Lost,
    /// The config changed `files.omit`.
    Omitting(Omit),
    /// The channel closed at shutdown.
    Ended,
}

/// Applies watch events until the home must be walked again.
fn hold_it_current(
    heard: &Receiver<Heard>,
    home: &Path,
    omit: &Omit,
    watcher: &HomeWatcher,
    kept_at: Option<&Path>,
    index: &mut FileIndex,
    tell: &impl Fn(Offered),
) -> Held {
    let omitted = |path: &str| omit.omits(path);
    let mut written = Instant::now();
    while let Ok(first) = heard.recv() {
        // Gather a burst (a `git checkout` is thousands of events) so the
        // index is announced once, not per file.
        let gathered =
            std::iter::once(first).chain(std::iter::from_fn(|| heard.recv_timeout(SETTLE).ok()));

        let mut rescan = false;
        let mut omitting = None;
        for heard in gathered {
            match heard {
                // Applied after the burst, since the burst's events are still
                // valid and the new walk starts from this index.
                Heard::Omitting(new) => omitting = Some(new),
                Heard::Filesystem(Ok(event)) => {
                    rescan |= event.need_rescan();
                    for change in changes(&event, home, &omitted) {
                        match change {
                            Change::Appeared(path) => {
                                appeared(index, home, watcher, &omitted, path)
                            }
                            Change::Vanished(path) => index.vanished(&path),
                        }
                    }
                }
                // For example a directory removed mid-read. The watch
                // survives, and the next walk corrects the index.
                Heard::Filesystem(Err(err)) => {
                    warn!(%err, "a filesystem watch reported a problem");
                }
            }
        }

        report_unwatched(watcher);
        announce(index, tell);
        // Refresh the cache so a long session does not leave it stale. See
        // `KEPT_FRESH`.
        if written.elapsed() >= KEPT_FRESH {
            write_it_down(kept_at, index);
            written = Instant::now();
        }
        if let Some(new) = omitting {
            return Held::Omitting(new);
        }
        if rescan {
            return Held::Lost;
        }
    }
    Held::Ended
}

/// Adds a new path and, for a directory, everything already inside it.
///
/// inotify watches directories, not trees, so files created in a new directory
/// before it is watched send no events (`mkdir -p a/b && touch a/b/c`, or a
/// `mv` of a populated tree). A new directory is therefore walked through the
/// watcher, which also watches it. Symlinks are not followed, matching the
/// boot walk.
fn appeared(
    index: &mut FileIndex,
    home: &Path,
    watcher: &HomeWatcher,
    omitted: &impl Fn(&str) -> bool,
    path: String,
) {
    let directory = fs::symlink_metadata(home.join(&path)).is_ok_and(|found| found.is_dir());
    if directory {
        if let Ok(inside) = walk_within(home, &path, watcher, omitted) {
            index.found(inside);
        }
    }
    index.appeared(path);
}

/// Sends a new [`Offered`] if the index changed since the last one.
///
/// Most filesystem events change nothing visible, and each announcement
/// rebuilds the search from the whole list.
fn announce(index: &mut FileIndex, tell: &impl Fn(Offered)) {
    if index.changed() {
        tell(Offered {
            search: FileSearch::new(index.files()),
            indexing: index.indexing(),
        });
    }
}

/// The index cache path, from the process environment.
pub fn kept_at() -> Option<PathBuf> {
    index_file(&|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::Path;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::thread;
    use std::time::Duration;

    use domicile_config::Omit;

    use super::{keep_the_index, Heard};

    /// Timeout for an expected announcement.
    ///
    /// Generous because the tests use real inotify and [`super::SETTLE`] on a
    /// machine that may be running every other check.
    const ANNOUNCED_WITHIN: Duration = Duration::from_secs(10);

    /// How long a quiet index must stay silent to count as settled. Longer than
    /// [`super::SETTLE`] and the largest walk below.
    const SETTLED: Duration = Duration::from_secs(3);

    /// More rows than any test home has, so nothing is truncated.
    const EVERY_ROW: usize = 100;

    #[test]
    fn the_index_says_it_is_building_before_it_walks_the_home() {
        // The first announcement precedes the walk, so a path created while it
        // is held still appears in the walk's result.
        let home = tempfile::tempdir().expect("a home to lay out");
        fs::create_dir(home.path().join("Notes")).expect("the directory");
        fs::write(home.path().join("Notes/today.org"), "").expect("the file");
        let (announcements, go_on) = keeping(home.path());

        let (seeded, indexing) = next(&announcements);
        assert!(indexing, "a walk that has not ended is still indexing");
        assert!(
            seeded.is_empty(),
            "nothing is written down for this home to start from, so the first \
             announcement is an empty seed: {seeded:?}"
        );
        fs::create_dir(home.path().join("Early")).expect("the directory");
        fs::write(home.path().join("Early/plan.org"), "").expect("the file");
        go_on.send(()).expect("the walk goes on");

        assert_eq!(
            walked(&announcements, &go_on),
            ["Early/", "Notes/", "Early/plan.org", "Notes/today.org"],
            "the walk read the home after the index said it was building"
        );
    }

    #[test]
    fn a_file_written_while_the_home_is_walked_is_still_offered() {
        // A file created after the walk's last announcement can only be found
        // by a watch set up during the walk.
        let home = tempfile::tempdir().expect("a home to lay out");
        fs::create_dir(home.path().join("Notes")).expect("the directory");
        fs::write(home.path().join("Notes/today.org"), "").expect("the file");
        let (announcements, go_on) = keeping(home.path());

        let mut last = walked(&announcements, &go_on);
        // The directory is its own row, so check it appears too.
        fs::create_dir(home.path().join("Late")).expect("the directory");
        fs::write(home.path().join("Late/plan.org"), "").expect("the file");
        go_on.send(()).expect("the index goes on");

        let expected = ["Late/", "Notes/", "Late/plan.org", "Notes/today.org"];
        while last != expected {
            last = next(&announcements).0;
            let _ = go_on.send(());
        }
    }

    #[test]
    fn a_home_of_more_directories_than_the_kernel_queues_events_for_is_indexed_once() {
        // If the watch reported directory opens, walking more directories than
        // `max_queued_events` would overflow the queue, and each overflow
        // would trigger another walk forever.
        let queued: usize = fs::read_to_string("/proc/sys/fs/inotify/max_queued_events")
            .expect("the kernel's bound on queued inotify events")
            .trim()
            .parse()
            .expect("a count");
        let home = tempfile::tempdir().expect("a home to lay out");
        for directory in 0..=queued {
            fs::create_dir(home.path().join(directory.to_string())).expect("the directory");
        }
        let (announcements, go_on) = keeping(home.path());

        walked(&announcements, &go_on);
        go_on.send(()).expect("the index goes on");

        if let Ok((_, indexing)) = announcements.recv_timeout(SETTLED) {
            panic!("the index announced again after its walk ended (indexing: {indexing})");
        }
    }

    #[test]
    fn a_directory_that_appears_after_the_walk_is_watched_too() {
        // A new directory is walked when it appears, and that walk watches it.
        let home = tempfile::tempdir().expect("a home to lay out");
        let (announcements, go_on) = keeping(home.path());

        walked(&announcements, &go_on);
        fs::create_dir(home.path().join("Late")).expect("the directory");
        go_on.send(()).expect("the index goes on");
        until(&announcements, &go_on, "Late");
        fs::write(home.path().join("Late/plan.org"), "").expect("the file");
        go_on.send(()).expect("the index goes on");

        until(&announcements, &go_on, "Late/plan.org");
    }

    #[test]
    fn a_link_that_appears_after_the_walk_is_offered_but_not_followed() {
        // Matches the boot walk. See `domicile_host::home_walk`.
        let home = tempfile::tempdir().expect("a home to lay out");
        let elsewhere = tempfile::tempdir().expect("a directory outside the home");
        fs::write(elsewhere.path().join("inside.txt"), "").expect("the file");
        let (announcements, go_on) = keeping(home.path());

        walked(&announcements, &go_on);
        symlink(elsewhere.path(), home.path().join("result")).expect("the link");
        // Written after the link, so the link is indexed by the time this is.
        fs::write(home.path().join("after.txt"), "").expect("the file");
        go_on.send(()).expect("the index goes on");

        assert_eq!(
            until(&announcements, &go_on, "after.txt"),
            ["after.txt", "result"]
        );
    }

    /// Announcements (files, indexing) and the sender that resumes the index.
    type Keeping = (Receiver<(Vec<String>, bool)>, Sender<()>);

    /// Runs the index of `home` on a thread that blocks after each
    /// announcement until the test resumes it, so tests control timing.
    fn keeping(home: &Path) -> Keeping {
        let (announced, announcements) = channel();
        let (go_on, resumed) = channel();
        let (told, heard) = channel::<Heard>();
        let home = home.to_path_buf();
        thread::spawn(move || {
            keep_the_index(home, None, Omit::default(), (told, heard), move |offered| {
                // Both fail only after the test has ended.
                let _ =
                    announced.send((offered.search.find("", EVERY_ROW).files, offered.indexing));
                let _ = resumed.recv();
            });
        });
        (announcements, go_on)
    }

    /// The next announcement. The index blocks until resumed.
    fn next(announcements: &Receiver<(Vec<String>, bool)>) -> (Vec<String>, bool) {
        announcements
            .recv_timeout(ANNOUNCED_WITHIN)
            .unwrap_or_else(|_| panic!("the index announced nothing within {ANNOUNCED_WITHIN:?}"))
    }

    /// The first announcement that includes `path`. The index blocks there.
    fn until(
        announcements: &Receiver<(Vec<String>, bool)>,
        go_on: &Sender<()>,
        path: &str,
    ) -> Vec<String> {
        loop {
            let (files, _) = next(announcements);
            if files.iter().any(|file| file == path) {
                return files;
            }
            let _ = go_on.send(());
        }
    }

    /// The walk's final announcement. The index blocks there.
    fn walked(announcements: &Receiver<(Vec<String>, bool)>, go_on: &Sender<()>) -> Vec<String> {
        loop {
            let (files, indexing) = next(announcements);
            if !indexing {
                return files;
            }
            let _ = go_on.send(());
        }
    }
}

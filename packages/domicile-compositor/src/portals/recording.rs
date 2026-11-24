//! The shell's own screen recording, as `SystemRequest::ScreenRecord`
//! describes.
//!
//! The shell picks one source in the screen cast picker, as itself. Its
//! stream, with the pointer drawn in, goes to `domicile-recorder`, which
//! encodes it and the stream's sound into a WebM in the videos folder. The
//! recording is listed as a [`CapturingKind::Recording`] until the shell
//! stops or discards it, its source goes, or the recorder fails. The shell
//! pauses and resumes it meanwhile.
//!
//! See `docs/PORTALS.md`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use domicile_host::fresh_file::fresh_file;
use domicile_host::recording::{file_name, recordings_dir, Timer};
use domicile_protocol::{
    Captured, CapturingKind, PortalAnswer, SystemError, SystemErrorKind, SHELL_APP_ID,
};
use tracing::debug;

use super::queue::{ask_unbidden, Queue};
use super::screencast::{captured, chosen, dialog, preview, Selected};
use super::screenshot::{now, user_dirs, Shoot};
use crate::casting::{Candidate, Casting, CursorMode, Event, Source, StreamId};
use crate::reply::reply;

/// The recorder's binary, beside the compositor's.
const RECORDER: &str = "domicile-recorder";

/// The most pixels a recorded monitor or region has: 4K's. The recorder
/// encodes on the CPU, which keeps up with this many at full frame rate but
/// not with a whole desk of high-density monitors.
const MOST_PIXELS: u64 = 3840 * 2160;

/// What a recording needs from the rest of the compositor.
#[derive(Clone)]
pub struct Recordings {
    pub casting: Casting,
    /// Takes the frame of the desk the picker previews sources on.
    pub shoot: Shoot,
    /// Makes a new, empty file to record into, and returns its path.
    pub file: Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync>,
    pub start: StartRecorder,
    /// The time now, in milliseconds since the Unix epoch.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// What a recorder records: a stream's video node, the sound node that
/// carries its sound, if it has one, and the file it records into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub video: u32,
    pub sound: Option<String>,
    pub file: PathBuf,
}

/// Starts a recorder of [`Recorded`], once it records. [`Died`] hears why,
/// if it stops before it is finished.
pub type StartRecorder =
    Arc<dyn Fn(&Recorded, Died) -> Result<Box<dyn Recorder>, String> + Send + Sync>;

/// Hears why a recorder stopped by itself.
pub type Died = Box<dyn FnOnce(String) + Send>;

/// A running recorder.
pub trait Recorder: Send {
    /// Stop recording, and go on from there on [`Recorder::resume`].
    fn pause(&mut self) -> Result<(), String>;
    fn resume(&mut self) -> Result<(), String>;
    /// End the file and wait for the recorder to go.
    fn finish(self: Box<Self>) -> Result<(), String>;
}

/// What a recording hears while it runs.
enum Heard {
    /// The shell's pause, resume, stop or discard.
    Control(PortalAnswer),
    /// The source's stream ended.
    CastEnded,
    /// The recorder stopped by itself, and why.
    RecorderDied(String),
}

/// Records what the shell picks until the shell stops it, and returns the
/// file. Blocks until then, the dialog included.
pub fn for_the_shell(queue: &Queue, recordings: &Recordings) -> Result<PathBuf, SystemError> {
    let selected = Selected::one_of_anything();
    let (open, desk) = zbus::block_on(async {
        (
            recordings.casting.list().await,
            preview(&recordings.shoot).await,
        )
    });
    let open = open.ok_or_else(|| other("the windows could not be listed".into()))?;
    let kind = dialog(&selected, &open, desk);
    let answer = zbus::block_on(ask_unbidden(queue, SHELL_APP_ID.into(), "", kind));
    let picked = match answer {
        PortalAnswer::ScreenCast { sources } => match chosen(&sources, &open, &selected) {
            Some(picked) => picked,
            None => return Err(other(format!("{sources:?} cannot be recorded"))),
        },
        PortalAnswer::Canceled => return Err(canceled("the recording dialog was dismissed")),
        answer => {
            return Err(other(format!(
                "the recording dialog was not answered: {answer:?}"
            )))
        }
    };
    let [candidate] = picked.as_slice() else {
        panic!("one source is picked for a recording, not {picked:?}");
    };
    let screens: Vec<Candidate> = open
        .iter()
        .filter(|candidate| matches!(candidate.source, Source::Monitor(_)))
        .cloned()
        .collect();
    let source = captured(candidate, &screens);
    let (heard, hearing) = channel();
    let (stream, video, sound) = cast(&recordings.casting, candidate, heard.clone())?;
    let file = match (recordings.file)() {
        Ok(file) => file,
        Err(why) => {
            recordings.casting.stop(stream);
            return Err(other(format!(
                "no file could be made to record into: {why}"
            )));
        }
    };
    let recorded = Recorded { video, sound, file };
    let mut recorder = match (recordings.start)(&recorded, {
        let heard = heard.clone();
        Box::new(move |why| {
            let _ = heard.send(Heard::RecorderDied(why));
        })
    }) {
        Ok(recorder) => recorder,
        Err(why) => {
            recordings.casting.stop(stream);
            let _ = std::fs::remove_file(&recorded.file);
            return Err(other(format!("the recorder did not start: {why}")));
        }
    };
    let mut timer = Timer::started((recordings.clock)());
    let id = queue.begin_controlled(SHELL_APP_ID.into(), listed(&source, &recorded, timer), {
        let heard = Mutex::new(heard);
        move |answer| {
            let _ = heard.lock().unwrap().send(Heard::Control(answer.clone()));
        }
    });
    debug!(file = %recorded.file.display(), "recording the screen");
    let over = loop {
        let heard = hearing
            .recv()
            .expect("the session's controller lives while it is listed");
        timer = match heard {
            Heard::Control(PortalAnswer::Pause) => {
                if let Err(why) = recorder.pause() {
                    tracing::error!(%why, "the recording did not pause");
                    continue;
                }
                timer.paused((recordings.clock)())
            }
            Heard::Control(PortalAnswer::Resume) => {
                if let Err(why) = recorder.resume() {
                    tracing::error!(%why, "the recording did not resume");
                    continue;
                }
                timer.resumed((recordings.clock)())
            }
            heard => break heard,
        };
        // Gone already when the shell stopped it meanwhile; its stop follows.
        let _ = queue.revise_session(id, |kind| *kind = listed(&source, &recorded, timer));
    };
    queue.end(id);
    // Before the stream stops, so the recorder ends the file on what it has.
    let finished = recorder.finish();
    recordings.casting.stop(stream);
    match over {
        Heard::Control(PortalAnswer::Stop) | Heard::CastEnded => finished
            .map(|()| recorded.file.clone())
            .map_err(|why| other(format!("the recording did not finish: {why}"))),
        Heard::Control(PortalAnswer::Discard) => {
            std::fs::remove_file(&recorded.file)
                .map_err(|why| other(format!("the recording could not be deleted: {why}")))?;
            Err(canceled("the recording was discarded"))
        }
        Heard::RecorderDied(why) => Err(other(format!("the recording failed: {why}"))),
        Heard::Control(answer) => {
            unreachable!("only a recording's controls reach it, not {answer:?}")
        }
    }
}

/// Start a stream of `candidate`, with the pointer drawn in, and wait for
/// its video node and its sound node's name. `heard` hears it end.
fn cast(
    casting: &Casting,
    candidate: &Candidate,
    heard: Sender<Heard>,
) -> Result<(StreamId, u32, Option<String>), SystemError> {
    let (ready, nodes) = reply();
    let mut ready = Some(ready);
    let stream = casting.start_at_most(
        candidate.source.clone(),
        candidate.part,
        Some(MOST_PIXELS),
        CursorMode::Embedded,
        |_| {
            Box::new(move |event| match event {
                Event::Ready { node, sound } => {
                    if let Some(ready) = ready.take() {
                        ready.send((node, sound));
                    }
                }
                Event::Ended(why) => {
                    debug!(?why, "a screen recording's stream ended");
                    // Dropping `ready` unsent fails a stream that never
                    // started.
                    ready = None;
                    let _ = heard.send(Heard::CastEnded);
                }
            })
        },
    );
    match zbus::block_on(nodes) {
        Some((video, sound)) => Ok((stream, video, sound)),
        None => Err(other(format!("{:?} could not be cast", candidate.source))),
    }
}

/// The shell's listing of a recording of `candidate`.
fn listed(source: &Captured, recorded: &Recorded, timer: Timer) -> CapturingKind {
    CapturingKind::Recording {
        sources: vec![source.clone()],
        file: recorded.file.display().to_string(),
        recorded_ms: timer.recorded_ms,
        running_since_ms: timer.running_since_ms,
    }
}

/// [`Recordings::file`] into `Screen recordings` in the videos folder, named
/// for the local time.
pub fn in_videos() -> Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync> {
    Arc::new(|| {
        let (user_dirs, home) = user_dirs();
        fresh_file(
            &recordings_dir(user_dirs.as_deref(), &home),
            &file_name(now()),
            "webm",
        )
        .map(|(path, _)| path)
        .map_err(|why| why.to_string())
    })
}

/// [`Recordings::clock`] from the system's.
pub fn system_clock() -> Arc<dyn Fn() -> u64 + Send + Sync> {
    Arc::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is past 1970")
            .as_millis() as u64
    })
}

/// [`Recordings::start`] running `domicile-recorder` from beside the
/// compositor, or from the `PATH` when it is not there.
pub fn beside_the_compositor() -> StartRecorder {
    Arc::new(|recorded, died| {
        let binary = std::env::current_exe()
            .ok()
            .and_then(|exe| Some(exe.parent()?.join(RECORDER)))
            .filter(|binary| binary.exists())
            .unwrap_or_else(|| PathBuf::from(RECORDER));
        let mut command = Command::new(&binary);
        command.arg("--video").arg(recorded.video.to_string());
        if let Some(sound) = &recorded.sound {
            command.arg("--sound").arg(sound);
        }
        let mut child = command
            .arg(&recorded.file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|why| format!("{} did not run: {why}", binary.display()))?;
        let stdin = child.stdin.take().expect("its stdin is piped");
        let mut lines = BufReader::new(child.stdout.take().expect("its stdout is piped")).lines();
        // It says so once its pipeline plays, or exits saying why not.
        match lines
            .next()
            .and_then(Result::ok)
            .as_deref()
            .and_then(started)
        {
            Some(encoder) => debug!(encoder, "the recorder started"),
            None => {
                return Err(match child.wait() {
                    Ok(status) => format!("it {status}"),
                    Err(why) => why.to_string(),
                })
            }
        }
        thread::spawn(move || {
            lines.for_each(drop);
            died("the recorder exited".into());
        });
        Ok(Box::new(Process { child, stdin }) as Box<dyn Recorder>)
    })
}

/// The encoder the recorder's first line names, when it is the line saying
/// it started: `recording with <encoder>`.
fn started(line: &str) -> Option<&str> {
    line.strip_prefix("recording with ")
}

/// `domicile-recorder`, which takes its commands on stdin.
struct Process {
    child: Child,
    stdin: ChildStdin,
}

impl Process {
    fn tell(&mut self, command: &str) -> Result<(), String> {
        writeln!(self.stdin, "{command}").map_err(|why| why.to_string())
    }
}

impl Recorder for Process {
    fn pause(&mut self) -> Result<(), String> {
        self.tell("pause")
    }

    fn resume(&mut self) -> Result<(), String> {
        self.tell("resume")
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        // Already gone when it failed; `wait` says how.
        let _ = self.tell("stop");
        let Process { mut child, stdin } = *self;
        drop(stdin);
        match child.wait() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("the recorder {status}")),
            Err(why) => Err(why.to_string()),
        }
    }
}

fn other(why: String) -> SystemError {
    SystemError {
        kind: SystemErrorKind::Other,
        message: why,
    }
}

fn canceled(why: &str) -> SystemError {
    SystemError {
        kind: SystemErrorKind::Canceled,
        message: why.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::Receiver;
    use std::time::Duration;

    use domicile_protocol::{
        Captured, CapturedMonitor, Capturing, CastPick, CastSource, PortalKind, PortalRequest,
        ScreenCastDialog,
    };
    use smithay::reexports::calloop::channel::{channel as calloop_channel, Event as Arrived};
    use smithay::reexports::calloop::EventLoop;

    use crate::casting::{Ended, Region, Request};
    use crate::portals::screenshot::Shots;

    const WAIT: Duration = Duration::from_secs(10);

    #[test]
    fn the_recorder_says_it_started_with_its_encoder() {
        assert_eq!(started("recording with Gpu(Av1)"), Some("Gpu(Av1)"));
        assert_eq!(started("recording"), None);
        assert_eq!(started("no VA-API"), None);
    }

    /// A recording on another thread, and what it did.
    struct Recording {
        done: thread::JoinHandle<Result<PathBuf, SystemError>>,
        queue: Arc<Queue>,
        published: Receiver<(Vec<PortalRequest>, Vec<Capturing>)>,
        /// What the Wayland thread started and stopped, and the recorder did.
        did: Receiver<String>,
        /// Ends the stream, as when its window closes.
        end_cast: Sender<()>,
        /// Kills the recorder.
        kill: Arc<Mutex<Option<Died>>>,
        clock: Arc<AtomicU64>,
        folder: tempfile::TempDir,
    }

    impl Recording {
        /// The picker the shell was asked.
        fn asked(&self) -> PortalRequest {
            loop {
                let (items, _) = self.published.recv_timeout(WAIT).expect("published");
                if let Some(asked) = items.into_iter().next() {
                    return asked;
                }
            }
        }

        /// Pick `pick` in the picker.
        fn pick(&self, pick: CastPick) {
            let asked = self.asked();
            self.queue.answer(
                asked.id,
                PortalAnswer::ScreenCast {
                    sources: vec![pick],
                },
            );
        }

        /// The next listing of the recording.
        fn listed(&self) -> Capturing {
            loop {
                let (_, capturing) = self.published.recv_timeout(WAIT).expect("published");
                if let Some(listed) = capturing.into_iter().next() {
                    return listed;
                }
            }
        }

        /// Wait for the recording to be listed with `timer`, as
        /// `(recorded_ms, running_since_ms)`.
        fn lists(&self, timer: (u64, Option<u64>)) {
            loop {
                if let CapturingKind::Recording {
                    recorded_ms,
                    running_since_ms,
                    ..
                } = self.listed().kind
                {
                    if (recorded_ms, running_since_ms) == timer {
                        return;
                    }
                }
            }
        }

        fn did(&self) -> String {
            self.did.recv_timeout(WAIT).expect("something done")
        }

        fn done(
            self,
        ) -> (
            Result<PathBuf, SystemError>,
            Receiver<String>,
            tempfile::TempDir,
        ) {
            (self.done.join().expect("returned"), self.did, self.folder)
        }
    }

    /// The shell's recording, over two windows and two monitors, recorded
    /// into a temporary folder by a recorder that starts unless `refuse`.
    fn recording(refuse: bool) -> Recording {
        let queue = Arc::<Queue>::default();
        let (publish, published) = channel();
        queue.listen(
            move |items, capturing| {
                let _ = publish.send((items, capturing));
            },
            || true,
            |_| None,
        );
        let (did_send, did) = channel();
        let (casting, end_cast) = wayland_thread(did_send.clone());
        let folder = tempfile::tempdir().expect("a temporary folder");
        let kill = Arc::new(Mutex::new(None));
        let clock = Arc::new(AtomicU64::new(1_000));
        let recordings = Recordings {
            casting,
            shoot: Shots::none().shoot,
            file: {
                let dir = folder.path().to_path_buf();
                Arc::new(move || {
                    fresh_file(&dir, "Screen recording", "webm")
                        .map(|(path, _)| path)
                        .map_err(|why| why.to_string())
                })
            },
            start: {
                let kill = Arc::clone(&kill);
                Arc::new(move |recorded: &Recorded, died| {
                    let _ = did_send.send(format!("record {recorded:?}"));
                    if refuse {
                        return Err("no encoder".into());
                    }
                    *kill.lock().unwrap() = Some(died);
                    Ok(Box::new(FakeRecorder(did_send.clone())) as Box<dyn Recorder>)
                })
            },
            clock: {
                let clock = Arc::clone(&clock);
                Arc::new(move || clock.load(Ordering::SeqCst))
            },
        };
        let done = {
            let queue = Arc::clone(&queue);
            thread::spawn(move || for_the_shell(&queue, &recordings))
        };
        Recording {
            done,
            queue,
            published,
            did,
            end_cast,
            kill,
            clock,
            folder,
        }
    }

    struct FakeRecorder(Sender<String>);

    impl Recorder for FakeRecorder {
        fn pause(&mut self) -> Result<(), String> {
            let _ = self.0.send("pause".into());
            Ok(())
        }

        fn resume(&mut self) -> Result<(), String> {
            let _ = self.0.send("resume".into());
            Ok(())
        }

        fn finish(self: Box<Self>) -> Result<(), String> {
            let _ = self.0.send("finish".into());
            Ok(())
        }
    }

    /// A stand-in for the Wayland thread: lists the windows and monitors,
    /// makes each stream ready at once with the desk's sound, reports what it
    /// starts and stops to `did`, and ends the streams when told to.
    fn wayland_thread(did: Sender<String>) -> (Casting, Sender<()>) {
        let (requests, arrived) = calloop_channel::<Request>();
        let (end_cast, ending) = channel::<()>();
        thread::spawn(move || {
            let mut event_loop = EventLoop::<bool>::try_new().expect("a loop");
            let listeners = Arc::new(Mutex::new(HashMap::new()));
            event_loop
                .handle()
                .insert_source(arrived, {
                    let listeners = Arc::clone(&listeners);
                    move |event, _, open| match event {
                        Arrived::Msg(Request::List { reply }) => reply.send(candidates()),
                        Arrived::Msg(Request::Start {
                            stream,
                            source,
                            most_pixels,
                            cursor,
                            mut listener,
                            ..
                        }) => {
                            let _ = did.send(format!(
                                "start {source:?} {cursor:?} at most {most_pixels:?}"
                            ));
                            listener(Event::Ready {
                                node: 42,
                                sound: Some("domicile-sound-desk".into()),
                            });
                            listeners.lock().unwrap().insert(stream, listener);
                        }
                        Arrived::Msg(Request::Stop { stream }) => {
                            let _ = did.send("stop".to_string());
                            if let Some(mut listener) = listeners.lock().unwrap().remove(&stream) {
                                listener(Event::Ended(Ended::Stopped));
                            }
                        }
                        Arrived::Msg(Request::Shoot { developed, .. }) => {
                            developed(Err("no desk here".into()));
                        }
                        Arrived::Msg(
                            Request::ShootWindow { developed, .. }
                            | Request::ShootBrowserWindow { developed, .. },
                        ) => {
                            developed(Err("no windows here".into()));
                        }
                        Arrived::Closed => *open = false,
                    }
                })
                .expect("a channel source");
            let mut open = true;
            while open {
                event_loop
                    .dispatch(Duration::from_millis(20), &mut open)
                    .expect("dispatched");
                if ending.try_recv().is_ok() {
                    for (_, mut listener) in listeners.lock().unwrap().drain() {
                        listener(Event::Ended(Ended::SourceGone));
                    }
                }
            }
        });
        (Casting::new(requests), end_cast)
    }

    fn candidates() -> Vec<Candidate> {
        vec![
            Candidate {
                source: Source::Window("app-3".into()),
                title: "Notes".into(),
                app_id: "org.gnome.TextEditor".into(),
                process: None,
                part: None,
                bounds: None,
            },
            Candidate {
                source: Source::Monitor("drm-1".into()),
                title: "BOE NE135A1M-NY1".into(),
                app_id: String::new(),
                process: None,
                part: None,
                bounds: Some(Region {
                    position: (0, 0),
                    size: (1920, 1080),
                }),
            },
        ]
    }

    fn monitor() -> CastPick {
        CastPick::Monitor {
            name: "drm-1".into(),
        }
    }

    #[test]
    fn the_shell_picks_one_source_of_any_kind_as_itself() {
        let recording = recording(false);

        let asked = recording.asked();

        assert_eq!(asked.app_id, SHELL_APP_ID);
        assert_eq!(
            asked.kind,
            PortalKind::ScreenCast(ScreenCastDialog {
                multiple: false,
                sources: vec![
                    CastSource::Window {
                        id: "app-3".into(),
                        title: "Notes".into(),
                        app_id: "org.gnome.TextEditor".into(),
                    },
                    CastSource::Monitor {
                        name: "drm-1".into(),
                        description: "BOE NE135A1M-NY1".into(),
                        size: (1920, 1080),
                    },
                ],
                region: true,
                browser_windows: true,
                desk: None,
            })
        );
        recording.queue.answer(asked.id, PortalAnswer::Canceled);
        let (done, did, _folder) = recording.done();
        assert_eq!(done.map_err(|why| why.kind), Err(SystemErrorKind::Canceled));
        assert!(did.try_recv().is_err(), "nothing was cast");
    }

    #[test]
    fn the_pick_is_recorded_with_its_sound_until_the_shell_stops_it() {
        let recording = recording(false);
        recording.pick(monitor());

        assert_eq!(
            recording.did(),
            "start Monitor(\"drm-1\") Embedded at most Some(8294400)"
        );
        let file = recording.folder.path().join("Screen recording.webm");
        assert_eq!(
            recording.did(),
            format!(
                "record {:?}",
                Recorded {
                    video: 42,
                    sound: Some("domicile-sound-desk".into()),
                    file: file.clone(),
                }
            )
        );
        let listed = recording.listed();
        assert_eq!(listed.app_id, SHELL_APP_ID);
        assert_eq!(
            listed.kind,
            CapturingKind::Recording {
                sources: vec![Captured::Monitor(CapturedMonitor {
                    name: "drm-1".into(),
                    description: "BOE NE135A1M-NY1".into(),
                })],
                file: file.display().to_string(),
                recorded_ms: 0,
                running_since_ms: Some(1_000),
            }
        );

        recording.queue.answer(listed.id, PortalAnswer::Stop);

        assert_eq!(recording.did(), "finish");
        assert_eq!(recording.did(), "stop");
        let (done, _, _folder) = recording.done();
        assert_eq!(done, Ok(file));
    }

    #[test]
    fn a_pause_stops_the_timer_and_a_resume_runs_it_on() {
        let recording = recording(false);
        recording.pick(monitor());
        let id = recording.listed().id;
        recording.did();
        recording.did();

        recording.clock.store(3_500, Ordering::SeqCst);
        recording.queue.answer(id, PortalAnswer::Pause);
        assert_eq!(recording.did(), "pause");
        recording.lists((2_500, None));

        recording.clock.store(9_000, Ordering::SeqCst);
        recording.queue.answer(id, PortalAnswer::Resume);
        assert_eq!(recording.did(), "resume");
        recording.lists((2_500, Some(9_000)));

        recording.queue.answer(id, PortalAnswer::Stop);
        assert!(recording.done().0.is_ok());
    }

    #[test]
    fn a_discarded_recording_is_deleted() {
        let recording = recording(false);
        recording.pick(monitor());
        let listed = recording.listed();

        recording.queue.answer(listed.id, PortalAnswer::Discard);

        let (done, _, folder) = recording.done();
        assert_eq!(done.map_err(|why| why.kind), Err(SystemErrorKind::Canceled));
        assert!(!folder.path().join("Screen recording.webm").exists());
    }

    /// As when the window recorded closes: what was recorded is kept.
    #[test]
    fn a_recording_whose_source_goes_keeps_what_it_recorded() {
        let recording = recording(false);
        recording.pick(CastPick::Window {
            id: "app-3".into(),
            area: None,
        });
        recording.listed();

        recording
            .end_cast
            .send(())
            .expect("the Wayland thread runs");

        let file = recording.folder.path().join("Screen recording.webm");
        let (done, did, _folder) = recording.done();
        assert_eq!(done, Ok(file));
        assert!(did.iter().any(|did| did == "finish"));
    }

    #[test]
    fn a_recorder_that_dies_fails_the_recording_and_stops_the_stream() {
        let recording = recording(false);
        recording.pick(monitor());
        let listed = recording.listed();

        let died = recording.kill.lock().unwrap().take().expect("recording");
        died("out of disk".into());

        let (done, did, _folder) = recording.done();
        assert_eq!(
            done.map_err(|why| (why.kind, why.message)),
            Err((
                SystemErrorKind::Other,
                "the recording failed: out of disk".into()
            ))
        );
        assert!(did.iter().any(|did| did == "stop"));
        assert_ne!(listed.id, 0);
    }

    #[test]
    fn a_recorder_that_does_not_start_leaves_no_file_or_stream() {
        let recording = recording(true);
        recording.pick(monitor());

        let (done, did, folder) = recording.done();
        assert_eq!(done.map_err(|why| why.kind), Err(SystemErrorKind::Other));
        assert!(did.iter().any(|did| did == "stop"));
        assert!(!folder.path().join("Screen recording.webm").exists());
    }
}

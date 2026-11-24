//! `domicile trace <file>`: records the engine's trace events with Perfetto.
//!
//! The engine reports to a Perfetto service on [`producer_socket`] (see
//! `crate::spawn::engine`). Nothing listens there until `domicile trace`
//! starts `traced` on it, records with `perfetto`, and stops `traced`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::spawn::Spawn;

/// How long `domicile trace` waits for the engine's processes after starting
/// the service. The browser process attaches at once. The sandboxed ones
/// (GPU, renderers) retry through it, at most every 30 s.
pub const ATTACH_WITHIN: Duration = Duration::from_secs(31);

/// The variable naming the socket Perfetto's producers dial.
pub const PRODUCER_VARIABLE: &str = "PERFETTO_PRODUCER_SOCK_NAME";

const CONSUMER_VARIABLE: &str = "PERFETTO_CONSUMER_SOCK_NAME";

/// The trace categories: frame production in the shell and pages, the
/// display compositor, the GPU, page flips, and the DevTools frame timeline.
const CATEGORIES: [&str; 12] = [
    "toplevel",
    "benchmark",
    "input",
    "cc",
    "viz",
    "gpu",
    "drm",
    "blink",
    "renderer.scheduler",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-viz.gpu_composite_time",
];

/// The socket the desktop on `control` reports trace events to: beside its
/// control socket, in the user's runtime directory.
pub fn producer_socket(control: &Path) -> PathBuf {
    control.with_extension("trace.sock")
}

/// The Perfetto service, listening for the engine on `producer` and for the
/// recorder on `consumer`.
pub fn traced(perfetto: &Path, producer: &Path, consumer: &Path) -> Spawn {
    Spawn {
        program: perfetto.join("bin").join("traced"),
        args: Vec::new(),
        env: vec![
            (PRODUCER_VARIABLE.to_string(), producer.into()),
            (CONSUMER_VARIABLE.to_string(), consumer.into()),
        ],
    }
}

/// The recorder, which takes [`config`] on stdin and writes `file`.
pub fn record(perfetto: &Path, consumer: &Path, file: &Path) -> Spawn {
    Spawn {
        program: perfetto.join("bin").join("perfetto"),
        args: ["--txt", "-c", "-", "-o"]
            .map(OsString::from)
            .into_iter()
            .chain([file.into()])
            .collect(),
        env: vec![(CONSUMER_VARIABLE.to_string(), consumer.into())],
    }
}

/// The recorder's text config: [`CATEGORIES`] for `duration`.
pub fn config(duration: Duration) -> String {
    let categories: String = CATEGORIES
        .iter()
        .map(|category| format!(" enabled_categories: \"{category}\""))
        .collect();
    format!(
        "buffers {{ size_kb: 262144 fill_policy: RING_BUFFER }}\n\
         data_sources {{ config {{ name: \"track_event\" track_event_config {{{categories} }} }} }}\n\
         duration_ms: {}\n",
        duration.as_millis()
    )
}

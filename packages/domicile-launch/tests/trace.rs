//! `domicile trace`: the sockets, the trace config and the Perfetto command
//! lines.

use std::path::{Path, PathBuf};
use std::time::Duration;

use domicile_launch::trace::{config, producer_socket, record, traced, ATTACH_WITHIN};

fn env_of(spawn: &domicile_launch::spawn::Spawn, name: &str) -> Option<String> {
    spawn
        .env
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.to_string_lossy().into_owned())
}

#[test]
fn each_desktop_has_its_own_trace_socket_beside_its_control_socket() {
    // In the runtime directory, so only its user can trace the engine.
    assert_eq!(
        producer_socket(Path::new("/run/user/1000/domicile-ipc.4242.sock")),
        PathBuf::from("/run/user/1000/domicile-ipc.4242.trace.sock")
    );
}

#[test]
fn the_service_listens_where_the_engine_looks() {
    let spawned = traced(
        Path::new("/p"),
        Path::new("/run/d/domicile-ipc.1.trace.sock"),
        Path::new("/tmp/t/consumer.sock"),
    );
    assert_eq!(spawned.program, PathBuf::from("/p/bin/traced"));
    assert_eq!(
        env_of(&spawned, "PERFETTO_PRODUCER_SOCK_NAME").unwrap(),
        "/run/d/domicile-ipc.1.trace.sock"
    );
    assert_eq!(
        env_of(&spawned, "PERFETTO_CONSUMER_SOCK_NAME").unwrap(),
        "/tmp/t/consumer.sock"
    );
}

#[test]
fn the_recorder_reads_the_config_from_stdin_and_writes_the_file() {
    let spawned = record(
        Path::new("/p"),
        Path::new("/tmp/t/consumer.sock"),
        Path::new("/home/me/switch.pftrace"),
    );
    assert_eq!(spawned.program, PathBuf::from("/p/bin/perfetto"));
    assert_eq!(
        spawned.args,
        ["--txt", "-c", "-", "-o", "/home/me/switch.pftrace"]
            .map(std::ffi::OsString::from)
            .to_vec()
    );
    assert_eq!(
        env_of(&spawned, "PERFETTO_CONSUMER_SOCK_NAME").unwrap(),
        "/tmp/t/consumer.sock"
    );
}

#[test]
fn a_trace_records_frame_production_for_as_long_as_asked() {
    let said = config(Duration::from_secs(12));
    assert!(said.contains("duration_ms: 12000"), "{said}");
    // What a dropped frame is read from: the shell's and pages' frames
    // (`cc`, `blink`), the display compositor and GPU (`viz`, `gpu`), and the
    // frame timeline the DevTools Performance panel draws.
    for category in [
        "cc",
        "viz",
        "gpu",
        "blink",
        "disabled-by-default-devtools.timeline.frame",
    ] {
        assert!(
            said.contains(&format!("enabled_categories: \"{category}\"")),
            "{category}: {said}"
        );
    }
}

#[test]
fn the_engine_s_sandboxed_processes_have_time_to_attach() {
    // They retry the socket through the browser process at most every 30 s.
    assert!(ATTACH_WITHIN > Duration::from_secs(30));
}

//! Tests for `domicile subscribe`'s forwarding, against a fake compositor.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};

use domicile_launch::control::{to_line, Response, Subscription};
use domicile_launch::subscription::follow;
use domicile_protocol::{HostMessage, Theme, WatchTopic};

#[test]
fn what_the_compositor_says_is_heard_until_it_goes() {
    let scratch = tempfile::tempdir().expect("a scratch directory");
    let path = scratch.path().join("chrome.sock");
    let listener = UnixListener::bind(&path).expect("the compositor binds");
    let compositor = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("the supervisor dialed");
        let mut asked = String::new();
        BufReader::new(stream.try_clone().expect("readable"))
            .read_line(&mut asked)
            .expect("a watch");
        let mut telling = stream;
        telling
            .write_all(
                b"{\"type\":\"theme\",\"theme\":\"dark\"}\n{\"type\":\"theme\",\"theme\":\"light\"}\n",
            )
            .expect("the compositor told");
        asked
    });
    let (desktop, client) = UnixStream::pair().expect("a connection");

    follow(
        Subscription {
            topics: vec![WatchTopic::Status],
            client: desktop,
        },
        &path,
    );

    assert_eq!(
        compositor.join().expect("the compositor ran"),
        "{\"type\":\"watch\",\"topics\":[\"status\"]}\n"
    );
    let heard: Vec<String> = BufReader::new(client)
        .lines()
        .map(|line| line.expect("a line"))
        .collect();
    assert_eq!(
        heard,
        [Theme::Dark, Theme::Light].map(|theme| to_line(&Response::Heard {
            message: HostMessage::Theme { theme }
        })
        .trim()
        .to_string())
    );
}

#[test]
fn no_compositor_is_refused() {
    let scratch = tempfile::tempdir().expect("a scratch directory");
    let (desktop, client) = UnixStream::pair().expect("a connection");

    follow(
        Subscription {
            topics: vec![WatchTopic::Windows],
            client: desktop,
        },
        &scratch.path().join("nothing.sock"),
    );

    let mut said = String::new();
    BufReader::new(client)
        .read_line(&mut said)
        .expect("the client heard");
    assert!(said.contains("refused"), "{said}");
}

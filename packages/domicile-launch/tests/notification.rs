use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use domicile_launch::notification::{connected, notify, ANSWER_WITHIN};
use zbus::zvariant::OwnedValue;

/// One `Notify` call the fake server received.
#[derive(Debug, PartialEq)]
struct Heard {
    app_name: String,
    app_icon: String,
    summary: String,
    body: String,
    urgency: Option<u8>,
}

struct Server {
    heard: Arc<Mutex<Vec<Heard>>>,
}

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Server {
    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        app_name: String,
        _replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        _actions: Vec<String>,
        hints: HashMap<String, OwnedValue>,
        _expire_timeout: i32,
    ) -> u32 {
        let urgency = hints
            .get("urgency")
            .map(|value| u8::try_from(value).unwrap());
        self.heard.lock().unwrap().push(Heard {
            app_name,
            app_icon,
            summary,
            body,
            urgency,
        });
        1
    }
}

/// A fake server and a client, connected peer-to-peer over a socket pair.
fn paired() -> (
    zbus::blocking::Connection,
    zbus::blocking::Connection,
    Arc<Mutex<Vec<Heard>>>,
) {
    let (theirs, ours) = UnixStream::pair().unwrap();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let guid = zbus::Guid::generate();
    let server = std::thread::spawn({
        let heard = Arc::clone(&heard);
        move || {
            zbus::blocking::connection::Builder::async_io_unix_stream(theirs)
                .server(guid)
                .unwrap()
                .p2p()
                .serve_at("/org/freedesktop/Notifications", Server { heard })
                .unwrap()
                .build()
                .unwrap()
        }
    });
    let client =
        connected(zbus::blocking::connection::Builder::async_io_unix_stream(ours).p2p()).unwrap();
    (server.join().unwrap(), client, heard)
}

#[test]
fn says_what_failed_as_domicile() {
    let (_server, client, heard) = paired();
    notify(
        &client,
        "",
        "domicile.ts did not reload",
        "SyntaxError: Unexpected token",
    )
    .unwrap();
    assert_eq!(
        *heard.lock().unwrap(),
        [Heard {
            app_name: "Domicile".into(),
            app_icon: String::new(),
            summary: "domicile.ts did not reload".into(),
            body: "SyntaxError: Unexpected token".into(),
            urgency: Some(2),
        }]
    );
}

#[test]
fn draws_with_the_icon_given() {
    let (_server, client, heard) = paired();
    notify(&client, "element", "Element runs on its own Electron", "").unwrap();
    assert_eq!(heard.lock().unwrap()[0].app_icon, "element");
}

#[test]
fn a_server_that_never_answers_is_an_error_not_a_hang() {
    let (theirs, ours) = UnixStream::pair().unwrap();
    let guid = zbus::Guid::generate();
    let server = std::thread::spawn(move || {
        zbus::blocking::connection::Builder::async_io_unix_stream(theirs)
            .server(guid)
            .unwrap()
            .p2p()
            .build()
            .unwrap()
    });
    let client =
        connected(zbus::blocking::connection::Builder::async_io_unix_stream(ours).p2p()).unwrap();
    let _server = server.join().unwrap();
    let asked = std::time::Instant::now();
    assert!(notify(&client, "", "summary", "body").is_err());
    assert!(asked.elapsed() < ANSWER_WITHIN * 2);
}

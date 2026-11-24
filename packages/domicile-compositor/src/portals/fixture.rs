//! The portal backends served over a socket pair, with a real EIS loop
//! behind them, for tests.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::Duration;

use domicile_config::LockdownConfig;
use domicile_host::cups::Cups;
use domicile_protocol::{Capturing, PortalRequest, Theme};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

use super::clipboard::Selection;
use super::global_shortcuts::Shortcuts;
use super::restore::Tokens;
use super::settings::Appearance;
use super::socket_pair::connected;
use super::{export, heard, Backends, Starting, OBJECT_PATH};
use crate::client_requests::ClientRequest;
use crate::eis::recorded::in_the_background;
use crate::notifications::NotificationServer;

const REMOTE_DESKTOP: &str = "org.freedesktop.impl.portal.RemoteDesktop";

pub const SESSION: &str = "/org/freedesktop/portal/desktop/session/1_7/s";
pub const APP: &str = "org.example.Remote";

pub type Results = HashMap<String, OwnedValue>;

/// The backend served to a client, over a real EIS loop.
pub struct Served {
    pub client: zbus::blocking::Connection,
    pub backends: Backends,
    pub published: Receiver<(Vec<PortalRequest>, Vec<Capturing>)>,
    pub injected: Receiver<ClientRequest>,
    /// Input offered to the captures, as the Wayland thread does.
    pub input: std::sync::mpsc::Sender<ClientRequest>,
    /// What the backends asked of the clipboard.
    pub selections: Receiver<Selection>,
    _server: zbus::blocking::Connection,
}

pub fn served(tokens: Tokens) -> Served {
    let (publish, published) = channel();
    let background = in_the_background();
    let (eis, injected) = (background.eis, background.injected);
    let (backends, told) = Backends::new(
        NotificationServer::unserved(Vec::new()),
        tokens,
        Shortcuts::new(None),
    );
    backends.queue.listen(
        move |items, capturing| {
            let _ = publish.send((items, capturing));
        },
        || true,
        |_| None,
    );
    let (select, selections) = channel();
    backends.attach(eis, move |selection| {
        let _ = select.send(selection);
    });
    let serving = backends.clone();
    let (server, client) = connected(move |builder| {
        export(
            builder,
            Theme::Dark,
            Appearance::default(),
            Starting {
                lockdown: LockdownConfig::default(),
                screen_cast: super::idle_screen_cast(&serving.queue),
                shots: super::Shots::none(),
                open: Box::new(|_, _| Ok(())),
                user: Box::new(|| Box::pin(async { Err("no user here".into()) })),
                cups: Cups::new(Vec::new(), "me".into()),
            },
            &serving,
            Vec::new(),
            "/home/me".into(),
        )
        .expect("the interfaces registered")
    });
    let hearing = server.clone();
    let hearing_backends = backends.clone();
    thread::spawn(move || {
        for next in told {
            heard(&hearing, &hearing_backends, next).expect("handled");
        }
    });
    Served {
        client,
        backends,
        published,
        injected,
        input: background.input,
        selections,
        _server: server,
    }
}

pub fn call<B>(
    served: &Served,
    interface: &str,
    method: &str,
    body: &B,
) -> zbus::Result<zbus::message::Message>
where
    B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType,
{
    served
        .client
        .call_method(None::<&str>, OBJECT_PATH, Some(interface), method, body)
}

pub fn path(path: &str) -> ObjectPath<'_> {
    ObjectPath::try_from(path).expect("a path")
}

pub fn options(sent: Vec<(&str, Value<'static>)>) -> Results {
    sent.into_iter()
        .map(|(name, value)| (name.into(), OwnedValue::try_from(value).expect("ownable")))
        .collect()
}

pub fn reply(message: zbus::message::Message) -> (u32, Results) {
    message.body().deserialize().expect("a response")
}

/// Create a RemoteDesktop session that selects `asked`, and asks for the
/// clipboard if `clipboard` is set, and start it on another thread.
pub fn starting(
    served: &Served,
    asked: Results,
    clipboard: bool,
) -> thread::JoinHandle<(u32, Results)> {
    let create = call(
        served,
        REMOTE_DESKTOP,
        "CreateSession",
        &(path("/r/1"), path(SESSION), APP, Results::new()),
    )
    .expect("CreateSession answered");
    assert_eq!(reply(create).0, 0);
    let select = call(
        served,
        REMOTE_DESKTOP,
        "SelectDevices",
        &(path("/r/2"), path(SESSION), APP, asked),
    )
    .expect("SelectDevices answered");
    assert_eq!(reply(select).0, 0);
    if clipboard {
        call(
            served,
            "org.freedesktop.impl.portal.Clipboard",
            "RequestClipboard",
            &(path(SESSION), Results::new()),
        )
        .expect("RequestClipboard answered");
    }
    let client = served.client.clone();
    thread::spawn(move || {
        let started = client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some(REMOTE_DESKTOP),
                "Start",
                &(path("/r/3"), path(SESSION), APP, "", Results::new()),
            )
            .expect("Start answered");
        reply(started)
    })
}

#[track_caller]
pub fn next(served: &Served) -> (Vec<PortalRequest>, Vec<Capturing>) {
    served
        .published
        .recv_timeout(Duration::from_secs(10))
        .expect("the queue published")
}

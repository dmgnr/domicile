//! Locks the desktop before the machine sleeps, and when logind locks the
//! session (`loginctl lock-session`). See `docs/LOCK.md#sleep-and-logind`.
//!
//! A thread listens on the system bus and sends what it hears to the event
//! loop, where the lock lives.

use std::os::fd::OwnedFd;
use std::thread;

use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use tracing::debug;
use zbus::blocking::{proxy, Connection, Proxy};
use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedObjectPath;

use crate::lock::LOCK_SCREEN_DRAWS_WITHIN;
use crate::{CalloopData, DomicileCompositor};

const LOGIND: &str = "org.freedesktop.login1";
const MANAGER: &str = "/org/freedesktop/login1";
const MANAGER_INTERFACE: &str = "org.freedesktop.login1.Manager";
const SESSION_INTERFACE: &str = "org.freedesktop.login1.Session";

/// What the thread heard from logind.
#[derive(Debug)]
pub enum Logind {
    /// A delay inhibitor on sleep. Sleep waits until it is closed.
    Holding(OwnedFd),
    /// `PrepareForSleep(true)`: the machine is about to sleep.
    Sleeping,
    /// The session's `Lock` signal.
    AskedToLock,
}

/// Listen to logind on a thread, sending what it hears to `tell`.
///
/// Without logind the desktop runs as usual, so a failure is a warning.
pub fn listen(tell: impl Fn(Logind) + Send + Clone + 'static) {
    thread::spawn(move || {
        let why = listen_on(tell);
        tracing::error!(
            %why,
            "this desktop does not hear logind, so it does not lock before the machine sleeps"
        );
    });
}

impl DomicileCompositor {
    /// Act on what [`listen`] heard.
    pub fn heard_from_logind(&mut self, heard: Logind) {
        match heard {
            Logind::Holding(inhibitor) => {
                debug!("holding off sleep until this desktop locks");
                self.sleep_inhibitor = Some(inhibitor);
            }
            Logind::Sleeping => {
                self.shut_the_desk("the machine is going to sleep, so this desktop locks");
                // Only this sleep's inhibitor: one taken on waking within the
                // wait is for the next sleep.
                let mut held = self.sleep_inhibitor.take();
                self.loop_handle
                    .insert_source(
                        Timer::from_duration(LOCK_SCREEN_DRAWS_WITHIN),
                        move |_, _, _: &mut CalloopData| {
                            debug!("this desktop is locked; the machine can sleep");
                            drop(held.take());
                            TimeoutAction::Drop
                        },
                    )
                    .expect("a timer joins the event loop");
            }
            Logind::AskedToLock => self.shut_the_desk("logind asked for this desktop to be locked"),
        }
    }
}

/// Listen on the system bus, returning why it stopped.
fn listen_on(tell: impl Fn(Logind) + Send + Clone + 'static) -> zbus::Error {
    match hear_sleeps(tell) {
        Ok(()) => zbus::Error::Failure("the system bus closed".into()),
        Err(why) => why,
    }
}

/// Subscribes before taking the first inhibitor, so no sleep goes unheard
/// once one is held.
fn hear_sleeps(tell: impl Fn(Logind) + Send + Clone + 'static) -> zbus::Result<()> {
    let bus = Connection::system()?;
    let manager = proxy_to(&bus, MANAGER, MANAGER_INTERFACE)?;
    let sleeps = manager.receive_signal("PrepareForSleep")?;
    if let Err(why) = listen_for_locks(&bus, &manager, tell.clone()) {
        tracing::error!(
            %why,
            "this desktop does not hear its logind session, so `loginctl lock-session` does not \
             lock it"
        );
    }
    tell(Logind::Holding(inhibit(&manager)?));
    for signal in sleeps {
        let starting: bool = signal.body().deserialize()?;
        tell(if starting {
            Logind::Sleeping
        } else {
            Logind::Holding(inhibit(&manager)?)
        });
    }
    Ok(())
}

/// Listen for the session's `Lock` signal on a thread of its own.
///
/// Fails for a compositor in no session, such as one started over ssh, which
/// still locks before sleep.
fn listen_for_locks(
    bus: &Connection,
    manager: &Proxy<'static>,
    tell: impl Fn(Logind) + Send + 'static,
) -> zbus::Result<()> {
    let session: OwnedObjectPath = manager.call("GetSessionByPID", &std::process::id())?;
    let locks = proxy_to(bus, session.into_inner(), SESSION_INTERFACE)?.receive_signal("Lock")?;
    thread::spawn(move || {
        for _ in locks {
            tell(Logind::AskedToLock);
        }
    });
    Ok(())
}

/// Ask logind to delay sleep until the returned descriptor is closed.
fn inhibit(manager: &Proxy<'static>) -> zbus::Result<OwnedFd> {
    let inhibitor: zbus::zvariant::OwnedFd = manager.call(
        "Inhibit",
        &(
            "sleep",
            "Domicile",
            "Locks the desktop before the machine sleeps",
            "delay",
        ),
    )?;
    Ok(inhibitor.into())
}

fn proxy_to<'a>(
    bus: &Connection,
    path: impl TryInto<zbus::zvariant::ObjectPath<'a>, Error: Into<zbus::Error>>,
    interface: &'static str,
) -> zbus::Result<Proxy<'a>> {
    proxy::Builder::new(bus)
        .destination(LOGIND)?
        .path(path)?
        .interface(interface)?
        .cache_properties(CacheProperties::No)
        .build()
}

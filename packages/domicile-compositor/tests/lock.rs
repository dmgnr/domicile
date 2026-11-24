//! While the desktop is locked, keys and requests from the chrome do not reach
//! clients or the home directory.
//!
//! `crate::lock`'s unit tests cover what the lock refuses and what unlocks it.
//! These tests check the end-to-end effect on a real client and seat. They
//! mirror `tests/input.rs`, which checks that the same keys do arrive.
//!
//! Each test locks the desktop through the idle timeout, then removes the
//! timeout so the desktop cannot lock a second time during the assertions.

mod running;

use domicile_protocol::{
    ChromeMessage, HostMessage, Passphrase, SystemEvent, SystemReply, SystemRequest, UnlockRefusal,
};

use crate::running::{Compositor, THE_PASSPHRASE};

/// `a`, in evdev codes. The client traces `key(serial, time, code, state)`, so
/// the end of that line identifies the key and whether it was pressed.
const EVDEV_KEY_A: u32 = 30;

/// The client's trace line for a press of that key.
const A_PRESS_OF_IT: &str = ", 30, 1)";

/// The client's trace line for a release of that key.
const A_RELEASE_OF_IT: &str = ", 30, 0)";

/// A desktop with no idle timeout, unlocked through PAM's `domicile` service:
/// the fixture's, which takes [`THE_PASSPHRASE`].
const A_DESK: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] }
}
"#;

/// The same desktop, with the shortest lock timeout the config accepts and
/// no blanking.
///
/// One second, because `IdleConfig` refuses zero.
const A_DESK_THAT_LOCKS_IN_A_SECOND: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "idle": { "lock_after_seconds": 1 }
}
"#;

/// Lock the desktop through the idle timeout, then remove the timeout.
///
/// Takes the caller's chrome rather than connecting one: a new connection
/// sends `hello`, which releases every held key and would interfere with the
/// held-key test.
fn lock_the_desk(compositor: &Compositor, chrome: &mut domicile_test_chrome::Chrome) {
    // Consume the `locked: false` sent on `hello`. Otherwise a later wait for
    // the unlock would match this stale message, and keys sent then would
    // arrive while the passphrase is still being checked and be refused.
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: false }))
        .expect("a desk that can lock tells a page that says hello it is open");
    compositor.reconfigure(A_DESK_THAT_LOCKS_IN_A_SECOND);
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: true }))
        .expect("a desk nobody is at locks itself and says so");

    // Removing the timeout leaves the desktop locked, and unable to lock again.
    // The first reload restarted the clock too.
    compositor.reconfigure(A_DESK);
    compositor.wait_for_log_times("the idle clock starts over from the reloaded timeouts", 2);
}

/// Type a key at whichever window has the keyboard, press and release.
fn press_a(chrome: &mut domicile_test_chrome::Chrome, app_id: &str) {
    for pressed in [true, false] {
        say_a(chrome, app_id, pressed);
    }
}

/// One half of that keystroke, for the test that never releases.
fn say_a(chrome: &mut domicile_test_chrome::Chrome, app_id: &str, pressed: bool) {
    chrome
        .say(&ChromeMessage::Key {
            app_id: app_id.to_string(),
            keycode: EVDEV_KEY_A,
            pressed,
        })
        .expect("the chrome socket takes input");
}

/// Connect a chrome, start a client and give its window the keyboard.
///
/// Waits for the compositor's log, so a lost key is the lock's doing and not a
/// focus that never landed.
fn a_client_being_typed_at(
    compositor: &Compositor,
) -> (domicile_test_chrome::Chrome, crate::running::Client, String) {
    let mut chrome = compositor.chrome();
    let client = compositor.client("app");

    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("a client that opened a window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };

    chrome
        .say(&ChromeMessage::FocusApp {
            app_id: app_id.clone(),
        })
        .expect("the chrome socket takes a focus");
    compositor.wait_for_log("keyboard focus -> client");

    (chrome, client, app_id)
}

/// A key sent while locked reaches no client, and the passphrase restores
/// input.
///
/// Both halves are in one test so the check counts instead of waiting for an
/// absence. The same key is sent while locked and after unlocking, and the
/// client must see exactly one. The socket is ordered, so a key the lock let
/// through would be traced before the second one. A lock that refuses nothing
/// gives two; a lock that never opens gives none.
#[test]
fn a_locked_desk_refuses_the_keys_and_the_passphrase_starts_them_again() {
    let compositor = Compositor::started_with(A_DESK);
    let (mut chrome, mut client, app_id) = a_client_being_typed_at(&compositor);

    lock_the_desk(&compositor, &mut chrome);

    press_a(&mut chrome, &app_id);
    compositor.wait_for_log("this desktop is locked");

    chrome
        .say(&ChromeMessage::Unlock {
            passphrase: Passphrase::from(THE_PASSPHRASE),
        })
        .expect("the chrome socket takes an unlock");
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: false }))
        .expect("the passphrase opens the desk and every chrome is told");

    // Locking gave the page the keyboard; a shell gives it back on unlock.
    chrome
        .say(&ChromeMessage::FocusApp {
            app_id: app_id.clone(),
        })
        .expect("the chrome socket takes a focus");
    compositor.wait_for_log_times("keyboard focus -> client", 2);

    press_a(&mut chrome, &app_id);
    assert!(
        client.wait_for_trace(A_PRESS_OF_IT, 1),
        "the desk was opened and the key still reached no client; it traced:\n{}",
        client.trace()
    );
    assert_eq!(
        client.trace().matches(A_PRESS_OF_IT).count(),
        1,
        "the key forwarded at the locked desk was delivered too; it traced:\n{}",
        client.trace()
    );
}

/// A chrome that connects while the desktop is locked is told it is locked.
///
/// A page reload is a new connection that sends `hello`. This is the main
/// property of the lock: a reloaded or restarted shell must not show an
/// unlocked desktop. The event that locked it happened before the page
/// existed.
#[test]
fn a_page_that_connects_over_a_locked_desk_is_told_so() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();
    lock_the_desk(&compositor, &mut chrome);

    compositor
        .chrome()
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: true }))
        .expect("a page that has only just connected is told where the desk stands");
}

/// A wrong passphrase keeps the desktop locked, tells the page, and is not
/// logged.
///
/// The page learns of the refusal from a repeated `locked: true`. Nothing
/// else sends it while a passphrase is being checked, so the shell can clear
/// its field and show an error.
///
/// The compositor logs the refusal, which must not include the passphrase.
/// Both the typed and the correct passphrase are checked against the log.
#[test]
fn a_passphrase_the_desk_refuses_leaves_it_shut_says_so_and_stays_out_of_the_log() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();
    lock_the_desk(&compositor, &mut chrome);
    let wrong = "hunter2";

    chrome
        .say(&ChromeMessage::Unlock {
            passphrase: Passphrase::from(wrong),
        })
        .expect("the chrome socket takes an unlock");
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: true }))
        .expect("the page that offered the passphrase is told the desk stayed locked");
    compositor.wait_for_log("a passphrase this desktop did not take");

    let said = compositor.complaint();
    assert!(
        !said.contains(wrong),
        "the refused passphrase is in the log:\n{said}"
    );
    assert!(
        !said.contains(THE_PASSPHRASE),
        "the desk's own passphrase is in the log:\n{said}"
    );
}

/// A page listening while locked hears why a passphrase was refused, before
/// the `locked: true` that answers it.
#[test]
fn a_page_listening_hears_why_the_desk_refused_a_passphrase() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();
    lock_the_desk(&compositor, &mut chrome);
    chrome
        .say(&ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::UnlockRefusals,
        })
        .expect("the chrome socket takes a system call");
    chrome
        .wait_for(|message| {
            matches!(
                message,
                HostMessage::SystemReply {
                    id: 5,
                    reply: SystemReply::Started
                }
            )
        })
        .expect("a locked desk lets a page listen for refusals");

    chrome
        .say(&ChromeMessage::Unlock {
            passphrase: Passphrase::from("hunter2"),
        })
        .expect("the chrome socket takes an unlock");

    assert_eq!(
        chrome
            .wait_for(|message| matches!(message, HostMessage::SystemEvent { id: 5, .. }))
            .expect("the page hears the refusal"),
        HostMessage::SystemEvent {
            id: 5,
            event: SystemEvent::UnlockRefused {
                refusal: UnlockRefusal::WrongPassphrase,
                failures: 1,
                retry_in_ms: 0,
            },
        }
    );
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: true }))
        .expect("and then that the desk stayed locked");
}

/// A key held down when the desktop locks is released for the client.
///
/// The lock cannot just drop a release: the press was delivered, and the seat
/// outlives every page, so the key would stay down for good. If the held key
/// is `Caps_Lock`, Caps Lock would stay on, because xkb unlocks it only on the
/// release of the press that locked it. `tests/stuck_keys.rs` covers the same
/// failure through a reload.
///
/// A held modifier is the realistic case: browsers repeat ordinary keys, which
/// resets the idle timer, but a held Shift sends nothing.
#[test]
fn a_key_held_when_the_desk_locks_is_let_go_of_for_the_client() {
    let compositor = Compositor::started_with(A_DESK);
    let (mut chrome, mut client, app_id) = a_client_being_typed_at(&compositor);

    // Pressed and never released.
    say_a(&mut chrome, &app_id, true);
    assert!(
        client.wait_for_trace(A_PRESS_OF_IT, 1),
        "the client never received the press, so it is not holding the key this \
         test is about; it traced:\n{}",
        client.trace()
    );

    lock_the_desk(&compositor, &mut chrome);

    assert!(
        client.wait_for_trace(A_RELEASE_OF_IT, 1),
        "the desk locked with the key still down in the seat, and nothing will \
         ever send its release; it traced:\n{}",
        client.trace()
    );
}

/// Locking takes the keyboard from the window that had it and gives it to the
/// page, which draws the lock screen.
///
/// A seat left on the window kept the engine sending every key there, where
/// the lock dropped it, so the passphrase field heard nothing.
#[test]
fn locking_hands_the_keyboard_to_the_page() {
    let compositor = Compositor::started_with(A_DESK);
    let (mut chrome, _client, app_id) = a_client_being_typed_at(&compositor);
    // The page held the keyboard before the window took it. Taken here, so
    // the wait after locking cannot match it.
    chrome
        .wait_for(|message| matches!(message, HostMessage::FocusChanged { app_id: None }))
        .expect("a page that says hello is told it holds the keyboard");
    chrome
        .wait_for(|message| {
            matches!(message, HostMessage::FocusChanged { app_id: Some(id) } if *id == app_id)
        })
        .expect("the window the chrome focused is said to have the keyboard");

    lock_the_desk(&compositor, &mut chrome);

    chrome
        .wait_for(|message| matches!(message, HostMessage::FocusChanged { app_id: None }))
        .expect("the desk locked and left the keyboard with the window under the lock screen");
}

/// A spawn requested while locked does not run; the same request after
/// unlocking does.
///
/// Spawn is used because a test can observe it from outside. `crate::lock`'s
/// tests cover the full list of refused requests.
///
/// The check counts instead of waiting for an absence. The unlocked spawn's
/// `spawning client` line is awaited by its pid, so any earlier spawn would
/// already be in the log, and a count of one is exact.
#[test]
fn a_locked_desk_starts_no_program_and_the_passphrase_lets_the_next_one_run() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();
    lock_the_desk(&compositor, &mut chrome);

    say_start(
        &mut chrome,
        &compositor.scratch_file("started-at-a-locked-desk"),
    );

    chrome
        .say(&ChromeMessage::Unlock {
            passphrase: Passphrase::from(THE_PASSPHRASE),
        })
        .expect("the chrome socket takes an unlock");
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: false }))
        .expect("the passphrase opens the desk and every chrome is told");

    let started = compositor.scratch_file("started-at-an-open-desk");
    say_start(&mut chrome, &started);
    let pid = compositor.await_file(&started);
    compositor.wait_for_log(&format!("spawning client pid={pid}"));

    let said = compositor.complaint();
    assert_eq!(
        said.matches("spawning client").count(),
        1,
        "the program asked for at the locked desk was started too:\n{said}"
    );
    assert!(
        said.contains("this desktop is locked; what the shell asked for is not done"),
        "the locked desk refused the spawn without saying so:\n{said}"
    );
}

/// Ask for a program that writes its own pid to `reported`.
///
/// It writes by rename, because a plain redirect creates the file before
/// writing to it.
fn say_start(chrome: &mut domicile_test_chrome::Chrome, reported: &std::path::Path) {
    chrome
        .say(&ChromeMessage::Spawn {
            command: vec![
                "sh".to_string(),
                "-c".to_string(),
                format!(
                    "printf '%s' $$ > {0}.new && mv {0}.new {0}",
                    reported.display()
                ),
            ],
        })
        .expect("the chrome socket takes a spawn");
}

/// A launcher search while locked returns nothing from the home directory;
/// the same search after unlocking finds the file.
///
/// A search is answered before the connection reads its next message, so an
/// answer the lock let through would arrive before the unlock's
/// `locked: false`. Waiting for whichever comes first is exact.
///
/// The index is ready before locking, so an empty answer cannot mean the
/// index was not built yet.
#[test]
fn a_locked_desk_answers_no_search_and_the_passphrase_lets_the_next_one_find_the_file() {
    let home = tempfile::tempdir().expect("a home to lay out");
    std::fs::write(home.path().join("plan.org"), "").expect("the file");
    let compositor = Compositor::started_in_a_home(A_DESK, Some(home.path()));
    let mut chrome = an_indexed_desk_locked(&compositor);

    say_search(&mut chrome, "plan");
    let first = opened_or_answered(&mut chrome);
    assert!(
        matches!(first, HostMessage::Locked { locked: false }),
        "the locked desk answered a search out of the home: {first:?}"
    );

    say_search(&mut chrome, "plan");
    let found = chrome
        .wait_for(|message| matches!(message, HostMessage::FoundFiles { .. }))
        .expect("the desk the passphrase opened answers the search");
    let HostMessage::FoundFiles { files, .. } = found else {
        unreachable!("the wait matched on this variant")
    };
    assert_eq!(files, vec!["plan.org".to_string()]);

    // Awaited: the log reaches the test through a pipe, which can lag behind
    // the answer on the socket.
    compositor.wait_for_log("this desktop is locked; what the shell asked for is not done");
}

/// A shell can request the lock directly, without the idle timeout.
///
/// The desktop has no timeout, so only the message can lock it. A key sent
/// afterward is refused, which shows the lock took effect.
#[test]
fn a_shell_can_lock_the_desk_on_purpose() {
    let compositor = Compositor::started_with(A_DESK);
    let (mut chrome, _client, app_id) = a_client_being_typed_at(&compositor);
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: false }))
        .expect("a desk that can lock tells a page that says hello it is open");

    chrome
        .say(&ChromeMessage::Lock)
        .expect("the chrome socket takes a lock");
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: true }))
        .expect("the desk locks when the shell asks and every chrome is told");

    press_a(&mut chrome, &app_id);
    compositor.wait_for_log("this desktop is locked");
}

/// A machine that declares no PAM service, as in a `nix run` trial, does not
/// lock: locked, nothing would open it. It says so at startup, in the log and
/// in a notification.
///
/// Unlocking through PAM's `other` stack instead would let in whatever it lets
/// in.
#[test]
fn a_desk_whose_pam_service_the_machine_lacks_warns_and_does_not_lock() {
    let compositor = Compositor::started_where_pam_declares_nothing(A_DESK);
    compositor.wait_for_log("security.pam.services.domicile = {};");
    let mut chrome = compositor.chrome();
    chrome
        .wait_for(|message| match message {
            HostMessage::Notifications { items } => items
                .iter()
                .any(|shown| shown.summary == "This screen won't lock"),
            _ => false,
        })
        .expect("the desk says so before anybody tries to lock it");

    chrome
        .say(&ChromeMessage::Lock)
        .expect("the chrome socket takes a lock");

    compositor.wait_for_log("this desktop does not lock");
    compositor
        .chrome()
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: false }))
        .expect("a desk nothing could open stays open");
}

/// A chrome on a desktop whose home is indexed, then locked.
fn an_indexed_desk_locked(compositor: &Compositor) -> domicile_test_chrome::Chrome {
    let mut chrome = compositor.chrome();
    compositor.wait_for_log("the home directory is indexed");
    lock_the_desk(compositor, &mut chrome);
    chrome
}

/// Type the passphrase and return the first of: the unlock message, or a
/// result from the home directory.
fn opened_or_answered(chrome: &mut domicile_test_chrome::Chrome) -> HostMessage {
    chrome
        .say(&ChromeMessage::Unlock {
            passphrase: Passphrase::from(THE_PASSPHRASE),
        })
        .expect("the chrome socket takes an unlock");
    chrome
        .wait_for(|message| {
            matches!(
                message,
                HostMessage::Locked { locked: false } | HostMessage::FoundFiles { .. }
            )
        })
        .expect("the passphrase opens the desk and every chrome is told")
}

fn say_search(chrome: &mut domicile_test_chrome::Chrome, query: &str) {
    chrome
        .say(&ChromeMessage::SearchFiles {
            query: query.to_string(),
        })
        .expect("the chrome socket takes a search");
}

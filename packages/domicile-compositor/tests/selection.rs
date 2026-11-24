//! The clipboard and the primary selection, and that they are separate.
//!
//! An explicit copy fills the clipboard (`wl_data_device`); selecting text
//! fills the primary selection (`zwp_primary_selection_device_v1`) for
//! middle-click paste. Each has its own contents.
//!
//! Clipboard managers use `ext-data-control-v1` or `zwlr_data_control_v1`,
//! which need no focused window. Those checks run `wl-copy` and `wl-paste`
//! from `wl-clipboard`.
//!
//! A paste is the source client writing into a pipe the pasting client reads,
//! so this needs real clients. The compositor's own state is unit-tested in
//! `domicile_host::clipboard` and `crate::clipboard`.

mod running;

use std::io::Read;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use domicile_protocol::{ChromeMessage, HostMessage};

use crate::running::Compositor;

const ONE_DISPLAY: &str = r#"
{ "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] } }
"#;

/// The clipboard and the primary selection hold different bytes, and a client
/// gets the one it asks for.
///
/// One check, because a compositor serving the clipboard on the primary
/// selection would pass either half alone.
#[test]
fn the_middle_click_selection_and_the_clipboard_are_two_clipboards() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    // Connected before the clients, so it hears the announcements live rather
    // than as a replay.
    let mut chrome = compositor.chrome();

    let mut copier = compositor.client_with(
        "copier",
        &[
            "--copy",
            "an explicit copy",
            "--copy-primary",
            "brushed past",
        ],
    );
    let mut pasting = compositor.client_with("pasting", &["--paste"]);

    // The protocol denies `set_selection` from a client without the keyboard,
    // so focus the copying client first, then the pasting one. The focus
    // moves only once the compositor has handled both `set_selection`
    // requests; moving it earlier would get them denied.
    focus(&mut chrome, "copier");
    assert!(
        copier.wait_for_trace("copy handled", 1),
        "the client holding the keyboard could not copy; it traced:\n{}",
        copier.trace()
    );

    focus(&mut chrome, "pasting");
    assert!(
        pasting.wait_for_trace("clipboard: an explicit copy", 1),
        "the client holding the keyboard never read the clipboard; it traced:\n{}",
        pasting.trace()
    );
    assert!(
        pasting.wait_for_trace("primary: brushed past", 1),
        "the client holding the keyboard never read the middle-click selection; it traced:\n{}",
        pasting.trace()
    );
}

/// A clipboard manager's copy reaches the history, and a row the shell
/// restores reaches the clipboard manager, with no window focused.
///
/// `wl-copy` has exited before the paste, so the paste can only come from the
/// compositor's copy.
#[test]
fn a_clipboard_manager_copies_into_the_history_and_pastes_from_it() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();

    let copying = compositor
        .command("wl-copy")
        .args(["--foreground", "--", "kept after the copier left"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wl-copy starts; it is in `nix develop .#full`");
    let history = chrome
        .wait_for(|message| {
            matches!(message, HostMessage::Clipboard { entries }
                if entries.iter().any(|entry| entry.preview == "kept after the copier left"))
        })
        .expect("a copy with no window focused reaches the shell's history");

    let HostMessage::Clipboard { entries } = history else {
        unreachable!("the wait matched on this variant")
    };
    let row = entries
        .iter()
        .find(|entry| entry.preview == "kept after the copier left")
        .expect("the wait matched on this row");
    chrome
        .say(&ChromeMessage::CopyClipboardEntry { entry: row.id })
        .expect("the chrome socket takes a restore");
    // `wl-copy` exits when its selection is replaced, so its exit shows the
    // compositor has taken the restore.
    let copied = finished(copying, Duration::from_secs(10));
    assert!(copied.status.success(), "wl-copy failed: {}", copied.stderr);

    assert_eq!(
        paste(&compositor),
        "kept after the copier left",
        "wl-paste, with no window focused, reads the row the shell restored"
    );
}

/// A restored row becomes the first row, so the shell marks it as what is on
/// the clipboard now.
#[test]
fn a_restored_row_tops_the_history() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    // Each copier holds its selection until the next replaces it.
    let mut copy = |text: &str| -> (Child, u32) {
        let copying = compositor
            .command("wl-copy")
            .args(["--foreground", "--", text])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("wl-copy starts; it is in `nix develop .#full`");
        let history = chrome
            .wait_for(|message| {
                matches!(message, HostMessage::Clipboard { entries }
                    if entries.first().is_some_and(|entry| entry.preview == text))
            })
            .expect("each copy tops the shell's history");
        let HostMessage::Clipboard { entries } = history else {
            unreachable!("the wait matched on this variant")
        };
        (copying, entries[0].id)
    };
    let (copying_earlier, earlier) = copy("earlier");
    let (copying_later, _) = copy("later");

    chrome
        .say(&ChromeMessage::CopyClipboardEntry { entry: earlier })
        .expect("the chrome socket takes a restore");

    chrome
        .wait_for(|message| {
            matches!(message, HostMessage::Clipboard { entries }
                if entries.first().is_some_and(|entry| entry.id == earlier))
        })
        .expect("the restored row is sent back as the first row");
    for copying in [copying_earlier, copying_later] {
        let copied = finished(copying, Duration::from_secs(10));
        assert!(copied.status.success(), "wl-copy failed: {}", copied.stderr);
    }
}

/// Removing the copy on the clipboard drops its row and empties the
/// clipboard, so nothing pastes it again.
#[test]
fn removing_the_current_copy_empties_the_clipboard() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();

    let copying = compositor
        .command("wl-copy")
        .args(["--foreground", "--", "a password"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wl-copy starts; it is in `nix develop .#full`");
    let history = chrome
        .wait_for(|message| {
            matches!(message, HostMessage::Clipboard { entries }
                if entries.first().is_some_and(|entry| entry.preview == "a password" && entry.current))
        })
        .expect("the copy tops the shell's history as what is on the clipboard");
    let HostMessage::Clipboard { entries } = history else {
        unreachable!("the wait matched on this variant")
    };

    chrome
        .say(&ChromeMessage::RemoveClipboardEntry {
            entry: entries[0].id,
        })
        .expect("the chrome socket takes a removal");

    chrome
        .wait_for(
            |message| matches!(message, HostMessage::Clipboard { entries } if entries.is_empty()),
        )
        .expect("the removed row leaves the shell's history");
    // `wl-copy` exits when its selection is cleared.
    let copied = finished(copying, Duration::from_secs(10));
    assert!(copied.status.success(), "wl-copy failed: {}", copied.stderr);
    let pasting = compositor
        .command("wl-paste")
        .arg("--no-newline")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wl-paste starts; it is in `nix develop .#full`");
    let pasted = finished(pasting, Duration::from_secs(10));
    assert!(
        !pasted.status.success() && pasted.stdout.is_empty(),
        "wl-paste read {:?} from a clipboard that was emptied",
        pasted.stdout
    );
}

/// A copied image reaches the history as a row named for its size, and a
/// restored image row pastes back the same bytes after its copier has left.
#[test]
fn a_copied_image_is_a_row_and_pastes_back_whole() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let image = domicile_host::screenshot::encode(&domicile_host::screenshot::Shot {
        width: 3,
        height: 2,
        bgra: (0..24).collect(),
    });

    let mut copying = compositor
        .command("wl-copy")
        .args(["--foreground", "--type", "image/png"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wl-copy starts; it is in `nix develop .#full`");
    std::io::Write::write_all(&mut copying.stdin.take().expect("stdin was piped"), &image)
        .expect("wl-copy takes the image");
    let history = chrome
        .wait_for(|message| {
            matches!(message, HostMessage::Clipboard { entries }
                if entries.iter().any(|entry| entry.preview == "Image, 3 × 2"))
        })
        .expect("a copied image reaches the shell's history");

    let HostMessage::Clipboard { entries } = history else {
        unreachable!("the wait matched on this variant")
    };
    let row = entries
        .iter()
        .find(|entry| entry.preview == "Image, 3 × 2")
        .expect("the wait matched on this row");
    chrome
        .say(&ChromeMessage::CopyClipboardEntry { entry: row.id })
        .expect("the chrome socket takes a restore");
    // `wl-copy` exits when its selection is replaced.
    let copied = finished(copying, Duration::from_secs(10));
    assert!(copied.status.success(), "wl-copy failed: {}", copied.stderr);

    let pasting = compositor
        .command("wl-paste")
        .args(["--type", "image/png"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wl-paste starts; it is in `nix develop .#full`");
    let pasted = pasting.wait_with_output().expect("wl-paste finishes");
    assert!(
        pasted.status.success(),
        "wl-paste failed: {}",
        String::from_utf8_lossy(&pasted.stderr)
    );
    assert_eq!(
        pasted.stdout, image,
        "the restored row pastes the copied image"
    );
}

/// Give the keyboard to the window with this title, and wait until it has it.
///
/// Selections are offered to the client with the keyboard, so the move must
/// be complete first.
fn focus(chrome: &mut domicile_test_chrome::Chrome, title: &str) {
    let named = chrome
        .wait_for(|message| {
            matches!(message, HostMessage::AppAppeared { title: Some(named), .. } if named == title)
        })
        .expect("a client that named its window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = named else {
        unreachable!("the wait matched on this variant")
    };
    chrome
        .say(&ChromeMessage::FocusApp {
            app_id: app_id.clone(),
        })
        .expect("the chrome socket takes a focus");
    chrome
        .wait_for(|message| {
            matches!(message, HostMessage::FocusChanged { app_id: Some(moved) } if *moved == app_id)
        })
        .expect("the keyboard moves to the window the chrome named");
}

/// What `wl-paste` reads from the clipboard.
///
/// Fails rather than hangs: a `wl-paste` without data control waits for
/// focus that never comes.
fn paste(compositor: &Compositor) -> String {
    let pasting = compositor
        .command("wl-paste")
        .arg("--no-newline")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wl-paste starts; it is in `nix develop .#full`");
    let said = finished(pasting, Duration::from_secs(10));
    assert!(
        said.status.success(),
        "wl-paste failed: {}\nthe compositor said:\n{}",
        said.stderr,
        compositor.complaint()
    );
    said.stdout
}

/// A finished process's status and output.
struct Finished {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

/// Wait for `child` to exit, killing it and failing after `patience`.
fn finished(mut child: Child, patience: Duration) -> Finished {
    let until = Instant::now() + patience;
    let status = loop {
        if let Some(status) = child.try_wait().expect("the child can be waited on") {
            break status;
        }
        if Instant::now() >= until {
            child.kill().expect("the child stops");
            child.wait().expect("the child is reaped");
            panic!("the child did not finish in {patience:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .stdout
        .take()
        .expect("stdout was piped")
        .read_to_string(&mut stdout)
        .expect("stdout is text");
    child
        .stderr
        .take()
        .expect("stderr was piped")
        .read_to_string(&mut stderr)
        .expect("stderr is text");
    Finished {
        status,
        stdout,
        stderr,
    }
}

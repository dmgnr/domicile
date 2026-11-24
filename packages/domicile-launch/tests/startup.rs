//! Tests for what a desktop prints as it starts: a block on a terminal, and
//! one line off it.

use std::path::Path;
use std::time::Duration;

use domicile_launch::paint::Paint;
use domicile_launch::startup::{at_home, built_in, done, heading, row, running, up_line, Chosen};

#[test]
fn the_up_line_says_what_the_desktop_chose_and_where_to_reach_it() {
    let started = Chosen {
        version: Some("domicile 1.3.0"),
        shell: Path::new("/desk/shell.js"),
        config: "/home/me/.config/domicile/domicile.json",
        profile: Path::new("/home/me/.local/share/domicile/profile"),
        platform: "drm",
        on_the_cpu: false,
        socket: Path::new("/run/user/1000/domicile-ipc.7.sock"),
    };
    assert_eq!(
        up_line(&started),
        "domicile is up. domicile 1.3.0 · shell /desk/shell.js · \
         config /home/me/.config/domicile/domicile.json · \
         profile /home/me/.local/share/domicile/profile · platform drm · \
         DOMICILE_SOCK=/run/user/1000/domicile-ipc.7.sock"
    );
    assert_eq!(
        up_line(&Chosen {
            version: None,
            on_the_cpu: true,
            ..started
        }),
        "domicile is up. shell /desk/shell.js · \
         config /home/me/.config/domicile/domicile.json · \
         profile /home/me/.local/share/domicile/profile · platform drm · \
         the engine composites on the CPU · \
         DOMICILE_SOCK=/run/user/1000/domicile-ipc.7.sock"
    );
}

#[test]
fn a_terminal_heads_the_run_with_the_version() {
    assert_eq!(
        heading(Paint::COLOR, Some("domicile 1.3.0")),
        "\x1b[1mdomicile\x1b[0m \x1b[2m1.3.0\x1b[0m"
    );
    assert_eq!(heading(Paint::PLAIN, None), "domicile");
}

#[test]
fn each_choice_is_a_row_aligned_with_the_others() {
    assert_eq!(
        row(Paint::PLAIN, "shell", "@domicile-desktop/manganese"),
        "  shell     @domicile-desktop/manganese"
    );
    assert_eq!(
        row(Paint::COLOR, "platform", "drm"),
        "  \x1b[2mplatform\x1b[0m  drm"
    );
}

#[test]
fn paths_in_the_home_directory_start_with_a_tilde() {
    let home = Some(Path::new("/home/me"));
    assert_eq!(
        at_home(
            "/home/me/.config/domicile/desk.json, because --config names it",
            home
        ),
        "~/.config/domicile/desk.json, because --config names it"
    );
    assert_eq!(
        at_home("/home/meow/desk.json", home),
        "/home/meow/desk.json"
    );
    assert_eq!(at_home("/home/me/desk.json", None), "/home/me/desk.json");
}

#[test]
fn each_part_that_comes_up_is_ticked() {
    assert_eq!(done(Paint::PLAIN, "Engine up", None), "  ✓ Engine up");
    assert_eq!(
        done(
            Paint::COLOR,
            "Compositor up",
            Some("WAYLAND_DISPLAY=wayland-1")
        ),
        "  \x1b[32m✓\x1b[0m Compositor up \x1b[2m· WAYLAND_DISPLAY=wayland-1\x1b[0m"
    );
    assert_eq!(
        built_in(Paint::COLOR, Duration::from_millis(2_440)),
        "  \x1b[32m✓\x1b[0m Shell built \x1b[2min 2.4 s\x1b[0m"
    );
}

#[test]
fn the_last_line_says_how_to_stop() {
    assert_eq!(
        running(Paint::COLOR),
        "\x1b[1;32mDesktop running.\x1b[0m \x1b[2mCtrl-C to stop.\x1b[0m"
    );
}

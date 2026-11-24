//! Tests for what `domicile dev` asks the desktop for.

use std::path::{Path, PathBuf};

use domicile_launch::control::{Request, Response};
use domicile_launch::dev::{dev_socket, going_back, loading};
use domicile_launch::shell_path::{Shell, ShellFiles};

#[test]
fn each_dev_server_has_a_socket_of_its_own() {
    // Two `domicile dev`s, for two shells, must not take each other's socket.
    assert_eq!(
        dev_socket(Path::new("/run/user/1000"), 42),
        PathBuf::from("/run/user/1000/domicile-dev.42.sock")
    );
}

#[test]
fn the_dev_server_is_loaded_as_one() {
    assert_eq!(
        loading(&Shell {
            files: ShellFiles::DevServer,
            module: PathBuf::from("domicile-dev-shell.js"),
            root: PathBuf::from("/run/dev.sock"),
        }),
        Request::LoadShell {
            dev_server: true,
            module: PathBuf::from("domicile-dev-shell.js"),
            root: PathBuf::from("/run/dev.sock"),
        }
    );
}

#[test]
fn stopping_goes_back_to_the_shell_dev_replaced() {
    // The module is relative to its root, and may be below it.
    assert_eq!(
        going_back(Response::Shell {
            dev_server: false,
            module: PathBuf::from("/c/shells/abc/dist/shell.js"),
            root: PathBuf::from("/c/shells/abc"),
        }),
        Ok(Request::LoadShell {
            dev_server: false,
            module: PathBuf::from("dist/shell.js"),
            root: PathBuf::from("/c/shells/abc"),
        })
    );
}

#[test]
fn stopping_goes_back_to_another_dev_server_if_it_replaced_one() {
    assert_eq!(
        going_back(Response::Shell {
            dev_server: true,
            module: PathBuf::from("/run/dev.7.sock/domicile-dev-shell.js"),
            root: PathBuf::from("/run/dev.7.sock"),
        }),
        Ok(Request::LoadShell {
            dev_server: true,
            module: PathBuf::from("domicile-dev-shell.js"),
            root: PathBuf::from("/run/dev.7.sock"),
        })
    );
}

#[test]
fn a_desktop_that_will_not_say_its_shell_stops_dev_before_it_starts() {
    // Without the shell to go back to, stopping would leave the desktop on a
    // dev server that is gone.
    let Err(why) = going_back(Response::Refused {
        why: "the engine is restarting".into(),
    }) else {
        panic!("a refusal is not a shell");
    };
    assert!(why.contains("the engine is restarting"), "{why}");

    let Err(why) = going_back(Response::Done) else {
        panic!("an answer that is not a shell is not one");
    };
    assert!(why.contains("Done"), "{why}");
}

#[test]
fn a_module_outside_its_root_is_not_a_shell_to_go_back_to() {
    let Err(why) = going_back(Response::Shell {
        dev_server: false,
        module: PathBuf::from("/elsewhere/shell.js"),
        root: PathBuf::from("/c/shells/abc"),
    }) else {
        panic!("the engine cannot serve a module outside its root");
    };
    assert!(why.contains("/elsewhere/shell.js"), "{why}");
}

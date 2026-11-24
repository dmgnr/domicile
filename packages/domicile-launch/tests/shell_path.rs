//! Resolving a shell argument to a module and the directory it is served from.

use std::path::{Path, PathBuf};

use domicile_launch::shell_path::{shell_module, ShellPathError};

/// The working directory the commands were typed in. Absolute, as `current_dir`
/// returns.
const HERE: &str = "/work";

/// The home `~` stands for.
const HOME: &str = "/home/me";

/// A fake filesystem: `Some(true)` is a directory, `Some(false)` a file, `None`
/// absent.
fn tree(entries: &'static [(&'static str, bool)]) -> impl Fn(&Path) -> Option<bool> {
    move |path| {
        entries
            .iter()
            .find(|(name, _)| Path::new(name) == path)
            .map(|(_, is_dir)| *is_dir)
    }
}

/// A filesystem with no file contents to read.
fn no_files(_: &Path) -> Option<String> {
    None
}

#[test]
fn the_module_named_is_the_module_loaded_and_its_directory_is_served() {
    // The named module is loaded, not a `shell.js` beside it. The tree has a
    // sibling `shell.js` so loading the wrong file fails this test.
    let fs = tree(&[
        ("/d/dist", true),
        ("/d/dist/shell.js", false),
        ("/d/dist/other.js", false),
    ]);
    let shell = shell_module(
        "/d/dist/other.js",
        None,
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/d/dist"));
    assert_eq!(shell.module, PathBuf::from("other.js"));
}

#[test]
fn a_relative_path_is_resolved_against_where_it_was_typed() {
    // `domicile which-shell` answers processes started from other directories,
    // so the path is resolved once here. The `.` component is dropped.
    let fs = tree(&[("/work/dist/shell.js", false)]);
    let shell = shell_module(
        "./dist/shell.js",
        None,
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/work/dist"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_module_with_no_directory_in_front_of_it_is_served_from_here() {
    // `Path::parent` of a one-component path is the empty path, and an empty
    // `--domicile-shell-root=` would serve nothing. The working directory is
    // used instead.
    let fs = tree(&[("/work/shell.js", false)]);
    let shell = shell_module(
        "shell.js",
        None,
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/work"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_tilde_is_the_home_directory() {
    // A shell expands `~`, but `DOMICILE_PAGE` from a packaged desktop or a
    // quoted tilde arrives unexpanded.
    let fs = tree(&[("/home/me/desk/shell.js", false)]);
    let shell = shell_module(
        "~/desk/shell.js",
        None,
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/home/me/desk"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_bare_tilde_is_a_path_and_a_home_directory_is_not_a_shell() {
    // A bare `~` has no separator but is a path, not a name. It names a
    // directory, so the directory rule refuses it.
    let fs = tree(&[("/home/me", true)]);
    assert_eq!(
        shell_module(
            "~",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &no_files
        ),
        Err(ShellPathError::Directory("/home/me".to_string()))
    );
}

#[test]
fn a_tilde_with_no_home_behind_it_is_refused() {
    // With HOME unset, the only fallbacks are the working directory or `/`, and
    // nobody asked for either.
    let fs = tree(&[("/home/me/desk/shell.js", false)]);
    assert_eq!(
        shell_module(
            "~/desk/shell.js",
            None,
            Path::new(HERE),
            None,
            &fs,
            &no_files
        ),
        Err(ShellPathError::NoHome("~/desk/shell.js".to_string()))
    );
}

#[test]
fn a_tilde_that_names_somebody_else_is_left_alone() {
    // `~alice` needs a user database lookup this program does not do, so the
    // tilde stays part of the name. The error shows the path it checked, tilde
    // included.
    let fs = tree(&[]);
    assert_eq!(
        shell_module(
            "~alice/desk/shell.js",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &no_files
        ),
        Err(ShellPathError::NotThere(
            "/work/~alice/desk/shell.js".to_string()
        ))
    );
}

#[test]
fn a_dot_dot_is_left_for_the_filesystem_to_resolve() {
    // Dropping the component before `..` is wrong when that component is a
    // symlink, which is common for built shells. The filesystem resolves `..`
    // instead.
    let fs = tree(&[("/work/dist/../other/shell.js", false)]);
    let shell = shell_module(
        "dist/../other/shell.js",
        None,
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/work/dist/../other"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_directory_is_refused_and_says_which_file_to_name() {
    // The error says which file to name, not only what was wrong. A directory
    // is not searched, because which module it holds is the shell's choice. The
    // error names the resolved path.
    let fs = tree(&[("/work/dist", true), ("/work/dist/shell.js", false)]);
    assert_eq!(
        shell_module(
            "./dist",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &no_files
        ),
        Err(ShellPathError::Directory("/work/dist".to_string()))
    );
}

#[test]
fn a_directory_whose_package_json_names_a_prebuilt_shell_serves_it() {
    // As a package does: `"domicile": { "shell": ... }` names a module that is
    // served as it is (#2468).
    let fs = tree(&[("/work/desk", true), ("/work/desk/dist/shell.js", false)]);
    let read = |path: &Path| {
        (path == Path::new("/work/desk/package.json"))
            .then(|| r#"{"name":"desk","domicile":{"shell":"dist/shell.js"}}"#.to_string())
    };
    let shell = shell_module(
        "./desk",
        None,
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &read,
    )
    .expect("the package.json names the module");
    assert_eq!(shell.root, PathBuf::from("/work/desk/dist"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_prebuilt_shell_a_package_json_names_must_be_there() {
    let fs = tree(&[("/work/desk", true)]);
    let read = |_: &Path| Some(r#"{"domicile":{"shell":"dist/shell.js"}}"#.to_string());
    assert_eq!(
        shell_module(
            "./desk",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &read
        ),
        Err(ShellPathError::NotAModule {
            file: "/work/desk/package.json".to_string(),
            module: "/work/desk/dist/shell.js".to_string(),
        })
    );
}

#[test]
fn a_prebuilt_shell_a_package_json_names_must_be_a_file() {
    let fs = tree(&[("/work/desk", true), ("/work/desk/dist", true)]);
    let read = |_: &Path| Some(r#"{"domicile":{"shell":"dist"}}"#.to_string());
    assert_eq!(
        shell_module(
            "./desk",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &read
        ),
        Err(ShellPathError::NotAModule {
            file: "/work/desk/package.json".to_string(),
            module: "/work/desk/dist".to_string(),
        })
    );
}

#[test]
fn a_package_json_that_does_not_parse_is_refused() {
    let fs = tree(&[("/work/desk", true)]);
    let read = |_: &Path| Some(r#"{"domicile":{"shell":3}}"#.to_string());
    assert!(matches!(
        shell_module(
            "./desk",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &read
        ),
        Err(ShellPathError::Manifest { .. })
    ));
}

#[test]
fn a_handed_in_module_makes_a_bare_name_a_name() {
    // A packaged desktop hands over its built module and passes its name for
    // the log. A `simple/` directory in the working directory must not turn
    // that name into a path.
    let fs = tree(&[("/work/simple", true), ("/store/page/shell.js", false)]);
    let shell = shell_module(
        "simple",
        Some("/store/page/shell.js"),
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/store/page"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_handed_in_module_is_resolved_by_the_same_rules() {
    // One set of rules for both inputs. A packaged desktop writes
    // `DOMICILE_PAGE` itself, so no shell expands its tilde.
    let fs = tree(&[("/work/simple", true), ("/home/me/store/shell.js", false)]);
    let shell = shell_module(
        "simple",
        Some("~/store/shell.js"),
        Path::new(HERE),
        Some(Path::new(HOME)),
        &fs,
        &no_files,
    )
    .unwrap();
    assert_eq!(shell.root, PathBuf::from("/home/me/store"));
    assert_eq!(shell.module, PathBuf::from("shell.js"));
}

#[test]
fn a_slash_is_still_a_path_even_then() {
    // A handed-in module and a path conflict. Both are reported as given, since
    // neither has been resolved.
    let fs = tree(&[
        ("/work/dist/shell.js", false),
        ("/store/page/shell.js", false),
    ]);
    assert_eq!(
        shell_module(
            "./dist/shell.js",
            Some("/store/page/shell.js"),
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &no_files
        ),
        Err(ShellPathError::TwoPages {
            page: "/store/page/shell.js".to_string(),
            argument: "./dist/shell.js".to_string(),
        })
    );
}

#[test]
fn a_bare_name_with_no_module_behind_it_is_not_a_shell() {
    // The binary builds nothing, so a bare name with no handed-in module is
    // refused as missing. It is reported as typed, since a name is not resolved
    // to a path.
    let fs = tree(&[]);
    assert_eq!(
        shell_module(
            "simple",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &no_files
        ),
        Err(ShellPathError::NotThere("simple".to_string()))
    );
}

#[test]
fn a_path_to_nothing_is_refused_before_anything_starts() {
    // Catching a typo here avoids starting the engine only to show an empty
    // window.
    let fs = tree(&[("/work/dist", true)]);
    assert_eq!(
        shell_module(
            "./dist/shell.js",
            None,
            Path::new(HERE),
            Some(Path::new(HOME)),
            &fs,
            &no_files
        ),
        Err(ShellPathError::NotThere("/work/dist/shell.js".to_string()))
    );
}

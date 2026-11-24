//! What `domicile open` does with a file, folder or address.

use std::fs;
use std::path::Path;

use domicile_launch::open::{
    app_opening, claimable, opener, opening, AppOpening, OpenError, Opening, Places,
};

/// A directory holding `files`, as relative paths and text.
fn written(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a directory to write in");
    for (path, text) in files {
        let at = dir.path().join(path);
        fs::create_dir_all(at.parent().expect("a parent")).unwrap();
        fs::write(at, text).unwrap();
    }
    dir
}

fn app(exec: &str, types: &str) -> String {
    format!("[Desktop Entry]\nType=Application\nName=App\nExec={exec}\nMimeType={types}\n")
}

/// A desk whose data directory is `data` and whose one `mimeapps.list` is
/// `defaults`.
fn places(data: &Path, defaults: &str) -> Places {
    let list = data.join("mimeapps.list");
    fs::write(&list, format!("[Default Applications]\n{defaults}")).unwrap();
    Places {
        data_dirs: vec![data.to_path_buf()],
        lists: vec![list],
        terminal: None,
    }
}

fn desk() -> tempfile::TempDir {
    written(&[
        ("mime/globs2", "50:text/markdown:*.md\n50:image/png:*.png\n"),
        ("applications/editor.desktop", &app("editor -c %F", "")),
        (
            "applications/viewer.desktop",
            &app("viewer %f", "image/png;"),
        ),
        (
            "applications/mail.desktop",
            &app("mail %u", "x-scheme-handler/mailto;"),
        ),
    ])
}

#[test]
fn a_web_address_opens_in_a_browser_window() {
    let desk = desk();
    let places = places(desk.path(), "");

    assert_eq!(
        opening("https://example.com/a", Path::new("/"), &places),
        Ok(Opening::Browse("https://example.com/a".into()))
    );
}

#[test]
fn a_file_opens_with_its_types_default_by_its_absolute_path() {
    let desk = desk();
    let home = written(&[("notes/a b.png", "")]);
    let places = places(desk.path(), "");

    assert_eq!(
        opening("notes/a b.png", home.path(), &places),
        Ok(Opening::Run(vec![
            "viewer".into(),
            home.path().join("notes/a b.png").display().to_string()
        ]))
    );
}

#[test]
fn text_and_folders_open_with_what_text_plain_and_folders_default_to() {
    let desk = desk();
    let home = written(&[("a.md", "# hi"), ("README", "hi"), ("dir/x", "")]);
    let places = places(
        desk.path(),
        "text/plain=editor.desktop\ninode/directory=editor.desktop\n",
    );
    let opened = |target: &str| match opening(target, home.path(), &places) {
        Ok(Opening::Run(argv)) => argv,
        other => panic!("{target} should run something: {other:?}"),
    };

    for target in ["a.md", "README", "dir"] {
        assert_eq!(
            opened(target),
            [
                "editor".to_string(),
                "-c".into(),
                home.path().join(target).display().to_string()
            ]
        );
    }
}

#[test]
fn a_file_url_opens_as_its_file() {
    let desk = desk();
    let home = written(&[("a b.png", "")]);
    let places = places(desk.path(), "");
    let url = format!("file://{}/a%20b.png", home.path().display());

    assert_eq!(
        opening(&url, Path::new("/"), &places),
        Ok(Opening::Run(vec![
            "viewer".into(),
            home.path().join("a b.png").display().to_string()
        ]))
    );
}

#[test]
fn another_scheme_opens_with_its_handler() {
    let desk = desk();
    let places = places(desk.path(), "");

    assert_eq!(
        opening("mailto:a@example.com", Path::new("/"), &places),
        Ok(Opening::Run(vec![
            "mail".into(),
            "mailto:a@example.com".into()
        ]))
    );
}

#[test]
fn nothing_to_open_it_with_names_its_type() {
    let desk = desk();
    let home = written(&[("a.md", "# hi")]);
    let places = places(desk.path(), "");

    assert_eq!(
        opening("a.md", home.path(), &places),
        Err(OpenError::NoApplication {
            target: "a.md".into(),
            mime: "text/markdown".into()
        })
    );
    assert_eq!(
        opening("slack://open", Path::new("/"), &places),
        Err(OpenError::NoApplication {
            target: "slack://open".into(),
            mime: "x-scheme-handler/slack".into()
        })
    );
}

#[test]
fn a_missing_file_is_an_error() {
    let desk = desk();
    let home = written(&[]);
    let places = places(desk.path(), "");

    assert!(matches!(
        opening("gone.md", home.path(), &places),
        Err(OpenError::Unreadable { .. })
    ));
}

#[test]
fn a_file_url_drops_its_query_and_fragment_and_may_be_relative() {
    let desk = desk();
    let home = written(&[("a.png", "")]);
    let places = places(desk.path(), "");
    let viewed = Ok(Opening::Run(vec![
        "viewer".into(),
        home.path().join("a.png").display().to_string(),
    ]));

    assert_eq!(
        opening(
            &format!("file://{}/a.png?x=1#top", home.path().display()),
            Path::new("/"),
            &places
        ),
        viewed
    );
    assert_eq!(opening("file:a.png", home.path(), &places), viewed);
}

#[test]
fn a_default_listed_under_an_alias_opens_the_type() {
    let desk = desk();
    fs::write(
        desk.path().join("mime/aliases"),
        "text/x-markdown text/markdown\n",
    )
    .unwrap();
    let home = written(&[("a.md", "# hi")]);
    let places = places(desk.path(), "text/x-markdown=viewer.desktop\n");

    assert_eq!(
        opening("a.md", home.path(), &places),
        Ok(Opening::Run(vec![
            "viewer".into(),
            home.path().join("a.md").display().to_string()
        ]))
    );
}

#[test]
fn a_handler_that_would_open_it_again_is_an_error() {
    let desk = desk();
    fs::write(
        desk.path().join("applications/opener.desktop"),
        app("xdg-open %u", "x-scheme-handler/slack;"),
    )
    .unwrap();
    let places = places(desk.path(), "");

    assert!(matches!(
        opening("slack://open", Path::new("/"), &places),
        Err(OpenError::Loop { .. })
    ));
}

#[test]
fn a_mail_handler_that_runs_xdg_email_is_an_error() {
    // The desktop's `xdg-email` is `domicile open` too.
    let desk = desk();
    fs::write(
        desk.path().join("applications/mailer.desktop"),
        app("xdg-email %u", "x-scheme-handler/mailto;"),
    )
    .unwrap();
    let places = places(desk.path(), "x-scheme-handler/mailto=mailer.desktop\n");

    assert!(matches!(
        opening("mailto:a@example.com", Path::new("/"), &places),
        Err(OpenError::Loop { .. })
    ));
}

#[test]
fn a_handler_that_opens_an_app_window_is_no_loop() {
    let desk = desk();
    fs::write(
        desk.path().join("applications/web-mail.desktop"),
        app(
            "domicile open --app https://mail.example/?to=%u",
            "x-scheme-handler/slack;",
        ),
    )
    .unwrap();
    let places = places(desk.path(), "");

    assert!(matches!(
        opening("slack://open", Path::new("/"), &places),
        Ok(Opening::Run(_))
    ));
}

#[test]
fn a_handler_that_runs_an_electron_app_on_the_engine_is_no_loop() {
    // The entry `electron.apps` writes for Slack.
    let desk = desk();
    fs::write(
        desk.path().join("applications/slack.desktop"),
        app(
            "domicile open --electron slack.desktop -- /opt/slack/slack -s %U",
            "x-scheme-handler/slack;",
        ),
    )
    .unwrap();
    let places = places(desk.path(), "");

    assert_eq!(
        opening("slack://open", Path::new("/"), &places),
        Ok(Opening::Run(vec![
            "domicile".into(),
            "open".into(),
            "--electron".into(),
            "slack.desktop".into(),
            "--".into(),
            "/opt/slack/slack".into(),
            "-s".into(),
            "slack://open".into(),
        ]))
    );
}

#[test]
fn a_file_url_decodes_only_hex_escapes_and_no_path_is_the_root() {
    let desk = desk();
    let home = written(&[("a%+1b", "\0")]);
    let places = places(
        desk.path(),
        "application/octet-stream=viewer.desktop\ninode/directory=viewer.desktop\n",
    );

    assert_eq!(
        opening(
            &format!("file://{}/a%+1b", home.path().display()),
            Path::new("/"),
            &places
        ),
        Ok(Opening::Run(vec![
            "viewer".into(),
            home.path().join("a%+1b").display().to_string()
        ]))
    );
    assert_eq!(
        opening("file://localhost", home.path(), &places),
        Ok(Opening::Run(vec!["viewer".into(), "/".into()]))
    );
}

mod as_an_app {
    use super::*;

    #[test]
    fn an_address_opens_in_an_app_window() {
        assert_eq!(
            app_opening("https://example.com", Path::new("/")),
            Ok(AppOpening::Address("https://example.com".into()))
        );
    }

    #[test]
    fn a_module_runs_and_a_page_or_folder_opens_by_address() {
        let home = written(&[("app.js", ""), ("page.html", ""), ("site/index.html", "")]);
        let here = home.path();
        let address = |name: &str| format!("file://{}/{name}", here.display());

        assert_eq!(
            app_opening("app.js", here),
            Ok(AppOpening::Module("app.js".into()))
        );
        assert_eq!(
            app_opening("page.html", here),
            Ok(AppOpening::Address(address("page.html")))
        );
        assert_eq!(
            app_opening("site", here),
            Ok(AppOpening::Address(address("site")))
        );
    }

    #[test]
    fn a_missing_module_is_an_error() {
        let home = written(&[]);

        assert!(matches!(
            app_opening("gone.js", home.path()),
            Err(OpenError::NoModule { .. })
        ));
    }
}

#[test]
fn the_opener_is_the_application_opening_runs() {
    let desk = desk();
    let home = written(&[("a.png", ""), ("a.md", "# hi")]);
    let places = places(desk.path(), "text/plain=editor.desktop\n");

    assert_eq!(
        opener("a.png", home.path(), &places),
        Ok(Some("viewer.desktop".into()))
    );
    assert_eq!(
        opener("a.md", home.path(), &places),
        Ok(Some("editor.desktop".into()))
    );
    assert_eq!(
        opener("https://example.com", home.path(), &places),
        Ok(None)
    );
}

#[test]
fn a_terminal_application_opens_in_the_desks_terminal() {
    let desk = written(&[
        ("mime/globs2", "50:text/markdown:*.md\n"),
        (
            "applications/vim.desktop",
            "[Desktop Entry]\nType=Application\nName=Vim\nExec=vim %F\nTerminal=true\nMimeType=text/markdown;\n",
        ),
    ]);
    let home = written(&[("a.md", "# hi")]);
    let mut places = places(desk.path(), "");
    places.terminal = Some(vec!["foot".into()]);

    assert_eq!(
        opening("a.md", home.path(), &places),
        Ok(Opening::Run(vec![
            "foot".into(),
            "vim".into(),
            home.path().join("a.md").display().to_string()
        ]))
    );
}

#[test]
fn without_a_terminal_a_terminal_application_opens_nothing() {
    let desk = written(&[
        ("mime/globs2", "50:text/markdown:*.md\n"),
        (
            "applications/vim.desktop",
            "[Desktop Entry]\nType=Application\nName=Vim\nExec=vim %F\nTerminal=true\nMimeType=text/markdown;\n",
        ),
    ]);
    let home = written(&[("a.md", "# hi")]);
    let places = places(desk.path(), "");

    assert!(matches!(
        opening("a.md", home.path(), &places),
        Err(OpenError::NoApplication { .. })
    ));
}

#[test]
fn a_shell_may_claim_a_link_but_not_a_web_address_or_a_file() {
    assert!(claimable("mailto:a@example.com"));
    assert!(claimable("MAILTO:a@example.com"));
    assert!(claimable("zoommtg://zoom.us/join"));
    assert!(!claimable("https://example.com/"));
    assert!(!claimable("HTTP://example.com/"));
    assert!(!claimable("file:///etc/hosts"));
    assert!(!claimable("notes.md"));
}

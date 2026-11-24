//! What `domicile open --electron` takes from an app's wrapper scripts: the
//! environment and arguments they give the Electron program they end in.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use domicile_launch::electron_wrapper::{through_wrappers, Launch, WrapperError};

fn write(root: &Path, path: &str, text: &str) -> PathBuf {
    let at = root.join(path);
    fs::create_dir_all(at.parent().expect("a parent")).unwrap();
    fs::write(&at, text).unwrap();
    fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
    fs::canonicalize(at).unwrap()
}

fn bash() -> String {
    String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v bash"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string()
}

/// An install as a bundled app ships: its binary beside `resources/`, which
/// never runs, as the wrapper's exec stops before it.
fn bundled(root: &Path) -> (PathBuf, PathBuf) {
    write(root, "opt/Claude/resources/app.asar", "asar");
    let binary = write(root, "opt/Claude/claude", "\x7fELF never run");
    (binary, root.join("opt/Claude/resources"))
}

const WAIT: Duration = Duration::from_secs(10);

fn env_of<'a>(launch: &'a Launch, name: &str) -> Option<&'a str> {
    launch
        .env
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

#[test]
fn a_wrappers_environment_and_flags_reach_the_app() {
    let root = tempfile::tempdir().unwrap();
    let (binary, resources) = bundled(root.path());
    let wrapper = write(
        root.path(),
        "bin/claude",
        &format!(
            "#! {} -e\nPATH=/opt/qemu/bin${{PATH:+:$PATH}}\nexport PATH\n\
             export LD_PRELOAD=/lib/libsqlcipher.so\n\
             exec -a \"$0\" \"{}\" --password-store=gnome-libsecret \"$@\"\n",
            bash(),
            binary.display()
        ),
    );

    let launch = through_wrappers(
        &[wrapper.display().to_string(), "-u".into()],
        &resources,
        Path::new(env!("CARGO_BIN_EXE_domicile")),
        WAIT,
    )
    .unwrap();

    assert_eq!(
        launch.args,
        vec!["--password-store=gnome-libsecret".to_string(), "-u".into()]
    );
    assert_eq!(env_of(&launch, "LD_PRELOAD"), Some("/lib/libsqlcipher.so"));
    assert!(env_of(&launch, "PATH")
        .unwrap()
        .starts_with("/opt/qemu/bin:"));
    assert_eq!(env_of(&launch, "BASH_ENV"), None);
    assert_eq!(env_of(&launch, "DOMICILE_ELECTRON_RECORDER"), None);
    // What the desk gave `domicile open` reaches the app too.
    assert_eq!(
        env_of(&launch, "HOME"),
        std::env::var("HOME").ok().as_deref()
    );
}

#[test]
fn every_wrapper_in_a_chain_has_its_say() {
    // As nixpkgs wraps Element: a wrapper adding flags, one preloading a
    // library, then Electron's own, given the app's archive.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "element/share/element/app.asar", "asar");
    let electron = write(
        root.path(),
        "electron/libexec/electron",
        "\x7fELF never run",
    );
    let electron_wrapper = write(
        root.path(),
        "electron/bin/electron",
        &format!(
            "#! {} -e\nexport CHROME_DEVEL_SANDBOX=/sandbox\nexec \"{}\" \"$@\"\n",
            bash(),
            electron.display()
        ),
    );
    let unwrapped = write(
        root.path(),
        "element/bin/.element-desktop-wrapped",
        &format!(
            "#! {} -e\nexport LD_PRELOAD=/lib/libsqlcipher.so\n\
             exec -a \"$0\" \"{}\" {} \"$@\"\n",
            bash(),
            electron_wrapper.display(),
            root.path().join("element/share/element/app.asar").display(),
        ),
    );
    let wrapper = write(
        root.path(),
        "with-flags/bin/element-desktop",
        &format!(
            "#! {} -e\nexec \"{}\" --ozone-platform-hint=auto \"$@\"\n",
            bash(),
            unwrapped.display()
        ),
    );

    let launch = through_wrappers(
        &[wrapper.display().to_string(), "--hidden".into()],
        &fs::canonicalize(root.path().join("element/share/element")).unwrap(),
        Path::new(env!("CARGO_BIN_EXE_domicile")),
        WAIT,
    )
    .unwrap();

    // The archive is the app, not one of its arguments.
    assert_eq!(
        launch.args,
        vec!["--ozone-platform-hint=auto".to_string(), "--hidden".into()]
    );
    assert_eq!(env_of(&launch, "LD_PRELOAD"), Some("/lib/libsqlcipher.so"));
    assert_eq!(env_of(&launch, "CHROME_DEVEL_SANDBOX"), Some("/sandbox"));
}

#[test]
fn a_program_that_is_no_bash_script_has_no_wrapper_to_follow() {
    let root = tempfile::tempdir().unwrap();
    let (binary, resources) = bundled(root.path());

    assert_eq!(
        through_wrappers(
            &[binary.display().to_string()],
            &resources,
            Path::new(env!("CARGO_BIN_EXE_domicile")),
            WAIT
        ),
        Err(WrapperError::NotBash {
            program: binary.display().to_string()
        })
    );
}

#[test]
fn a_wrapper_that_never_reaches_the_app_says_so() {
    let root = tempfile::tempdir().unwrap();
    let (_, resources) = bundled(root.path());
    let wrapper = write(
        root.path(),
        "bin/claude",
        &format!("#! {}\necho no app here\nexit 4\n", bash()),
    );

    assert!(matches!(
        through_wrappers(
            &[wrapper.display().to_string()],
            &resources,
            Path::new(env!("CARGO_BIN_EXE_domicile")),
            WAIT
        ),
        Err(WrapperError::NoLaunch { .. })
    ));
}

#[test]
fn a_wrapper_ending_in_some_other_program_says_so() {
    let root = tempfile::tempdir().unwrap();
    let (_, resources) = bundled(root.path());
    let other = write(root.path(), "bin/other", "\x7fELF never run");
    let wrapper = write(
        root.path(),
        "bin/claude",
        &format!("#! {}\nexec \"{}\" \"$@\"\n", bash(), other.display()),
    );

    assert!(matches!(
        through_wrappers(
            &[wrapper.display().to_string()],
            &resources,
            Path::new(env!("CARGO_BIN_EXE_domicile")),
            WAIT
        ),
        Err(WrapperError::NotTheApp { .. })
    ));
}

#[test]
fn a_wrapper_still_open_for_writing_runs_once_it_is_closed() {
    let root = tempfile::tempdir().unwrap();
    let (binary, resources) = bundled(root.path());
    let wrapper = write(
        root.path(),
        "bin/claude",
        &format!("#! {}\nexec \"{}\" \"$@\"\n", bash(), binary.display()),
    );
    // As another thread's fork leaves it for a moment: open for writing, so
    // exec fails with ETXTBSY until it closes.
    let writer = fs::OpenOptions::new().append(true).open(&wrapper).unwrap();
    let closer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        drop(writer);
    });

    let launch = through_wrappers(
        &[wrapper.display().to_string()],
        &resources,
        Path::new(env!("CARGO_BIN_EXE_domicile")),
        WAIT,
    );
    closer.join().unwrap();

    assert!(launch.is_ok(), "{launch:?}");
}

/// A compiled wrapper as nixpkgs' `makeBinaryWrapper` writes it: an ELF
/// program that keeps, as text, the `makeCWrapper` command that made it.
fn compiled(root: &Path, path: &str, command: &str) -> PathBuf {
    let mut bytes = b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0\x03\0\x3e\0\xe8\x1f\0".to_vec();
    bytes.extend_from_slice(
        format!(
            "\n\n\n# {rule}\n# The C-code for this binary wrapper has been generated \
             using the following command:\n\n\n{command}\n\n\n# (Use `nix-shell -p \
             makeBinaryWrapper` to get access to makeCWrapper in your shell)\n# {rule}\n\n\n\0",
            rule = "-".repeat(84),
        )
        .as_bytes(),
    );
    bytes.extend_from_slice(b"\x90\xc3\0");
    let at = root.join(path);
    fs::create_dir_all(at.parent().expect("a parent")).unwrap();
    fs::write(&at, bytes).unwrap();
    fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
    fs::canonicalize(at).unwrap()
}

#[test]
fn compiled_wrappers_have_their_say_too() {
    // As nixpkgs wraps ChatGPT, and the user's config wraps it again: two
    // compiled wrappers, then a launcher script that execs the Electron
    // binary a variable names.
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "chatgpt/lib/chatgpt/resources/app.asar",
        "asar",
    );
    let electron = write(
        root.path(),
        "chatgpt/lib/chatgpt/ChatGPT",
        "\x7fELF never run",
    );
    let launcher = write(
        root.path(),
        "chatgpt/bin/.chatgpt-wrapped_",
        &format!(
            "#! {} -e\nexport CODEX_RESOURCES=/cache\n\
             exec \"$CHATGPT_EXECUTABLE\" --from-launcher \"$@\"\n",
            bash()
        ),
    );
    let inner = compiled(
        root.path(),
        "chatgpt/bin/.chatgpt-wrapped",
        &format!(
            "makeCWrapper '{}' \\\n    --set 'CHATGPT_EXECUTABLE' '{}' \\\n    \
             --prefix 'PATH' ':' '/opt/node/bin' \\\n    \
             --set-default 'GIO_EXTRA_MODULES' '/gio' \\\n    \
             --add-flags '--password-store=gnome-libsecret --x'",
            launcher.display(),
            electron.display()
        ),
    );
    let outer = compiled(
        root.path(),
        "chatgpt/bin/chatgpt",
        &format!(
            "makeCWrapper '{}' \\\n    --set-default 'NIXOS_OZONE_WL' '1' \\\n    \
             --append-flag 'it'\\''s last'",
            inner.display()
        ),
    );

    let launch = through_wrappers(
        &[outer.display().to_string(), "--hidden".into()],
        &fs::canonicalize(root.path().join("chatgpt/lib/chatgpt/resources")).unwrap(),
        Path::new(env!("CARGO_BIN_EXE_domicile")),
        WAIT,
    )
    .unwrap();

    assert_eq!(
        launch.args,
        vec![
            "--from-launcher".to_string(),
            "--password-store=gnome-libsecret".into(),
            "--x".into(),
            "--hidden".into(),
            "it's last".into(),
        ]
    );
    assert_eq!(env_of(&launch, "NIXOS_OZONE_WL"), Some("1"));
    assert_eq!(env_of(&launch, "CHATGPT_EXECUTABLE"), electron.to_str());
    assert_eq!(env_of(&launch, "GIO_EXTRA_MODULES"), Some("/gio"));
    assert_eq!(env_of(&launch, "CODEX_RESOURCES"), Some("/cache"));
    assert!(env_of(&launch, "PATH")
        .unwrap()
        .starts_with("/opt/node/bin:"));
    assert_eq!(env_of(&launch, "BASH_ENV"), None);
    assert_eq!(env_of(&launch, "DOMICILE_ELECTRON_BASH"), None);
}

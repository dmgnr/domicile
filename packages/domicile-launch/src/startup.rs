//! What a desktop prints as it starts.
//!
//! - On a terminal, a block: the version, a row per choice, a tick per part
//!   that comes up, then how to stop. See `docs/CLI.md#domicile-shell`.
//! - Off one, a line when it is up: what it chose and where to reach it.
//!   Scripts wait for its start, `domicile is up.`, and read
//!   `DOMICILE_SOCK=` from its end.

use std::path::Path;
use std::time::Duration;

use crate::control_socket::VARIABLE;
use crate::paint::{Paint, Style};

/// The block's first line: `domicile`, then the version from the first line
/// of `--version`, when it reads.
pub fn heading(paint: Paint, version: Option<&str>) -> String {
    let number = version
        .and_then(|said| said.strip_prefix("domicile "))
        .map(|number| format!(" {}", paint.style(Style::Dim, number)));
    format!(
        "{}{}",
        paint.style(Style::Bold, "domicile"),
        number.unwrap_or_default()
    )
}

/// One choice, its label padded so the values line up.
pub fn row(paint: Paint, label: &str, value: &str) -> String {
    format!(
        "  {}  {value}",
        paint.style(Style::Dim, &format!("{label:<8}"))
    )
}

/// `said` with a leading home directory written `~`.
pub fn at_home(said: &str, home: Option<&Path>) -> String {
    let home = home.map(|home| home.to_string_lossy());
    match home.as_deref().and_then(|home| said.strip_prefix(home)) {
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => said.to_string(),
    }
}

/// A part that came up, with what to know about it.
pub fn done(paint: Paint, what: &str, detail: Option<&str>) -> String {
    let detail = detail
        .map(|detail| format!(" {}", paint.style(Style::Dim, &format!("· {detail}"))))
        .unwrap_or_default();
    format!("  {} {what}{detail}", paint.style(Style::Good, "✓"))
}

/// The shell built, and how long it took.
pub fn built_in(paint: Paint, took: Duration) -> String {
    format!(
        "  {} Shell built {}",
        paint.style(Style::Good, "✓"),
        paint.style(Style::Dim, &format!("in {:.1} s", took.as_secs_f64()))
    )
}

/// The block's last line, once the desktop is up.
pub fn running(paint: Paint) -> String {
    format!(
        "{} {}",
        paint.style(Style::Heading, "Desktop running."),
        paint.style(Style::Dim, "Ctrl-C to stop.")
    )
}

/// What a desktop started with.
#[derive(Debug, Clone, Copy)]
pub struct Chosen<'a> {
    /// The first line of `--version`, when it reads.
    pub version: Option<&'a str>,
    pub shell: &'a Path,
    pub config: &'a str,
    pub profile: &'a Path,
    pub platform: &'a str,
    pub on_the_cpu: bool,
    /// The control socket.
    pub socket: &'a Path,
}

/// The line that says the desktop is up.
pub fn up_line(started: &Chosen) -> String {
    let facts: Vec<String> = started
        .version
        .map(str::to_string)
        .into_iter()
        .chain([
            format!("shell {}", started.shell.display()),
            format!("config {}", started.config),
            format!("profile {}", started.profile.display()),
            format!("platform {}", started.platform),
        ])
        .chain(
            started
                .on_the_cpu
                .then(|| "the engine composites on the CPU".to_string()),
        )
        .chain([format!("{VARIABLE}={}", started.socket.display())])
        .collect();
    format!("domicile is up. {}", facts.join(" · "))
}

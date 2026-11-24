//! Parses the shell builder's stdout and renders it as a progress bar.
//!
//! The builder writes one JSON line per step, ending with `built` or `failed`,
//! or, serving a shell for `domicile dev`, `serving` until it is stopped.
//! Other lines are build log, kept to show if the build fails.

use std::path::PathBuf;

use serde::Deserialize;

use crate::paint::{Paint, Style};
use crate::shell_path::{Shell, ShellFiles};

/// A build step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Resolving,
    Installing(Vec<String>),
    Bundling,
}

/// One parsed line of the builder's stdout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Heard {
    Step(Step),
    /// The built module and the directory it is served from.
    Built(Shell),
    /// A dev server is serving the shell, until it is stopped.
    Serving(Shell),
    /// A config module was evaluated to this JSON file.
    Evaluated(PathBuf),
    /// The build failed, with the builder's message.
    Failed(String),
    /// A build log line.
    Log(String),
}

#[derive(Deserialize)]
#[serde(tag = "step", rename_all = "lowercase")]
enum Line {
    Resolving,
    Installing { packages: Vec<String> },
    Bundling,
    Built { root: PathBuf, module: PathBuf },
    Evaluated { config: PathBuf },
    Serving { socket: PathBuf, module: PathBuf },
    Failed { why: String },
}

/// Parses one line of builder output.
pub fn heard(line: &str) -> Heard {
    match serde_json::from_str::<Line>(line) {
        Ok(Line::Resolving) => Heard::Step(Step::Resolving),
        Ok(Line::Installing { packages }) => Heard::Step(Step::Installing(packages)),
        Ok(Line::Bundling) => Heard::Step(Step::Bundling),
        Ok(Line::Built { root, module }) => Heard::Built(Shell {
            root,
            module,
            files: ShellFiles::Directory,
        }),
        Ok(Line::Evaluated { config }) => Heard::Evaluated(config),
        Ok(Line::Serving { socket, module }) => Heard::Serving(Shell {
            root: socket,
            module,
            files: ShellFiles::DevServer,
        }),
        Ok(Line::Failed { why }) => Heard::Failed(why),
        Err(_) => Heard::Log(line.to_string()),
    }
}

/// Renders `step` as a terminal progress line, its mark filling with the
/// steps.
pub fn bar(paint: Paint, step: &Step) -> String {
    let (mark, saying) = match step {
        Step::Resolving => ("⠁", "reading what it imports".to_string()),
        Step::Installing(packages) => ("⠃", format!("installing {}", packages.join(", "))),
        Step::Bundling => ("⠇", "bundling".to_string()),
    };
    format!(
        "  {} Building shell {} {saying}",
        paint.style(Style::Placeholder, mark),
        paint.style(Style::Dim, "·")
    )
}

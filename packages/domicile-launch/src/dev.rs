//! What `domicile dev` asks the desktop for.
//!
//! `domicile dev <entry>` runs the builder's dev server on a socket, loads the
//! shell from it, and on Ctrl-C loads the shell it replaced again. See
//! docs/WRITING-A-SHELL.md#hot-module-replacement.

use std::path::{Path, PathBuf};

use crate::control::{Request, Response};
use crate::shell_path::{Shell, ShellFiles};

/// Where the dev server of the `domicile dev` with process id `pid` listens:
/// in the user's runtime directory, which only they can open.
pub fn dev_socket(runtime: &Path, pid: u32) -> PathBuf {
    runtime.join(format!("domicile-dev.{pid}.sock"))
}

/// The request that serves `shell`.
pub fn loading(shell: &Shell) -> Request {
    Request::LoadShell {
        dev_server: shell.files == ShellFiles::DevServer,
        module: shell.module.clone(),
        root: shell.root.clone(),
    }
}

/// The request that loads again the shell `which-shell` answered with, or why
/// there is none.
pub fn going_back(answer: Response) -> Result<Request, String> {
    match answer {
        Response::Shell {
            module,
            root,
            dev_server,
        } => {
            let relative = module.strip_prefix(&root).map_err(|_| {
                format!(
                    "the desktop serves {} from {}, which does not hold it",
                    module.display(),
                    root.display()
                )
            })?;
            Ok(Request::LoadShell {
                dev_server,
                module: relative.to_path_buf(),
                root,
            })
        }
        Response::Refused { why } => Err(format!(
            "the desktop would not say which shell it serves: {why}"
        )),
        other => Err(format!(
            "the desktop answered which-shell with {other:?}, which is not a shell"
        )),
    }
}

//! Asking the engine to serve a shell, and recording which one it serves.

use std::sync::Mutex;

use crate::command_socket::CommandError;
use crate::shell_path::Shell;

/// Asks the engine to serve `page` with `load` until it answers, and records
/// `page` in `serving` once the engine takes it.
///
/// [`CommandError::NoEngine`] and [`CommandError::NoShellWindow`] are asked
/// again after `wait` until `given_up`. Any other answer is final, and a
/// refusal leaves `serving` as it was. `serving`'s lock is held across each
/// ask, so concurrent loads record the shell the engine took last.
pub fn serve(
    page: &Shell,
    serving: &Mutex<Shell>,
    load: &dyn Fn(&Shell) -> Result<(), CommandError>,
    given_up: &dyn Fn() -> bool,
    wait: &mut dyn FnMut(),
) -> Result<(), CommandError> {
    when_the_engine_answers(
        &mut || {
            let mut served = serving
                .lock()
                .expect("nothing panics holding which shell is served");
            load(page)?;
            *served = page.clone();
            Ok(())
        },
        given_up,
        wait,
    )
}

/// Calls `load` until the engine answers it.
///
/// The engine may not have bound its command socket yet, may have no shell
/// window until its first page commits, or may be being replaced after a
/// crash. Those answers are asked again after `wait` until `given_up`.
fn when_the_engine_answers(
    load: &mut dyn FnMut() -> Result<(), CommandError>,
    given_up: &dyn Fn() -> bool,
    wait: &mut dyn FnMut(),
) -> Result<(), CommandError> {
    loop {
        match load() {
            Err(CommandError::NoEngine { .. } | CommandError::NoShellWindow) if !given_up() => {
                wait()
            }
            answered => return answered,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::Cell;
    use std::path::PathBuf;

    use crate::shell_path::ShellFiles;

    fn shell(root: &str) -> Shell {
        Shell {
            module: PathBuf::from("shell.js"),
            root: PathBuf::from(root),
            files: ShellFiles::Directory,
        }
    }

    #[test]
    fn a_shell_the_engine_takes_after_a_missing_window_is_served() {
        let serving = Mutex::new(shell("/desktops/old"));
        let answers = Cell::new(0);
        let loaded = serve(
            &shell("/desktops/new"),
            &serving,
            &|_| {
                answers.set(answers.get() + 1);
                match answers.get() {
                    2 => Ok(()),
                    _ => Err(CommandError::NoShellWindow),
                }
            },
            &|| false,
            &mut || {},
        );
        assert_eq!(
            (loaded, serving.into_inner().expect("not poisoned")),
            (Ok(()), shell("/desktops/new"))
        );
    }

    #[test]
    fn a_refused_shell_is_final_and_leaves_the_served_one() {
        let serving = Mutex::new(shell("/desktops/old"));
        let refused = CommandError::Refused {
            why: "no Shell export".to_string(),
        };
        let loaded = serve(
            &shell("/desktops/new"),
            &serving,
            &|_| Err(refused.clone()),
            &|| false,
            &mut || panic!("a refusal is not asked again"),
        );
        assert_eq!(
            (loaded, serving.into_inner().expect("not poisoned")),
            (Err(refused), shell("/desktops/old"))
        );
    }

    fn starting() -> CommandError {
        CommandError::NoEngine {
            path: "command.sock".to_string(),
        }
    }

    #[test]
    fn an_engine_still_starting_is_asked_again() {
        let answers = Cell::new(0);
        let waits = Cell::new(0);
        let loaded = when_the_engine_answers(
            &mut || {
                answers.set(answers.get() + 1);
                match answers.get() {
                    3 => Ok(()),
                    _ => Err(starting()),
                }
            },
            &|| false,
            &mut || waits.set(waits.get() + 1),
        );
        assert_eq!((loaded, answers.get(), waits.get()), (Ok(()), 3, 2));
    }

    #[test]
    fn an_engine_that_never_starts_is_given_up_on() {
        let loaded = when_the_engine_answers(&mut || Err(starting()), &|| true, &mut || {
            panic!("given up on, so not waited for")
        });
        assert_eq!(loaded, Err(starting()));
    }
}

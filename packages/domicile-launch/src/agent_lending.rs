//! `domicile agent`: an agent, such as `domicile mcp`'s, let in to see and
//! use the desk while the command runs. See `docs/AGENTS.md`.
//!
//! The command sends [`Request::Agent`] to the control socket, which lends
//! the connection to [`admit`]. That asks the compositor, which asks the
//! user, and forwards each [`Request::AgentDid`] the command sends and each
//! change the user makes to what it reaches. Either
//! side hanging up ends it: the command's takes the agent off the shell's
//! list, the compositor's (the shell stopped it) hangs up on the command.

use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::compositor_socket::agent;
use crate::control::{to_line, Admission, Request, Response};

/// How long the user has to answer: the compositor's minute, and some.
pub const DECIDING_WITHIN: Duration = Duration::from_secs(75);

/// Holds the agent `admission` asks for, from the compositor at `chrome`,
/// until either side hangs up. `patience` covers the user deciding.
pub fn admit(admission: Admission, chrome: &Path, patience: Duration) {
    let Admission {
        agent: name,
        lines,
        mut client,
    } = admission;
    let held = match agent(chrome, &name, Some(patience)) {
        Ok(held) => Arc::new(held),
        Err(why) => {
            // The client may be gone already; there is no one else to tell.
            let _ = client.write_all(
                to_line(&Response::Refused {
                    why: why.to_string(),
                })
                .as_bytes(),
            );
            return;
        }
    };
    let answered = client.write_all(
        to_line(&Response::Agent {
            reach: held.reach().clone(),
        })
        .as_bytes(),
    );
    // Each change the user makes is told to the client as another
    // `Response::Agent`. The shell stopping it hangs up on the client, which
    // ends the loop below.
    let watching = match (answered, client.try_clone()) {
        (Ok(()), Ok(mut telling)) => {
            let held = Arc::clone(&held);
            Some(std::thread::spawn(move || {
                while let Some(reach) = held.changed() {
                    let told = to_line(&Response::Agent { reach });
                    if telling.write_all(told.as_bytes()).is_err() {
                        break;
                    }
                }
                let _ = telling.shutdown(std::net::Shutdown::Both);
            }))
        }
        _ => None,
    };
    if watching.is_some() {
        for line in lines.lines() {
            let Ok(line) = line else { break };
            match serde_json::from_str::<Request>(line.trim()) {
                Ok(Request::AgentDid { said }) => {
                    if held.did(said).is_err() {
                        break;
                    }
                }
                // Not what an agent's connection carries; end it rather than
                // guess.
                _ => {
                    eprintln!("domicile: an agent's client sent '{line}', so it was let go");
                    break;
                }
            }
        }
    }
    held.give_back();
    if let Some(watching) = watching {
        let _ = watching.join();
    }
}

/// Sends a [`Request::AgentDid`] to `to` for each line of `typed`, until it
/// ends. A blank line is skipped.
pub fn forward_actions(typed: impl BufRead, mut to: impl Write) -> std::io::Result<()> {
    for line in typed.lines() {
        let line = line?;
        let said = line.trim();
        if said.is_empty() {
            continue;
        }
        to.write_all(
            to_line(&Request::AgentDid {
                said: said.to_string(),
            })
            .as_bytes(),
        )?;
    }
    Ok(())
}

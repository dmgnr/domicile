//! `domicile subscribe`: the compositor's answers for some topics, at once
//! and on every change, for as long as the command runs.
//!
//! The command sends [`Request::Subscribe`] to the control socket, which lends
//! the connection to [`follow`]. That asks the compositor to watch the topics
//! ([`crate::compositor_socket::watch`]) and forwards each line it says as a
//! [`Response::Heard`]. Either side hanging up ends it.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::Shutdown;
use std::path::Path;

use domicile_protocol::HostMessage;

use crate::compositor_socket::watch;
use crate::control::{to_line, Response, Subscription};

/// Forwards what the compositor at `chrome` says about `subscription`'s
/// topics to its client, until either hangs up.
pub fn follow(subscription: Subscription, chrome: &Path) {
    let Subscription { topics, mut client } = subscription;
    let compositor = match watch(chrome, &topics) {
        Ok(compositor) => compositor,
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
    // The client says nothing after its request, so a read that ends means it
    // hung up. Hanging up on the compositor then ends the loop below.
    let hanging_up = match (client.try_clone(), compositor.try_clone()) {
        (Ok(mut listening), Ok(compositor)) => std::thread::spawn(move || {
            let _ = listening.read_to_end(&mut Vec::new());
            let _ = compositor.shutdown(Shutdown::Both);
        }),
        _ => return,
    };
    for line in BufReader::new(&compositor).lines() {
        let Ok(line) = line else { break };
        let message = match serde_json::from_str::<HostMessage>(line.trim()) {
            Ok(message) => message,
            // Not what a watch carries; end it rather than guess.
            Err(_) => {
                let _ = client.write_all(
                    to_line(&Response::Refused {
                        why: format!("the compositor said '{line}', which is not a host message"),
                    })
                    .as_bytes(),
                );
                break;
            }
        };
        if client
            .write_all(to_line(&Response::Heard { message }).as_bytes())
            .is_err()
        {
            break;
        }
    }
    // The compositor went, or the client did: end both.
    let _ = client.shutdown(Shutdown::Both);
    let _ = compositor.shutdown(Shutdown::Both);
    let _ = hanging_up.join();
}

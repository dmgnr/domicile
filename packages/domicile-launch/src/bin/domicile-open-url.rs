//! `BROWSER` inside a desktop: opens its one address, or a path as a `file://`
//! URL, in a browser window of the running desktop.
//!
//! It always browses. `domicile open` would hand an HTML file back to its
//! type's default, which is this. Many programs run `BROWSER` as one word, so
//! it cannot hold a subcommand. See `domicile_launch::spawn`.

use std::process::ExitCode;

use domicile_launch::address::url_for;
use domicile_launch::control::Request;
use domicile_launch::control_socket::{advertised, ask, PATIENCE, VARIABLE};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [target] = args.as_slice() else {
        eprintln!(
            "domicile-open-url: takes one address to open, and was given {}",
            args.len()
        );
        return ExitCode::FAILURE;
    };
    match browsed(target) {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("domicile-open-url: {why}");
            ExitCode::FAILURE
        }
    }
}

/// Asks the running desktop to open `target` in a browser window.
fn browsed(target: &str) -> Result<(), String> {
    let here =
        std::env::current_dir().map_err(|why| format!("cannot tell where this was run: {why}"))?;
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let url = url_for(target, &here);
    ask(
        &socket,
        &Request::OpenUrl { url, profile: None },
        Some(PATIENCE),
    )
    .map(|_| ())
    .map_err(|why| why.to_string())
}

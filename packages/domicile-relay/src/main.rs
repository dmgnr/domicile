//! `domicile-relay`: see [`domicile_relay`].

use std::io::Read;
use std::net::TcpListener;
use std::process::ExitCode;

use domicile_relay::options::{options, USAGE};
use domicile_relay::Relay;

fn main() -> ExitCode {
    let options = match options(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(why) => {
            eprintln!("domicile-relay: {why}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let listening = TcpListener::bind(options.public)
        .and_then(|public| Ok((public, TcpListener::bind(options.desks)?)));
    let (public, desks) = match listening {
        Ok(listeners) => listeners,
        Err(why) => {
            eprintln!("domicile-relay: could not listen: {why}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "domicile-relay: desks under {} on {}, dialing in on {}",
        options.zone, options.public, options.desks
    );
    let relay = Relay::new(&options.zone, || {
        let mut bytes = [0; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut bytes))
            .expect("/dev/urandom gives secrets");
        bytes
    });
    match relay.serve(public, desks) {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("domicile-relay: {why}");
            ExitCode::FAILURE
        }
    }
}

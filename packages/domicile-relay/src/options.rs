//! `domicile-relay`'s command line.

use std::net::SocketAddr;

/// Where the relay listens, and the zone its desks' addresses are under.
#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub zone: String,
    /// Where clients connect: port 443 of the zone's addresses.
    pub public: SocketAddr,
    /// Where desks dial in.
    pub desks: SocketAddr,
}

pub const USAGE: &str =
    "usage: domicile-relay --zone <zone> [--public <address>] [--desks <address>]\n\
\n\
Passes connections for <label>.<zone> to the desk holding that label's key,\n\
without decrypting them. Clients connect on --public (0.0.0.0:443), desks\n\
dial in on --desks (0.0.0.0:7444).";

/// The options in `args`, the program's name left out.
pub fn options(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut zone = None;
    let mut public: SocketAddr = "0.0.0.0:443".parse().expect("an address");
    let mut desks: SocketAddr = "0.0.0.0:7444".parse().expect("an address");
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} takes a value"))?;
        let address = || {
            value
                .parse()
                .map_err(|_| format!("{flag} takes an address such as 0.0.0.0:443, not {value}"))
        };
        match flag.as_str() {
            "--zone" => zone = Some(value.trim_matches('.').to_string()),
            "--public" => public = address()?,
            "--desks" => desks = address()?,
            _ => return Err(format!("no option {flag}")),
        }
    }
    Ok(Options {
        zone: zone.ok_or("--zone is required")?,
        public,
        desks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn the_zone_is_required_and_the_ports_have_defaults() {
        assert_eq!(
            options(args(&["--zone", "relay.example."])),
            Ok(Options {
                zone: "relay.example".into(),
                public: "0.0.0.0:443".parse().unwrap(),
                desks: "0.0.0.0:7444".parse().unwrap(),
            })
        );
        assert_eq!(options(args(&[])), Err("--zone is required".into()));
    }

    #[test]
    fn addresses_are_checked() {
        let given = options(args(&[
            "--zone",
            "z",
            "--public",
            "[::]:8443",
            "--desks",
            "127.0.0.1:9",
        ]))
        .unwrap();
        assert_eq!(given.public, "[::]:8443".parse().unwrap());
        assert!(options(args(&["--zone", "z", "--desks", "anywhere"])).is_err());
        assert!(options(args(&["--zone"])).is_err());
        assert!(options(args(&["--zone", "z", "--other", "x"])).is_err());
    }
}

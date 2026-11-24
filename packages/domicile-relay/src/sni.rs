//! Reads the server name a TLS client asks for from its ClientHello, without
//! decrypting anything: the name is sent in the clear, so the relay can pick
//! the desk and pass the connection on whole.

/// What the bytes read so far say.
#[derive(Debug, PartialEq, Eq)]
pub enum Hello {
    /// The ClientHello is longer than what was read.
    Incomplete,
    /// The server name it asks for, lowercased.
    Named(String),
    /// Not a TLS ClientHello, or one naming no server.
    Unnamed,
}

/// The largest ClientHello read before giving up.
pub const MOST_BYTES: usize = 16 * 1024;

/// What `read`, the start of a connection, says about the server it wants.
pub fn server_name(read: &[u8]) -> Hello {
    // A record: handshake (22), a version, and its length.
    let Some(header) = read.get(..5) else {
        return incomplete_unless(read.first().is_some_and(|kind| *kind != 22));
    };
    if header[0] != 22 {
        return Hello::Unnamed;
    }
    let length = usize::from(u16::from_be_bytes([header[3], header[4]]));
    let Some(record) = read.get(5..5 + length) else {
        return Hello::Incomplete;
    };
    parsed(record).unwrap_or(Hello::Unnamed)
}

fn incomplete_unless(not_tls: bool) -> Hello {
    if not_tls {
        Hello::Unnamed
    } else {
        Hello::Incomplete
    }
}

/// The name in a handshake record, or `None` if it is malformed. A
/// ClientHello split over several records names no server here.
fn parsed(record: &[u8]) -> Option<Hello> {
    let mut at = Reader(record);
    if at.byte()? != 1 {
        return None;
    }
    let mut hello = Reader({
        let count = at.u24()?;
        at.take(count)?
    });
    hello.take(2 + 32)?; // version, random
    let session = usize::from(hello.byte()?);
    hello.take(session)?;
    let suites = hello.u16()?;
    hello.take(suites)?;
    let compression = usize::from(hello.byte()?);
    hello.take(compression)?;
    if hello.0.is_empty() {
        return Some(Hello::Unnamed);
    }
    let mut extensions = Reader({
        let count = hello.u16()?;
        hello.take(count)?
    });
    while !extensions.0.is_empty() {
        let kind = extensions.u16()?;
        let mut body = Reader({
            let count = extensions.u16()?;
            extensions.take(count)?
        });
        if kind != 0 {
            continue;
        }
        let mut names = Reader({
            let count = body.u16()?;
            body.take(count)?
        });
        while !names.0.is_empty() {
            let name_kind = names.byte()?;
            let name = {
                let count = names.u16()?;
                names.take(count)?
            };
            if name_kind == 0 {
                let name = std::str::from_utf8(name).ok()?;
                return Some(Hello::Named(name.to_ascii_lowercase()));
            }
        }
    }
    Some(Hello::Unnamed)
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let taken = self.0.get(..count)?;
        self.0 = &self.0[count..];
        Some(taken)
    }

    fn byte(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u16(&mut self) -> Option<usize> {
        let bytes = self.take(2)?;
        Some(usize::from(u16::from_be_bytes([bytes[0], bytes[1]])))
    }

    fn u24(&mut self) -> Option<usize> {
        let bytes = self.take(3)?;
        Some(usize::from(bytes[0]) << 16 | usize::from(bytes[1]) << 8 | usize::from(bytes[2]))
    }
}

/// A ClientHello naming `name`, as a client would send it, for tests here
/// and in the relay's.
#[cfg(test)]
pub(crate) fn client_hello(name: &str) -> Vec<u8> {
    hello_with_extensions(&[
        // An extension before the name, to be skipped.
        (0x000a, vec![0, 2, 0, 0x1d]),
        (0, {
            let mut list = vec![0];
            list.extend((name.len() as u16).to_be_bytes());
            list.extend(name.as_bytes());
            let mut ext = (list.len() as u16).to_be_bytes().to_vec();
            ext.extend(list);
            ext
        }),
    ])
}

#[cfg(test)]
fn hello_with_extensions(extensions: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut body = vec![3, 3];
    body.extend([7; 32]);
    body.push(0); // no session
    body.extend([0, 2, 0x13, 0x01]); // one suite
    body.extend([1, 0]); // no compression
    let mut all = Vec::new();
    for (kind, data) in extensions {
        all.extend(kind.to_be_bytes());
        all.extend((data.len() as u16).to_be_bytes());
        all.extend(data);
    }
    body.extend((all.len() as u16).to_be_bytes());
    body.extend(all);
    let mut handshake = vec![1];
    handshake.extend(&(body.len() as u32).to_be_bytes()[1..]);
    handshake.extend(body);
    let mut record = vec![22, 3, 1];
    record.extend((handshake.len() as u16).to_be_bytes());
    record.extend(handshake);
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_hello_names_its_server() {
        let hello = client_hello("AbC.relay.example");
        assert_eq!(
            server_name(&hello),
            Hello::Named("abc.relay.example".into())
        );
    }

    #[test]
    fn part_of_a_hello_is_incomplete() {
        let hello = client_hello("abc.relay.example");
        for cut in [0, 3, 5, 40, hello.len() - 1] {
            assert_eq!(server_name(&hello[..cut]), Hello::Incomplete, "{cut}");
        }
    }

    #[test]
    fn plain_http_or_a_hello_without_a_name_is_unnamed() {
        assert_eq!(server_name(b"GET / HTTP/1.1\r\n"), Hello::Unnamed);
        assert_eq!(
            server_name(&hello_with_extensions(&[(0x000a, vec![0, 2, 0, 0x1d])])),
            Hello::Unnamed
        );
        let mut broken = client_hello("abc.relay.example");
        broken[6] = 0xff; // the handshake claims more than the record holds
        assert_eq!(server_name(&broken), Hello::Unnamed);
    }
}

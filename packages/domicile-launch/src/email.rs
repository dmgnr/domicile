//! The `mailto:` link for an `xdg-email` command line, which the desktop's
//! `xdg-email` hands to `domicile open`. Chromium runs `xdg-email`, not
//! `xdg-open`, for a page's `mailto:` link.

/// Why an `xdg-email` command line has no `mailto:` link.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum EmailError {
    #[error("cannot attach {0}: a mailto: link carries no files")]
    Attachment(String),
    #[error("takes a mailto: link or addresses, not both")]
    LinkAndAddresses,
    #[error("{0} needs a value")]
    MissingValue(String),
    #[error("does not know {0}")]
    UnknownOption(String),
}

/// The `mailto:` link `xdg-email` with `args` writes: its link or addresses,
/// with `--cc`, `--bcc`, `--subject` and `--body` as fields.
pub fn link_for(args: &[String]) -> Result<String, EmailError> {
    let mut words = args.iter();
    let mut fields = Vec::new();
    let mut targets = Vec::new();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--utf8" => {}
            "--cc" | "--bcc" | "--subject" | "--body" | "--attach" => {
                let value = words
                    .next()
                    .ok_or_else(|| EmailError::MissingValue(word.clone()))?;
                match word.as_str() {
                    "--attach" => return Err(EmailError::Attachment(value.clone())),
                    _ => fields.push(format!("{}={}", &word[2..], escaped(value))),
                }
            }
            option if option.starts_with('-') => {
                return Err(EmailError::UnknownOption(word.clone()));
            }
            _ => targets.push(word.as_str()),
        }
    }
    let base = match targets.as_slice() {
        [link] if is_mailto(link) => link.to_string(),
        addresses if addresses.iter().any(|word| is_mailto(word)) => {
            return Err(EmailError::LinkAndAddresses);
        }
        addresses => format!("mailto:{}", addresses.join(",")),
    };
    Ok(match (fields.is_empty(), base.contains('?')) {
        (true, _) => base,
        (false, true) => format!("{base}&{}", fields.join("&")),
        (false, false) => format!("{base}?{}", fields.join("&")),
    })
}

fn is_mailto(word: &str) -> bool {
    word.get(..7)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
}

/// Percent-encodes every byte of `value` except unreserved ones (RFC 3986).
fn escaped(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

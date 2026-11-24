//! Hides what logs say about someone's browsing before they share them: URLs
//! and window titles. `domicile export-logs` does this unless asked not to.
//! See `docs/LOGGING.md`.

/// What a hidden URL reads as.
pub const URL: &str = "<url>";

/// What a hidden window title reads as.
pub const TITLE: &str = "<window title>";

/// Titles shorter than this are left: hiding a short word would hide it
/// everywhere, and say little anyway.
const SHORTEST_TITLE: usize = 4;

/// `text` with every URL but the desktop's own and each of `titles` hidden.
pub fn redacted(text: &str, titles: &[String]) -> String {
    let mut titles: Vec<&str> = titles
        .iter()
        .map(String::as_str)
        .filter(|title| title.chars().count() >= SHORTEST_TITLE)
        .collect();
    // Longest first, so a title holding a shorter one is hidden whole.
    titles.sort_by_key(|title| std::cmp::Reverse(title.len()));
    let mut text = text.to_string();
    for title in titles {
        text = text.replace(title, TITLE);
    }
    without_urls(&text)
}

/// `text` with each URL hidden, except `domicile:` ones.
fn without_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let start = scheme_start(&rest[..at]);
        let scheme = &rest[start..at];
        let end = at
            + 3
            + rest[at + 3..]
                .find(|c: char| c.is_whitespace() || "\"'<>()[]{}`".contains(c))
                .unwrap_or(rest.len() - at - 3);
        out.push_str(&rest[..start]);
        match scheme.is_empty() || scheme == "domicile" {
            true => out.push_str(&rest[start..end]),
            false => out.push_str(URL),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// Where the scheme ending `before` starts: a letter, then letters, digits,
/// `+`, `-` and `.`. `before.len()` if there is none.
fn scheme_start(before: &str) -> usize {
    let start = before
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_alphanumeric() || "+-.".contains(*c))
        .last()
        .map_or(before.len(), |(at, _)| at);
    // Skip to the first letter: a scheme cannot start with a digit.
    match before[start..].find(|c: char| c.is_ascii_alphabetic()) {
        Some(letter) => start + letter,
        None => before.len(),
    }
}

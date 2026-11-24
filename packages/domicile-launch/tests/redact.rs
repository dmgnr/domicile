//! What `domicile export-logs` hides: the sites someone visited and what
//! their windows were called.

use domicile_launch::redact::redacted;

#[test]
fn a_url_is_hidden() {
    assert_eq!(
        redacted("loaded https://mail.example.com/u/0/#inbox in 3s", &[]),
        "loaded <url> in 3s"
    );
}

#[test]
fn a_url_ends_where_its_quotes_or_brackets_do() {
    assert_eq!(
        redacted(
            r#"opened "https://a.example/x" (from file:///home/me/a.pdf)"#,
            &[]
        ),
        r#"opened "<url>" (from <url>)"#
    );
}

#[test]
fn the_desktops_own_urls_stay() {
    // They name the shell's files, which help and say nothing of the user.
    assert_eq!(
        redacted("\"boom\", source: domicile://shell/main.js (30)", &[]),
        "\"boom\", source: domicile://shell/main.js (30)"
    );
}

#[test]
fn a_window_title_is_hidden() {
    assert_eq!(
        redacted(
            "focused Inbox (12) - me@example.com, then Inbox",
            &[
                "Inbox (12) - me@example.com".to_string(),
                "Inbox".to_string()
            ]
        ),
        "focused <window title>, then <window title>"
    );
}

#[test]
fn a_title_too_short_to_be_private_is_left() {
    // Hiding `a` would hide every `a`.
    assert_eq!(
        redacted("a window", &["a".to_string(), String::new()]),
        "a window"
    );
}

#[test]
fn words_like_a_scheme_without_a_url_stay() {
    assert_eq!(redacted("ratio: 2:1, at 9://", &[]), "ratio: 2:1, at 9://");
}

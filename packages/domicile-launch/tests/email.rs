//! Tests for the `mailto:` link the desktop's `xdg-email` opens.

use domicile_launch::email::{link_for, EmailError};

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(ToString::to_string).collect()
}

#[test]
fn a_mailto_link_is_opened_as_it_was_given() {
    // What the engine runs for a page's `mailto:` link.
    assert_eq!(
        link_for(&args(&["mailto:someone@example.com?subject=Hi"])),
        Ok("mailto:someone@example.com?subject=Hi".to_string())
    );
}

#[test]
fn addresses_and_fields_make_a_link() {
    assert_eq!(
        link_for(&args(&[
            "--utf8",
            "--cc",
            "c@example.com",
            "--bcc",
            "b@example.com",
            "--subject",
            "Lunch & more",
            "--body",
            "See you at 1?\nBye",
            "a@example.com",
            "z@example.com",
        ])),
        Ok(
            "mailto:a@example.com,z@example.com?cc=c%40example.com&bcc=b%40example.com\
            &subject=Lunch%20%26%20more&body=See%20you%20at%201%3F%0ABye"
                .to_string()
        )
    );
}

#[test]
fn fields_join_a_mailto_link() {
    assert_eq!(
        link_for(&args(&[
            "--subject",
            "Hi",
            "mailto:a@example.com?cc=c@example.com"
        ])),
        Ok("mailto:a@example.com?cc=c@example.com&subject=Hi".to_string())
    );
    assert_eq!(
        link_for(&args(&["--subject", "Hi", "mailto:a@example.com"])),
        Ok("mailto:a@example.com?subject=Hi".to_string())
    );
}

#[test]
fn an_attachment_is_refused() {
    // A `mailto:` link cannot carry a file, and dropping it would send the
    // mail without it.
    assert_eq!(
        link_for(&args(&["--attach", "/tmp/a.pdf", "a@example.com"])),
        Err(EmailError::Attachment("/tmp/a.pdf".to_string()))
    );
}

#[test]
fn a_mailto_link_with_addresses_is_refused() {
    assert_eq!(
        link_for(&args(&["mailto:a@example.com", "b@example.com"])),
        Err(EmailError::LinkAndAddresses)
    );
}

#[test]
fn an_option_without_its_value_is_refused() {
    assert_eq!(
        link_for(&args(&["a@example.com", "--subject"])),
        Err(EmailError::MissingValue("--subject".to_string()))
    );
}

#[test]
fn an_unknown_option_is_refused() {
    assert_eq!(
        link_for(&args(&["--manual"])),
        Err(EmailError::UnknownOption("--manual".to_string()))
    );
    assert_eq!(
        link_for(&args(&["-x", "a@example.com"])),
        Err(EmailError::UnknownOption("-x".to_string()))
    );
}

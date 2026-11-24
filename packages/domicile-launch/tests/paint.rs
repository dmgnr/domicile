//! Tests for how `domicile` styles what it prints for a person.

use domicile_launch::paint::{wrap, Paint, Style};

fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
    move |name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.to_string())
    }
}

#[test]
fn a_terminal_gets_color_unless_no_color_or_a_dumb_terminal_says_otherwise() {
    assert_eq!(Paint::for_stream(true, &env(&[])), Paint::COLOR);
    assert_eq!(Paint::for_stream(false, &env(&[])), Paint::PLAIN);
    assert_eq!(
        Paint::for_stream(true, &env(&[("NO_COLOR", "1")])),
        Paint::PLAIN
    );
    assert_eq!(
        Paint::for_stream(true, &env(&[("TERM", "dumb")])),
        Paint::PLAIN
    );
    // https://no-color.org: an empty NO_COLOR is unset.
    assert_eq!(
        Paint::for_stream(true, &env(&[("NO_COLOR", "")])),
        Paint::COLOR
    );
}

#[test]
fn plain_paint_leaves_text_as_it_is() {
    for style in [Style::Heading, Style::Command, Style::Dim, Style::Bad] {
        assert_eq!(Paint::PLAIN.style(style, "words"), "words");
    }
    assert_eq!(Paint::PLAIN.style(Style::Plain, "words"), "words");
}

#[test]
fn color_wraps_text_in_its_style_and_resets_after() {
    assert_eq!(
        Paint::COLOR.style(Style::Heading, "Usage"),
        "\x1b[1;32mUsage\x1b[0m"
    );
    assert_eq!(Paint::COLOR.style(Style::Plain, "words"), "words");
    assert_eq!(Paint::COLOR.style(Style::Dim, ""), "");
}

#[test]
fn backticks_mark_code_which_is_bold_in_color_and_bare_in_plain() {
    assert_eq!(
        Paint::PLAIN.inline("Refused when `output.displays` is set."),
        "Refused when output.displays is set."
    );
    assert_eq!(Paint::COLOR.inline("a `b` c"), "a \x1b[1mb\x1b[0m c");
}

#[test]
fn a_usage_paints_its_command_words_apart_from_what_it_takes() {
    assert_eq!(
        Paint::COLOR.usage("configure-display <display> <change>..."),
        "\x1b[1;36mconfigure-display\x1b[0m \x1b[36m<display> <change>...\x1b[0m"
    );
    assert_eq!(Paint::COLOR.usage("lock"), "\x1b[1;36mlock\x1b[0m");
    assert_eq!(Paint::COLOR.usage("<display>"), "\x1b[36m<display>\x1b[0m");
    assert_eq!(
        Paint::PLAIN.usage("theme [light|dark]"),
        "theme [light|dark]"
    );
}

#[test]
fn wrapping_breaks_between_words_and_does_not_count_backticks() {
    assert_eq!(
        wrap("one two three four", 9),
        vec!["one two", "three", "four"]
    );
    assert_eq!(wrap("`abcd` efgh", 9), vec!["`abcd` efgh"]);
    assert_eq!(wrap("", 9), Vec::<String>::new());
    assert_eq!(wrap("run `a b c` now", 7), vec!["run", "`a b c`", "now"]);
}

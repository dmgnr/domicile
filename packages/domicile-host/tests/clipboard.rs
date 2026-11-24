//! Clipboard history policy: what is a row, what counts as a repeat, and
//! what is too big to keep.

use domicile_host::clipboard::{
    image_mime, text_mime, Contents, History, Image, Removed, HELD_BYTES, LONGEST_COPY,
    LONGEST_IMAGE, PREVIEW_CHARACTERS, REMEMBERED,
};
use domicile_protocol::ClipboardEntry;

/// The previews a history is showing, newest first.
fn previews(history: &History) -> Vec<String> {
    history
        .entries()
        .into_iter()
        .map(|entry: ClipboardEntry| entry.preview)
        .collect()
}

/// A copy becomes the first row.
#[test]
fn what_was_copied_last_is_the_first_row() {
    let mut history = History::default();

    history.record(Contents::text("first"));
    history.record(Contents::text("second"));

    assert_eq!(previews(&history), vec!["second", "first"]);
}

/// Copying something already in the history moves it to the front instead
/// of adding a duplicate.
#[test]
fn copying_something_again_moves_it_up_rather_than_adding_a_row() {
    let mut history = History::default();

    history.record(Contents::text("address"));
    history.record(Contents::text("something else"));
    history.record(Contents::text("address"));

    assert_eq!(previews(&history), vec!["address", "something else"]);
}

/// A repeated copy keeps its id, so an open panel's rows still name live
/// entries.
#[test]
fn a_row_that_moves_up_keeps_the_id_the_shell_was_told() {
    let mut history = History::default();

    history.record(Contents::text("address"));
    let first = history.entries()[0].id;
    history.record(Contents::text("something else"));
    history.record(Contents::text("address"));

    assert_eq!(history.entries()[0].id, first);
}

/// Copying the same thing twice in a row reports no change.
///
/// Clients often re-offer their current selection, for example while
/// dragging in an editor. Reporting each as a change would broadcast per
/// keystroke.
#[test]
fn re_copying_what_is_already_at_the_top_is_not_news() {
    let mut history = History::default();

    assert!(history.record(Contents::text("address")));
    assert!(!history.record(Contents::text("address")));
}

/// An empty selection is not recorded. Clients offer one while clearing.
#[test]
fn an_empty_copy_is_not_a_row() {
    let mut history = History::default();

    assert!(!history.record(Contents::text(String::new())));
    assert!(history.entries().is_empty());
}

/// The history is bounded by count, and the oldest row is dropped.
#[test]
fn the_oldest_row_falls_off_a_full_history() {
    let mut history = History::default();

    for copy in 0..=REMEMBERED {
        history.record(Contents::text(format!("copy {copy}")));
    }

    let showing = previews(&history);
    assert_eq!(showing.len(), REMEMBERED);
    assert_eq!(showing[0], format!("copy {REMEMBERED}"));
    assert_eq!(showing[REMEMBERED - 1], "copy 1");
}

/// A copy too big to keep is not recorded and does not evict anything.
///
/// The selection still works; only reaching back for it later is lost.
#[test]
fn a_copy_too_big_to_keep_is_refused_and_disturbs_nothing() {
    let mut history = History::default();
    history.record(Contents::text("small"));

    assert!(!history.record(Contents::text("x".repeat(LONGEST_COPY + 1))));
    assert_eq!(previews(&history), vec!["small"]);
}

/// A long preview is truncated; the copied text is not.
#[test]
fn a_long_copy_is_shown_cut_and_handed_back_whole() {
    let mut history = History::default();
    let whole = "y".repeat(PREVIEW_CHARACTERS * 2);

    history.record(Contents::text(whole.clone()));

    let entry = &history.entries()[0];
    assert_eq!(entry.preview.chars().count(), PREVIEW_CHARACTERS);
    assert_eq!(
        history.contents(entry.id),
        Some(&Contents::text(whole.as_str()))
    );
}

/// The preview is truncated by characters, not bytes, so non-ASCII text
/// is not split mid-character.
#[test]
fn a_preview_is_cut_between_characters() {
    let mut history = History::default();

    history.record(Contents::text("é".repeat(PREVIEW_CHARACTERS + 10)));

    let preview = &history.entries()[0].preview;
    assert_eq!(preview.chars().count(), PREVIEW_CHARACTERS);
    assert!(preview.chars().all(|character| character == 'é'));
}

/// An unknown id returns nothing. The caller logs it.
#[test]
fn an_id_from_no_row_names_no_text() {
    let mut history = History::default();
    history.record(Contents::text("something"));

    assert_eq!(history.contents(u32::MAX), None);
}

/// A dropped row's text is freed too.
#[test]
fn a_row_that_fell_off_the_end_is_not_still_holding_its_text() {
    let mut history = History::default();
    history.record(Contents::text("the first"));
    let fallen = history.entries()[0].id;

    for copy in 0..REMEMBERED {
        history.record(Contents::text(format!("copy {copy}")));
    }

    assert_eq!(history.contents(fallen), None);
}

/// A text selection is requested as UTF-8 first.
#[test]
fn a_text_selection_is_asked_for_utf8() {
    let offered = vec![
        "text/plain".to_string(),
        "text/plain;charset=utf-8".to_string(),
        "TIMESTAMP".to_string(),
    ];

    assert_eq!(
        text_mime(&offered).as_deref(),
        Some("text/plain;charset=utf-8")
    );
}

/// The MIME type matches case-insensitively, as for
/// `text/plain;charset=UTF-8` from X11 bridges and some toolkits.
#[test]
fn the_charset_is_matched_however_it_is_capitalized() {
    let offered = vec!["text/plain;charset=UTF-8".to_string()];

    assert_eq!(
        text_mime(&offered).as_deref(),
        Some("text/plain;charset=UTF-8")
    );
}

/// A selection with no text type is not read as text.
#[test]
fn a_selection_that_is_not_text_has_no_text_to_read() {
    let offered = vec!["image/png".to_string(), "text/uri-list".to_string()];

    assert_eq!(text_mime(&offered), None);
}

/// An image is read as PNG when the client offers it, since every reader
/// takes PNG.
#[test]
fn an_image_is_asked_for_as_png_first() {
    let offered = vec![
        "image/jpeg".to_string(),
        "image/png".to_string(),
        "text/html".to_string(),
    ];

    assert_eq!(image_mime(&offered).as_deref(), Some("image/png"));
}

/// An image offered only in another format is read in that format.
#[test]
fn an_image_with_no_png_is_read_as_what_it_is() {
    let offered = vec!["text/html".to_string(), "image/webp".to_string()];

    assert_eq!(image_mime(&offered).as_deref(), Some("image/webp"));
}

/// A selection with no image type has no image to read.
#[test]
fn a_selection_with_no_image_has_no_image_to_read() {
    let offered = vec!["text/plain".to_string(), "text/uri-list".to_string()];

    assert_eq!(image_mime(&offered), None);
}

/// A copied image is a row named for its size, with a thumbnail of it, and
/// comes back whole.
#[test]
fn an_image_is_a_row_named_for_its_size() {
    let mut history = History::default();
    let image = png(3, 2);

    history.record(image.clone());

    let entry = &history.entries()[0];
    assert_eq!(entry.preview, "Image, 3 × 2");
    assert!(entry.image);
    assert!(entry
        .thumbnail
        .as_deref()
        .is_some_and(|url| url.starts_with("data:image/png;base64,")));
    assert_eq!(history.contents(entry.id), Some(&image));
}

/// An image in a format whose size is not read is named by its format.
#[test]
fn an_image_that_is_not_png_is_named_by_its_format() {
    let mut history = History::default();

    history.record(Contents::image("image/webp", vec![1, 2, 3]));

    assert_eq!(previews(&history), vec!["Image (image/webp)"]);
    assert_eq!(history.entries()[0].thumbnail, None);
}

/// A copy with both text and an image is shown by its text, as text, with
/// no thumbnail.
#[test]
fn a_copy_with_text_and_an_image_is_shown_by_its_text() {
    let mut history = History::default();

    history.record(Contents {
        text: Some("a caption".into()),
        image: png(1, 1).image,
    });

    assert_eq!(previews(&history), vec!["a caption"]);
    assert!(!history.entries()[0].image);
    assert_eq!(history.entries()[0].thumbnail, None);
}

/// The same image copied twice is one row.
#[test]
fn copying_the_same_image_again_is_not_news() {
    let mut history = History::default();

    assert!(history.record(png(2, 2)));
    assert!(!history.record(png(2, 2)));
}

/// An image too big to keep is refused like long text.
#[test]
fn an_image_too_big_to_keep_is_refused() {
    let mut history = History::default();

    assert!(!history.record(Contents::image("image/png", vec![0; LONGEST_IMAGE + 1])));
    assert!(history.entries().is_empty());
}

/// Rows fall off the end once the history holds too many bytes, so a run of
/// large images cannot fill memory. The newest row always stays.
#[test]
fn large_images_push_old_rows_out_before_the_count_does() {
    let mut history = History::default();
    let copies = HELD_BYTES / LONGEST_IMAGE + 1;

    for copy in 0..copies {
        history.record(Contents::image(
            "image/png",
            vec![copy as u8; LONGEST_IMAGE],
        ));
    }

    assert_eq!(history.entries().len(), HELD_BYTES / LONGEST_IMAGE);
}

/// Each type a copy can be pasted as: every text type for text, and the
/// image's own type.
#[test]
fn contents_are_offered_as_every_text_type_and_the_image_type() {
    let contents = Contents {
        text: Some("words".into()),
        image: Some(Image::new("image/png", vec![9])),
    };

    assert_eq!(
        contents.mimes(),
        vec![
            "text/plain;charset=utf-8",
            "text/plain",
            "UTF8_STRING",
            "STRING",
            "image/png"
        ]
    );
    assert_eq!(contents.bytes("STRING"), Some(&b"words"[..]));
    assert_eq!(contents.bytes("image/png"), Some(&[9u8][..]));
    assert_eq!(contents.bytes("image/jpeg"), None);
}

/// Contents read from what was offered by type keep the text and the image
/// and drop the rest.
#[test]
fn contents_from_offered_types_keep_the_text_and_the_image() {
    let contents = Contents::from_offers([
        ("text/html".to_string(), b"<img>".to_vec()),
        ("text/plain;charset=utf-8".to_string(), b"words".to_vec()),
        ("text/plain".to_string(), b"words".to_vec()),
        ("image/png".to_string(), vec![7]),
    ]);

    assert_eq!(
        contents,
        Contents {
            text: Some("words".into()),
            image: Some(Image::new("image/png", vec![7])),
        }
    );
}

/// Offered text that is not UTF-8 is dropped rather than repaired.
#[test]
fn offered_text_that_is_not_utf8_is_not_kept() {
    let contents = Contents::from_offers([("text/plain".to_string(), vec![0xff, 0xfe])]);

    assert_eq!(contents, Contents::default());
}

/// A PNG of `width` x `height` transparent pixels, as copied contents.
fn png(width: u32, height: u32) -> Contents {
    let shot = domicile_host::screenshot::Shot {
        width,
        height,
        bgra: vec![0; (width * height * 4) as usize],
    };
    Contents::image("image/png", domicile_host::screenshot::encode(&shot))
}

/// The id of the newest row, for the compositor to offer.
///
/// A browser copy is offered by the compositor, which needs the row's id
/// right away; `record` only reports whether the list changed.
#[test]
fn the_newest_row_is_the_one_a_copy_just_made() {
    let mut history = History::default();

    history.record(Contents::text("first"));
    history.record(Contents::text("second"));

    let newest = history.newest().expect("a history with rows has a newest");
    assert_eq!(history.contents(newest), Some(&Contents::text("second")));
}

/// Re-copying the current entry still returns its id, so the browser sets
/// the selection both times.
#[test]
fn copying_the_same_thing_twice_still_names_its_row() {
    let mut history = History::default();
    history.record(Contents::text("once"));

    assert!(!history.record(Contents::text("once")));

    let newest = history.newest().expect("a history with rows has a newest");
    assert_eq!(history.contents(newest), Some(&Contents::text("once")));
}

/// An empty history has no newest row.
#[test]
fn a_history_with_no_rows_has_no_newest() {
    assert_eq!(History::default().newest(), None);
}

/// Restoring a row puts it on the clipboard, so it becomes the first row,
/// keeping its id.
#[test]
fn a_restored_row_moves_to_the_top() {
    let mut history = History::default();
    history.record(Contents::text("address"));
    let first = history.entries()[0].id;
    history.record(Contents::text("something else"));

    let restored = history.restore(first);

    assert_eq!(restored, Some(Contents::text("address")));
    assert_eq!(previews(&history), vec!["address", "something else"]);
    assert_eq!(history.entries()[0].id, first);
}

/// Which rows the shell is told hold what is on the clipboard.
fn current(history: &History) -> Vec<bool> {
    history
        .entries()
        .into_iter()
        .map(|entry: ClipboardEntry| entry.current)
        .collect()
}

/// Removing an earlier row drops it and its contents, and leaves the current
/// copy on the clipboard.
#[test]
fn a_removed_row_is_gone_with_its_contents() {
    let mut history = History::default();
    history.record(Contents::text("password"));
    let password = history.entries()[0].id;
    history.record(Contents::text("address"));

    assert_eq!(history.remove(password), Some(Removed::Earlier));

    assert_eq!(previews(&history), vec!["address"]);
    assert_eq!(history.contents(password), None);
    assert_eq!(current(&history), vec![true]);
}

/// Removing the current copy reports it, so the compositor clears the
/// clipboard, and leaves no row current.
#[test]
fn removing_the_current_copy_leaves_nothing_on_the_clipboard() {
    let mut history = History::default();
    history.record(Contents::text("address"));
    history.record(Contents::text("password"));
    let password = history.entries()[0].id;

    assert_eq!(history.remove(password), Some(Removed::Current));

    assert_eq!(previews(&history), vec!["address"]);
    assert_eq!(current(&history), vec![false]);
}

/// A row already gone removes nothing.
#[test]
fn removing_a_row_that_is_gone_changes_nothing() {
    let mut history = History::default();
    history.record(Contents::text("address"));

    assert_eq!(history.remove(99), None);

    assert_eq!(previews(&history), vec!["address"]);
}

/// Only the newest row is current, and only until the clipboard is cleared.
/// Copying the newest row's contents again, or restoring it, puts it back.
#[test]
fn copying_the_newest_row_again_after_a_clear_makes_it_current() {
    let mut history = History::default();
    history.record(Contents::text("address"));
    history.record(Contents::text("password"));
    let password = history.entries()[0].id;
    history.remove(password);

    assert!(history.record(Contents::text("address")));
    assert_eq!(current(&history), vec![true]);

    let address = history.entries()[0].id;
    history.record(Contents::text("password"));
    history.remove(history.entries()[0].id);
    history.restore(address);
    assert_eq!(current(&history), vec![true]);
}

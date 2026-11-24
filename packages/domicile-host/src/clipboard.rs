//! Clipboard policy: what is read from a selection, kept, deduplicated and
//! previewed.
//!
//! A Wayland selection lives in the offering client, so it vanishes when that
//! client exits. The compositor keeps copies to survive that. Reading and
//! restoring selections is in `domicile-compositor`'s `clipboard` module. See
//! `packages/manganese-clipboard/docs/CLIPBOARD.md`.

use domicile_protocol::ClipboardEntry;

use crate::thumbnail::thumbnail;

/// Number of copies kept. Bounded by count, and by [`HELD_BYTES`].
pub const REMEMBERED: usize = 32;

/// Longest text kept, in bytes, to bound memory.
///
/// A larger copy still pastes from its client but is not added to history.
pub const LONGEST_COPY: usize = 1024 * 1024;

/// Largest image kept, in bytes. A screenshot of several monitors fits.
pub const LONGEST_IMAGE: usize = 32 * 1024 * 1024;

/// Most bytes the history holds. The oldest rows go first; the newest stays.
pub const HELD_BYTES: usize = 128 * 1024 * 1024;

/// Characters of each copy sent to the shell as a preview. Restoring a copy
/// always uses the full text. Enough to fill a few lines of a wide row.
pub const PREVIEW_CHARACTERS: usize = 480;

/// Text MIME types, preferred first.
///
/// Used both to read a selection and to offer a restored one, so anything
/// kept can be pasted back. `UTF8_STRING` and `STRING` are X11 names that
/// arrive through Xwayland.
pub const TEXT_MIMES: [&str; 4] = [
    "text/plain;charset=utf-8",
    "text/plain",
    "UTF8_STRING",
    "STRING",
];

/// The image type every reader takes, preferred over any other.
const PNG: &str = "image/png";

/// The MIME type to read a selection's text as, or `None` if it has no text.
///
/// Case-insensitive: X11 bridges write `text/plain;charset=UTF-8`, and the
/// charset value is case-insensitive.
pub fn text_mime(offered: &[String]) -> Option<String> {
    TEXT_MIMES.iter().find_map(|wanted| {
        offered
            .iter()
            .find(|mime| mime.eq_ignore_ascii_case(wanted))
            .cloned()
    })
}

/// The MIME type to read a selection's image as: PNG if offered, else the
/// first `image/` type, else `None`.
pub fn image_mime(offered: &[String]) -> Option<String> {
    offered
        .iter()
        .find(|mime| mime.eq_ignore_ascii_case(PNG))
        .or_else(|| {
            offered
                .iter()
                .find(|mime| mime.to_ascii_lowercase().starts_with("image/"))
        })
        .cloned()
}

/// What one clipboard holds: text, an image, or both.
///
/// A client copying an image often offers text with it, such as a file name
/// or a spreadsheet's cells, so both are kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Contents {
    pub text: Option<String>,
    pub image: Option<Image>,
}

/// A copied image, in the format it was offered in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub mime: String,
    pub bytes: Vec<u8>,
    /// A small PNG of it as a `data:` URL, for its row. `None` for a format
    /// that is not read, or bytes that do not decode.
    ///
    /// Made once, with the image, so a row is not decoded on every broadcast.
    /// Copies are read off the Wayland thread, so that is where it is made.
    thumbnail: Option<String>,
}

impl Image {
    /// An image of type `mime`.
    pub fn new(mime: impl Into<String>, bytes: Vec<u8>) -> Image {
        let mime = mime.into();
        let thumbnail = if mime.eq_ignore_ascii_case(PNG) {
            thumbnail(&bytes)
        } else {
            None
        };
        Image {
            mime,
            bytes,
            thumbnail,
        }
    }
}

impl Contents {
    /// Contents that are only `text`.
    pub fn text(text: impl Into<String>) -> Contents {
        Contents {
            text: Some(text.into()),
            image: None,
        }
    }

    /// Contents that are only an image of type `mime`.
    pub fn image(mime: impl Into<String>, bytes: Vec<u8>) -> Contents {
        Contents {
            text: None,
            image: Some(Image::new(mime, bytes)),
        }
    }

    /// The text and image among `offers`, each a MIME type and its bytes.
    ///
    /// Picks types as [`text_mime`] and [`image_mime`] do and drops the rest.
    /// Text that is not UTF-8 is dropped, not repaired: a repaired copy would
    /// differ from what was copied.
    pub fn from_offers(offers: impl IntoIterator<Item = (String, Vec<u8>)>) -> Contents {
        let offers: Vec<(String, Vec<u8>)> = offers.into_iter().collect();
        let mimes: Vec<String> = offers.iter().map(|(mime, _)| mime.clone()).collect();
        let take = |wanted: Option<String>| {
            wanted.and_then(|wanted| offers.iter().find(|(mime, _)| *mime == wanted).cloned())
        };
        Contents {
            text: take(text_mime(&mimes)).and_then(|(_, bytes)| String::from_utf8(bytes).ok()),
            image: take(image_mime(&mimes)).map(|(mime, bytes)| Image::new(mime, bytes)),
        }
    }

    /// The MIME types these can be pasted as: every text type, then the
    /// image's.
    pub fn mimes(&self) -> Vec<String> {
        let text = self
            .text
            .iter()
            .flat_map(|_| TEXT_MIMES.map(str::to_string));
        let image = self.image.iter().map(|image| image.mime.clone());
        text.chain(image).collect()
    }

    /// The bytes to paste for `mime`, or `None` if these hold nothing of
    /// that type.
    pub fn bytes(&self, mime: &str) -> Option<&[u8]> {
        let text = || {
            TEXT_MIMES
                .iter()
                .any(|text| text.eq_ignore_ascii_case(mime))
                .then_some(self.text.as_deref())
                .flatten()
                .map(str::as_bytes)
        };
        let image = || {
            self.image
                .as_ref()
                .filter(|image| image.mime.eq_ignore_ascii_case(mime))
                .map(|image| image.bytes.as_slice())
        };
        text().or_else(image)
    }

    /// Whether these hold nothing to paste.
    pub fn is_empty(&self) -> bool {
        self.text.as_deref().is_none_or(str::is_empty) && self.image.is_none()
    }

    /// Bytes held, for bounding the history.
    fn size(&self) -> usize {
        self.text.as_ref().map_or(0, String::len)
            + self.image.as_ref().map_or(0, |image| image.bytes.len())
    }

    /// Whether either part is too big to keep.
    fn too_big(&self) -> bool {
        self.text
            .as_ref()
            .is_some_and(|text| text.len() > LONGEST_COPY)
            || self
                .image
                .as_ref()
                .is_some_and(|image| image.bytes.len() > LONGEST_IMAGE)
    }

    /// The thumbnail of a copy that is only an image, which its row shows.
    fn thumbnail(&self) -> Option<String> {
        match (&self.text, &self.image) {
            (None, Some(image)) => image.thumbnail.clone(),
            _ => None,
        }
    }

    /// The row a shell shows: the start of the text, else the image's size.
    fn preview(&self) -> String {
        match (&self.text, &self.image) {
            (Some(text), _) => text.chars().take(PREVIEW_CHARACTERS).collect(),
            (None, Some(image)) => match png_size(image) {
                Some((width, height)) => format!("Image, {width} × {height}"),
                None => format!("Image ({})", image.mime),
            },
            (None, None) => String::new(),
        }
    }
}

/// The width and height a PNG's header gives, or `None` for another format
/// or a header that does not read.
fn png_size(image: &Image) -> Option<(u32, u32)> {
    if image.mime.eq_ignore_ascii_case(PNG) {
        let reader = png::Decoder::new(std::io::Cursor::new(&image.bytes))
            .read_info()
            .ok()?;
        let info = reader.info();
        Some((info.width, info.height))
    } else {
        None
    }
}

/// Copies, newest first.
///
/// Kept in memory only, never on disk, because it may hold passwords.
#[derive(Debug, Default)]
pub struct History {
    /// Newest first.
    entries: Vec<Copy>,
    /// Total entries ever taken, which is also the last id issued. Never
    /// reset, so a stale id never names a different row.
    taken: u32,
    /// Whether the clipboard was emptied by removing the newest entry, so no
    /// entry is what it holds.
    cleared: bool,
}

/// Which entry [`History::remove`] dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removed {
    /// An earlier copy; the clipboard is unchanged.
    Earlier,
    /// What the clipboard held, which the caller must now empty.
    Current,
}

/// One copy and its id.
#[derive(Debug)]
struct Copy {
    id: u32,
    contents: Contents,
}

impl History {
    /// Records a copy and returns whether the list changed and needs to be
    /// broadcast.
    ///
    /// Clients often re-offer the current selection, such as an editor during
    /// a drag, so a repeat of the newest entry returns `false`.
    pub fn record(&mut self, contents: Contents) -> bool {
        if contents.is_empty() || contents.too_big() {
            false
        } else {
            self.remember(contents)
        }
    }

    /// Every entry, as sent to a chrome.
    pub fn entries(&self) -> Vec<ClipboardEntry> {
        self.entries
            .iter()
            .enumerate()
            .map(|(at, copy)| ClipboardEntry {
                id: copy.id,
                image: copy.contents.text.is_none(),
                preview: copy.contents.preview(),
                thumbnail: copy.contents.thumbnail(),
                current: at == 0 && !self.cleared,
            })
            .collect()
    }

    /// The newest entry's id, or `None` if nothing has been copied.
    ///
    /// After [`History::record`], this is the entry for that copy, even when
    /// `record` returned `false`.
    pub fn newest(&self) -> Option<u32> {
        self.entries.first().map(|copy| copy.id)
    }

    /// Everything entry `id` holds, for restoring it to the clipboard.
    ///
    /// `None` if the entry has dropped off the end of the history.
    pub fn contents(&self, id: u32) -> Option<&Contents> {
        self.entries
            .iter()
            .find(|copy| copy.id == id)
            .map(|copy| &copy.contents)
    }

    /// Moves entry `id` to the front, since restoring it puts it back on the
    /// clipboard, and returns what it holds.
    ///
    /// `None` if the entry has dropped off the end of the history.
    pub fn restore(&mut self, id: u32) -> Option<Contents> {
        let held = self.entries.iter().position(|copy| copy.id == id)?;
        let copy = self.entries.remove(held);
        let contents = copy.contents.clone();
        self.entries.insert(0, copy);
        self.cleared = false;
        Some(contents)
    }

    /// Drops entry `id` and its contents, and says whether it was what the
    /// clipboard held.
    ///
    /// `None` if the entry has dropped off the end of the history.
    pub fn remove(&mut self, id: u32) -> Option<Removed> {
        let held = self.entries.iter().position(|copy| copy.id == id)?;
        self.entries.remove(held);
        if held == 0 && !self.cleared {
            self.cleared = true;
            Some(Removed::Current)
        } else {
            Some(Removed::Earlier)
        }
    }

    /// Puts a copy at the front, moving an existing equal entry instead of
    /// duplicating it.
    ///
    /// A moved entry keeps its id, so an open panel's rows stay valid.
    fn remember(&mut self, contents: Contents) -> bool {
        let cleared = std::mem::take(&mut self.cleared);
        match self
            .entries
            .iter()
            .position(|copy| copy.contents == contents)
        {
            // Already newest, so nothing changed unless the clipboard had
            // been emptied.
            Some(0) => cleared,
            Some(held) => {
                let copy = self.entries.remove(held);
                self.entries.insert(0, copy);
                true
            }
            None => {
                self.taken += 1;
                self.entries.insert(
                    0,
                    Copy {
                        id: self.taken,
                        contents,
                    },
                );
                self.forget_the_oldest();
                true
            }
        }
    }

    /// Drops the oldest entries past [`REMEMBERED`] or [`HELD_BYTES`], and
    /// their contents with them.
    fn forget_the_oldest(&mut self) {
        let mut held = 0;
        let kept = self
            .entries
            .iter()
            .take(REMEMBERED)
            .take_while(|copy| {
                held += copy.contents.size();
                held <= HELD_BYTES
            })
            .count();
        // The newest is always kept: it is within both limits on its own.
        self.entries.truncate(kept.max(1));
    }
}

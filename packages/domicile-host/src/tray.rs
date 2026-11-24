//! StatusNotifierItem state for the system tray.
//!
//! The D-Bus side lives in `domicile-compositor`'s `tray` module. It passes
//! each item's [`Properties`] here and sends shells the resulting
//! [`TrayItem`]s. Icons become `data:` URLs. See
//! `docs/architecture/SYSTEM-TRAY.md`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use domicile_protocol::{Bus, SystemRequest, TrayAction, TrayItem};

use crate::data_url::data_url;
use crate::icon_theme;
use crate::png::png;

/// The object path of an item registered by bus name alone.
const ITEM_PATH: &str = "/StatusNotifierItem";

/// The `Menu` KDE's items give when they have none.
const NO_MENU: &str = "/NO_DBUSMENU";

/// The size, in CSS pixels, and the scale tray icons are looked up at. Panels
/// draw them at about 16 pixels; a scale of 2 keeps them sharp on HiDPI
/// screens, and the page only scales down.
const LOOKED_UP_AT: (i64, i64) = (16, 2);

/// The preferred pixmap width: a tray icon's size in pixels. The smallest
/// pixmap at least this wide wins.
const WANTED_PIXELS: i32 = (LOOKED_UP_AT.0 * LOOKED_UP_AT.1) as i32;

/// Icon theme contexts to search. Most tray icons are in `status`.
const CONTEXTS: &[&str] = &["status", "apps", "devices", "panel"];

/// An item's `Status` property.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Hidden from the tray.
    Passive,
    Active,
    /// Shown with its attention icon.
    NeedsAttention,
}

impl Status {
    /// Parse a `Status` value. Unknown values are `Active`, so an icon is
    /// never hidden by mistake.
    pub fn from_wire(word: &str) -> Status {
        match word {
            "Passive" => Status::Passive,
            "NeedsAttention" => Status::NeedsAttention,
            _ => Status::Active,
        }
    }
}

/// One `IconPixmap` image: big-endian ARGB, rows top to bottom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixmap {
    pub width: i32,
    pub height: i32,
    pub argb: Vec<u8>,
}

/// An item's `org.kde.StatusNotifierItem` properties. Missing ones are empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Properties {
    pub id: String,
    pub title: String,
    /// The title of its `ToolTip`.
    pub tooltip: String,
    pub status: Status,
    pub icon_name: String,
    pub icon_pixmaps: Vec<Pixmap>,
    pub attention_icon_name: String,
    pub attention_pixmaps: Vec<Pixmap>,
    /// The item's own icon directory.
    pub icon_theme_path: String,
    /// The object path of its `com.canonical.dbusmenu` menu.
    pub menu: String,
    /// Its `ItemIsMenu`: it only has a menu.
    pub item_is_menu: bool,
}

/// The bus name and object path for a `RegisterStatusNotifierItem(service)`
/// call from `sender`.
///
/// `service` may be a bus name (the spec, and KDE), an object path on the
/// sender's connection (libappindicator), or a bus name followed by a path.
pub fn address(service: &str, sender: &str) -> (String, String) {
    match service.find('/') {
        Some(0) => (sender.to_string(), service.to_string()),
        Some(at) => (service[..at].to_string(), service[at..].to_string()),
        None => (service.to_string(), ITEM_PATH.to_string()),
    }
}

/// The `org.kde.StatusNotifierItem` method a click with `action` calls.
pub fn method(action: TrayAction) -> &'static str {
    match action {
        TrayAction::Primary => "Activate",
        TrayAction::Secondary => "SecondaryActivate",
        TrayAction::Context => "ContextMenu",
    }
}

/// The bus a shell's system call clicks a tray menu entry on, if it is one:
/// a `com.canonical.dbusmenu` `Event` of `clicked` on the session bus.
///
/// Entries such as "Show Slack" raise a window, so the click needs a token
/// as an icon click does.
pub fn menu_clicked(request: &SystemRequest) -> Option<&str> {
    match request {
        SystemRequest::DbusCall {
            bus: Bus::Session,
            destination,
            interface,
            member,
            body,
            ..
        } if interface == "com.canonical.dbusmenu" && member == "Event" => {
            // A body that does not parse is answered as an error by the call
            // itself.
            let arguments = serde_json::from_str::<Vec<serde_json::Value>>(body).ok();
            arguments
                .is_some_and(|arguments| {
                    arguments.get(1).and_then(|event| event.as_str()) == Some("clicked")
                })
                .then_some(destination.as_str())
        }
        _ => None,
    }
}

/// The items registered with the watcher, in registration order.
///
/// Each item has four names:
/// - its id here: bus name and path, concatenated;
/// - its name for shells (see [`Registry::named`]);
/// - the bus name it is called on, possibly well-known;
/// - the unique name of its connection, which its signals and disconnect
///   come from.
#[derive(Debug, Default)]
pub struct Registry {
    entries: Vec<Entry>,
}

#[derive(Debug)]
struct Entry {
    id: String,
    bus: String,
    owner: String,
    path: String,
    /// The process behind `owner`, if the bus said. A click lets it raise its
    /// window with a token of its own.
    pid: Option<u32>,
    /// The name for shells. `None` until its properties have been read.
    name: Option<String>,
    /// `None` until its properties have been read, and while it is passive.
    shown: Option<TrayItem>,
}

impl Registry {
    /// Register the item at `path` on `bus`, owned by connection `owner` of
    /// process `pid`. Returns its id, or `None` if already registered.
    pub fn register(
        &mut self,
        bus: &str,
        owner: &str,
        path: &str,
        pid: Option<u32>,
    ) -> Option<String> {
        let id = format!("{bus}{path}");
        (!self.entries.iter().any(|entry| entry.id == id)).then(|| {
            self.entries.push(Entry {
                id: id.clone(),
                bus: bus.to_string(),
                owner: owner.to_string(),
                path: path.to_string(),
                pid,
                name: None,
                shown: None,
            });
            id
        })
    }

    /// Set how item `id` is shown, or `None` to hide it. Ignores an id that
    /// vanished while its properties were being read.
    pub fn show(&mut self, id: &str, shown: Option<TrayItem>) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) {
            entry.shown = shown;
        }
    }

    /// The bus name and path of item `id`.
    pub fn address(&self, id: &str) -> Option<(String, String)> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| (entry.bus.clone(), entry.path.clone()))
    }

    /// The name shells know item `id` by, set from its `Id` property
    /// (`calls_itself`) on the first call.
    ///
    /// Shells keep an icon's position by this name, so it comes from `Id`,
    /// which is stable across runs, rather than the bus name. Duplicates get a
    /// `#n` suffix, and an empty `Id` falls back to `id`.
    pub fn named(&mut self, id: &str, calls_itself: &str) -> String {
        let taken: Vec<String> = self
            .entries
            .iter()
            .filter_map(|entry| entry.name.clone())
            .collect();
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .expect("only an item held is named");
        entry
            .name
            .get_or_insert_with(|| {
                let base = if calls_itself.is_empty() {
                    id
                } else {
                    calls_itself
                };
                (1..)
                    .map(|n| match n {
                        1 => base.to_string(),
                        n => format!("{base}#{n}"),
                    })
                    .find(|name| !taken.contains(name))
                    .expect("a name nobody holds")
            })
            .clone()
    }

    /// The bus name and path of the item shells know as `name`.
    pub fn clicked(&self, name: &str) -> Option<(String, String)> {
        self.entries
            .iter()
            .find(|entry| entry.name.as_deref() == Some(name))
            .map(|entry| (entry.bus.clone(), entry.path.clone()))
    }

    /// The ids of items a signal from `sender` on `path` refers to.
    pub fn sent_by(&self, sender: &str, path: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.owner == sender && entry.path == path)
            .map(|entry| entry.id.clone())
            .collect()
    }

    /// Remove every item owned by `name`, a unique or well-known bus name.
    /// Returns their ids.
    pub fn vanished(&mut self, name: &str) -> Vec<String> {
        let (gone, kept) = std::mem::take(&mut self.entries)
            .into_iter()
            .partition(|entry| entry.owner == name || entry.bus == name);
        self.entries = kept;
        gone.into_iter().map(|entry: Entry| entry.id).collect()
    }

    /// Record that well-known name `name` moved to connection `owner` of
    /// process `pid`, which its items' signals now come from.
    pub fn moved(&mut self, name: &str, owner: &str, pid: Option<u32>) {
        for entry in self.entries.iter_mut().filter(|entry| entry.bus == name) {
            entry.owner = owner.to_string();
            entry.pid = pid;
        }
    }

    /// The paths of the items answering on `bus`.
    pub fn paths_on(&self, bus: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.bus == bus)
            .map(|entry| entry.path.clone())
            .collect()
    }

    /// The process behind each item, by the bus it answers on, which its
    /// menu is on too.
    pub fn pids_on_buses(&self) -> HashMap<String, u32> {
        self.entries
            .iter()
            .filter_map(|entry| Some((entry.bus.clone(), entry.pid?)))
            .collect()
    }

    /// The process behind each item, by its name for shells. An item not yet
    /// named, or whose process the bus would not give, is left out.
    pub fn pids(&self) -> HashMap<String, u32> {
        self.entries
            .iter()
            .filter_map(|entry| Some((entry.name.clone()?, entry.pid?)))
            .collect()
    }

    /// Every registered item's id, for the watcher's item list.
    pub fn ids(&self) -> Vec<String> {
        self.entries.iter().map(|entry| entry.id.clone()).collect()
    }

    /// The items to show in the tray.
    pub fn items(&self) -> Vec<TrayItem> {
        self.entries
            .iter()
            .filter_map(|entry| entry.shown.clone())
            .collect()
    }
}

/// The tray entry for an item answering on `bus`, or `None` if it is passive.
/// The title falls back to `id`, so it is never empty.
pub fn item(
    id: &str,
    bus: &str,
    properties: Properties,
    icons: &mut TrayIcons,
) -> Option<TrayItem> {
    (properties.status != Status::Passive).then(|| TrayItem {
        id: id.to_string(),
        icon: picture(&properties, icons),
        bus: bus.to_string(),
        menu: (!["", NO_MENU].contains(&properties.menu.as_str())).then(|| properties.menu.clone()),
        item_is_menu: properties.item_is_menu,
        title: [properties.tooltip, properties.title, properties.id]
            .into_iter()
            .find(|said| !said.is_empty())
            .unwrap_or_else(|| id.to_string()),
    })
}

/// The item's picture: the attention icon if it needs attention and has one,
/// else its icon. Names come before pixmaps, as the spec prefers.
fn picture(properties: &Properties, icons: &mut TrayIcons) -> Option<String> {
    let path = &properties.icon_theme_path;
    let attention = (properties.status == Status::NeedsAttention)
        .then(|| {
            icons
                .icon(&properties.attention_icon_name, path)
                .or_else(|| pixmap(&properties.attention_pixmaps))
        })
        .flatten();
    attention
        .or_else(|| icons.icon(&properties.icon_name, path))
        .or_else(|| pixmap(&properties.icon_pixmaps))
}

/// The best of `pixmaps` as a PNG `data:` URL: the smallest at least
/// [`WANTED_PIXELS`] wide, else the biggest. Skips pixmaps whose data does not
/// match their size.
fn pixmap(pixmaps: &[Pixmap]) -> Option<String> {
    let whole = pixmaps.iter().filter(|pixmap| {
        pixmap.width > 0
            && pixmap.height > 0
            && pixmap.argb.len() == pixmap.width as usize * pixmap.height as usize * 4
    });
    let big_enough = whole
        .clone()
        .filter(|pixmap| pixmap.width >= WANTED_PIXELS)
        .min_by_key(|pixmap| pixmap.width);
    big_enough
        .or_else(|| whole.max_by_key(|pixmap| pixmap.width))
        .map(|pixmap| {
            data_url(
                "image/png",
                &png(pixmap.width as u32, pixmap.height as u32, &pixmap.argb),
            )
        })
}

/// Tray icon lookup by name in the XDG data directories.
///
/// Searches an item's own directory, then the icon theme, its parents and
/// `hicolor` (see [`icon_theme`]), then `pixmaps`. Results, including misses,
/// are cached until the theme changes: an item that changes its icon uses a
/// new name. The cache keeps the `CACHED` lookups used last. A name that is
/// a path is read each time, since applications rewrite one file in place.
pub struct TrayIcons {
    data_dirs: Vec<PathBuf>,
    theme: Option<String>,
    /// Least recently used first.
    found: Vec<((String, String), Option<String>)>,
}

/// The most lookups [`TrayIcons`] keeps. Each holds up to [`LARGEST`] bytes,
/// and a tray shows a few icons.
const CACHED: usize = 32;

impl TrayIcons {
    /// Look up icons under `data_dirs`, highest priority first, in the icon
    /// theme `theme`, or `hicolor` alone for `None`.
    pub fn new(data_dirs: Vec<PathBuf>, theme: Option<String>) -> Self {
        TrayIcons {
            data_dirs,
            theme,
            found: Vec::new(),
        }
    }

    /// Look up icons in the icon theme `theme` from now on.
    pub fn retheme(&mut self, theme: Option<String>) {
        self.theme = theme;
        self.found.clear();
    }

    /// Icon `name` as a `data:` URL, searching `theme_path` first. `None` for
    /// an empty name or no drawable icon.
    pub fn icon(&mut self, name: &str, theme_path: &str) -> Option<String> {
        if name.is_empty() {
            None
        } else if Path::new(name).is_absolute() {
            read(Path::new(name))
        } else {
            let key = (name.to_string(), theme_path.to_string());
            let found = match self.found.iter().position(|(cached, _)| *cached == key) {
                Some(at) => self.found.remove(at).1,
                None => self.look_for(name, theme_path),
            };
            if self.found.len() == CACHED {
                self.found.remove(0);
            }
            self.found.push((key, found.clone()));
            found
        }
    }

    fn look_for(&self, name: &str, theme_path: &str) -> Option<String> {
        // Applications use their own directory as either a theme base or a
        // flat pixmap directory, so search it as both.
        let own: Vec<PathBuf> = (!theme_path.is_empty())
            .then(|| PathBuf::from(theme_path))
            .into_iter()
            .collect();
        let bases: Vec<PathBuf> = own
            .iter()
            .cloned()
            .chain(self.data_dirs.iter().map(|dir| dir.join("icons")))
            .collect();
        let flat = |dirs: Vec<PathBuf>| {
            dirs.into_iter().flat_map(|dir| {
                KINDS
                    .iter()
                    .map(move |(ext, _)| dir.join(format!("{name}.{ext}")))
            })
        };
        flat(own)
            .chain(flat(icon_theme::directories(
                &bases,
                self.theme.as_deref(),
                CONTEXTS,
                LOOKED_UP_AT,
            )))
            .chain(flat(
                self.data_dirs
                    .iter()
                    .map(|dir| dir.join("pixmaps"))
                    .collect(),
            ))
            .find_map(|path| read(&path))
    }
}

/// Supported extensions and their MIME types.
const KINDS: &[(&str, &str)] = &[("png", "image/png"), ("svg", "image/svg+xml")];

/// Largest icon file sent.
const LARGEST: u64 = 128 * 1024;

/// Reads `path` as a `data:` URL. Returns `None` for a missing, oversized or
/// unsupported file.
fn read(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    let (_, mime) = KINDS.iter().find(|(kind, _)| *kind == ext)?;
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > LARGEST {
        return None;
    }
    Some(data_url(mime, &fs::read(path).ok()?))
}

/// The item reads in flight, at most one per item.
///
/// A read waits until its application answers or the call times out, and an
/// application can signal on every change. A signal during a read makes one
/// more read after it, however many arrive.
#[derive(Debug, Default)]
pub struct Reads {
    /// The sequence the next read gets.
    next: u64,
    flying: HashMap<String, Flight>,
    /// Items with a read that timed out.
    hung: HashSet<String>,
}

/// An item's read in flight.
#[derive(Debug, Clone, Copy)]
struct Flight {
    sequence: u64,
    /// The item signaled since the read started.
    again: bool,
}

/// What [`Reads::landed`] makes of a reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Landed {
    /// From a read of an item that went away. Ignore it.
    Stale,
    /// The reply to the read in flight. Show it, then start read `again` if
    /// the item signaled meanwhile.
    Current { again: Option<u64> },
}

impl Reads {
    /// The sequence of a read of `id` to start, or `None` if one is in
    /// flight. That one is then read again when it lands.
    pub fn wanted(&mut self, id: &str) -> Option<u64> {
        match self.flying.get_mut(id) {
            Some(flight) => {
                flight.again = true;
                None
            }
            None => {
                let sequence = self.next();
                self.flying.insert(
                    id.to_string(),
                    Flight {
                        sequence,
                        again: false,
                    },
                );
                Some(sequence)
            }
        }
    }

    /// Record that read `sequence` of `id` replied.
    pub fn landed(&mut self, id: &str, sequence: u64) -> Landed {
        match self.flying.get(id).copied() {
            Some(flight) if flight.sequence == sequence => {
                let again = flight.again.then(|| self.next());
                match again {
                    Some(sequence) => {
                        self.flying.insert(
                            id.to_string(),
                            Flight {
                                sequence,
                                again: false,
                            },
                        );
                    }
                    None => {
                        self.flying.remove(id);
                    }
                }
                Landed::Current { again }
            }
            _ => Landed::Stale,
        }
    }

    /// Record that a read of `id` timed out. True the first time since it
    /// registered, so a hung item is logged once.
    pub fn hung(&mut self, id: &str) -> bool {
        self.hung.insert(id.to_string())
    }

    /// Forget item `id`, which went away. Its read in flight lands stale.
    pub fn forget(&mut self, id: &str) {
        self.flying.remove(id);
        self.hung.remove(id);
    }

    fn next(&mut self) -> u64 {
        let sequence = self.next;
        self.next += 1;
        sequence
    }
}

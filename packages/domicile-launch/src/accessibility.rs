//! `domicile accessibility` and `accessibility-act`: a native window read as
//! its AT-SPI accessibility tree, and its elements acted on, so an agent can
//! drive an app without pixels, hidden or not.
//!
//! A window is matched to the accessible application by its process, then to
//! one of that application's windows by title. Elements are named by a ref,
//! their bus name and object path joined (`:1.42/org/a11y/atspi/accessible/7`),
//! which an act checks still belongs to the same process.

use std::collections::HashSet;

/// An accessible object: its owner on the accessibility bus and its path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Element {
    pub bus: String,
    pub path: String,
}

impl Element {
    /// The ref an outline prints for it.
    pub fn reference(&self) -> String {
        format!("{}{}", self.bus, self.path)
    }

    /// The element a ref names, or `None` for one that is not a bus name
    /// followed by an object path.
    pub fn named(reference: &str) -> Option<Element> {
        let (bus, path) = reference.split_at(reference.find('/')?);
        (!bus.is_empty() && path.len() > 1).then(|| Element {
            bus: bus.to_string(),
            path: path.to_string(),
        })
    }
}

/// What an outline shows of an element.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Described {
    /// AT-SPI's role name, such as `push button`.
    pub role: String,
    pub name: String,
    /// The state bits, as `GetState` gives them: bit `n` of word `n / 32`.
    pub states: Vec<u32>,
    /// The text of an editable text element, if it has one to show.
    pub text: Option<String>,
}

/// AT-SPI state numbers an outline reads.
pub mod state {
    pub const CHECKED: u32 = 4;
    pub const EDITABLE: u32 = 7;
    pub const EXPANDED: u32 = 10;
    pub const FOCUSED: u32 = 12;
    pub const PRESSED: u32 = 20;
    pub const SELECTED: u32 = 23;
    pub const VISIBLE: u32 = 30;
}

impl Described {
    fn has(&self, state: u32) -> bool {
        self.states
            .get((state / 32) as usize)
            .is_some_and(|word| word & (1 << (state % 32)) != 0)
    }
}

/// What `accessibility-act` does to an element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Act {
    /// Its click, press or activate action, or else its first.
    Click,
    /// Give it the keyboard focus.
    Focus,
    /// Replace its text.
    SetText(String),
}

/// The accessibility bus, injected so the outline and matching can be tested
/// without one. [`AtSpi`] in a desktop.
pub trait Accessible {
    /// Each application on the bus: its root element.
    fn applications(&mut self) -> Result<Vec<Element>, String>;
    /// The process that owns `bus`.
    fn process(&mut self, bus: &str) -> Result<u32, String>;
    fn children(&mut self, element: &Element) -> Result<Vec<Element>, String>;
    fn describe(&mut self, element: &Element) -> Result<Described, String>;
    fn act(&mut self, element: &Element, act: &Act) -> Result<(), String>;
}

/// The most elements an outline lists, so a huge tree stays readable.
pub const MOST: usize = 1500;

/// Roles that only group others, which an outline leaves out unless named.
const GROUPING: [&str; 6] = [
    "filler",
    "panel",
    "section",
    "invalid",
    "unknown",
    "redundant object",
];

/// The longest name or text an outline shows, in characters.
const LONGEST: usize = 200;

/// The window of process `pid` titled `title`: the one top-level element of
/// its application that has that name, or its only one.
pub fn window(bus: &mut impl Accessible, pid: u32, title: &str) -> Result<Element, String> {
    let mut windows = Vec::new();
    for application in bus.applications()? {
        if bus.process(&application.bus).ok() != Some(pid) {
            continue;
        }
        for window in bus.children(&application)? {
            let name = bus.describe(&window)?.name;
            windows.push((window, name));
        }
    }
    if windows.is_empty() {
        return Err(format!(
            "process {pid} shows nothing on the accessibility bus: the app may \
             not support accessibility, or the bus may not be running"
        ));
    }
    let titled: Vec<&(Element, String)> =
        windows.iter().filter(|(_, name)| name == title).collect();
    match (titled.as_slice(), windows.as_slice()) {
        ([(window, _)], _) | ([], [(window, _)]) => Ok(window.clone()),
        _ => Err(format!(
            "process {pid} has {} accessible windows and {} titled {title:?}, so \
             which is this one is unclear: {}",
            windows.len(),
            titled.len(),
            windows
                .iter()
                .map(|(_, name)| format!("{name:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// `root`'s tree as an indented outline, one element a line: its role, name,
/// ref, text and states. Unnamed grouping elements give their place to their
/// children, invisible ones are left out with theirs, labels that repeat
/// their parent's name are left out, and a password's text is never shown.
pub fn outline(bus: &mut impl Accessible, root: &Element) -> Result<String, String> {
    let mut outline = Outline {
        lines: String::new(),
        listed: 0,
        cut: false,
    };
    outline.write(bus, root, 0, "", &mut HashSet::new())?;
    if outline.cut {
        outline
            .lines
            .push_str(&format!("… cut at {MOST} elements\n"));
    }
    Ok(outline.lines)
}

struct Outline {
    lines: String,
    listed: usize,
    cut: bool,
}

impl Outline {
    fn write(
        &mut self,
        bus: &mut impl Accessible,
        element: &Element,
        depth: usize,
        parent_name: &str,
        seen: &mut HashSet<Element>,
    ) -> Result<(), String> {
        // An app whose tree loops back on itself would never end.
        if !seen.insert(element.clone()) {
            return Ok(());
        }
        if self.listed >= MOST {
            self.cut = true;
            return Ok(());
        }
        let described = bus.describe(element)?;
        if !described.has(state::VISIBLE) {
            return Ok(());
        }
        let Described {
            role, name, text, ..
        } = &described;
        let shown = !(name.is_empty() && GROUPING.contains(&role.as_str()))
            && !(role == "label" && (name.is_empty() || name == parent_name));
        let (below, name_below) = if shown {
            self.listed += 1;
            self.lines.push_str(&"  ".repeat(depth));
            self.lines.push_str("- ");
            self.lines.push_str(role);
            if !name.is_empty() {
                self.lines.push_str(&format!(" {:?}", shortened(name)));
            }
            self.lines
                .push_str(&format!(" [ref={}]", element.reference()));
            match text {
                _ if role == "password text" => {}
                Some(text) if !text.is_empty() => {
                    self.lines.push_str(&format!(" text={:?}", shortened(text)));
                }
                _ => {}
            }
            for (state, word) in [
                (state::FOCUSED, "focused"),
                (state::CHECKED, "checked"),
                (state::PRESSED, "pressed"),
                (state::EXPANDED, "expanded"),
                (state::SELECTED, "selected"),
            ] {
                if described.has(state) {
                    self.lines.push(' ');
                    self.lines.push_str(word);
                }
            }
            self.lines.push('\n');
            (depth + 1, name.as_str())
        } else {
            (depth, parent_name)
        };
        for child in bus.children(element)? {
            self.write(bus, &child, below, name_below, seen)?;
        }
        Ok(())
    }
}

/// `text` cut to [`LONGEST`] characters.
fn shortened(text: &str) -> String {
    match text.char_indices().nth(LONGEST) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// Carries out `act` on `element`, which must belong to process `pid`.
pub fn act_on(
    bus: &mut impl Accessible,
    pid: u32,
    element: &Element,
    act: &Act,
) -> Result<(), String> {
    let owner = bus.process(&element.bus)?;
    if owner != pid {
        return Err(format!(
            "{} belongs to process {owner}, not this window's {pid}",
            element.reference()
        ));
    }
    bus.act(element, act)
}

/// The accessibility bus over D-Bus: AT-SPI 2.
pub struct AtSpi {
    connection: zbus::blocking::Connection,
}

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";

impl AtSpi {
    /// Connects to the session's accessibility bus, which `org.a11y.Bus` on
    /// the session bus names.
    pub fn connected() -> Result<AtSpi, String> {
        let session = zbus::blocking::Connection::session()
            .map_err(|why| format!("no session bus: {why}"))?;
        let address: String = session
            .call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.a11y.Bus"),
                "GetAddress",
                &(),
            )
            .and_then(|reply| reply.body().deserialize())
            .map_err(|why| {
                format!(
                    "no accessibility bus: {why}. at-spi2-core provides it; on NixOS, \
                     services.gnome.at-spi2-core.enable"
                )
            })?;
        let connection = zbus::blocking::connection::Builder::address(address.as_str())
            .and_then(|builder| builder.build())
            .map_err(|why| format!("could not reach the accessibility bus at {address}: {why}"))?;
        Ok(AtSpi { connection })
    }

    fn call<R>(
        &self,
        element: &Element,
        interface: &str,
        method: &str,
        body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
    ) -> Result<R, String>
    where
        R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
    {
        self.connection
            .call_method(
                Some(element.bus.as_str()),
                element.path.as_str(),
                Some(interface),
                method,
                body,
            )
            .and_then(|reply| reply.body().deserialize())
            .map_err(|why| format!("{interface}.{method} on {}: {why}", element.reference()))
    }

    fn property<R>(&self, element: &Element, interface: &str, name: &str) -> Result<R, String>
    where
        R: TryFrom<zbus::zvariant::OwnedValue>,
    {
        let value: zbus::zvariant::OwnedValue = self.call(
            element,
            "org.freedesktop.DBus.Properties",
            "Get",
            &(interface, name),
        )?;
        R::try_from(value).map_err(|_| {
            format!(
                "{interface}.{name} on {} is not the type AT-SPI gives it",
                element.reference()
            )
        })
    }

    fn interfaces(&self, element: &Element) -> Result<Vec<String>, String> {
        self.call(element, ACCESSIBLE, "GetInterfaces", &())
    }
}

/// An `(so)` reference as AT-SPI sends it.
type Reference = (String, zbus::zvariant::OwnedObjectPath);

fn element_of((bus, path): Reference) -> Element {
    Element {
        bus,
        path: path.to_string(),
    }
}

impl Accessible for AtSpi {
    fn applications(&mut self) -> Result<Vec<Element>, String> {
        let registry = Element {
            bus: "org.a11y.atspi.Registry".to_string(),
            path: "/org/a11y/atspi/accessible/root".to_string(),
        };
        self.children(&registry)
    }

    fn process(&mut self, bus: &str) -> Result<u32, String> {
        self.connection
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetConnectionUnixProcessID",
                &(bus,),
            )
            .and_then(|reply| reply.body().deserialize())
            .map_err(|why| format!("which process owns {bus}: {why}"))
    }

    fn children(&mut self, element: &Element) -> Result<Vec<Element>, String> {
        let children: Vec<Reference> = self.call(element, ACCESSIBLE, "GetChildren", &())?;
        Ok(children
            .into_iter()
            .map(element_of)
            // AT-SPI's null reference, which some apps list for a child
            // that is gone.
            .filter(|child| child.path != "/org/a11y/atspi/null")
            .collect())
    }

    fn describe(&mut self, element: &Element) -> Result<Described, String> {
        let role: String = self.call(element, ACCESSIBLE, "GetRoleName", &())?;
        let name: String = self.property(element, ACCESSIBLE, "Name")?;
        let states: Vec<u32> = self.call(element, ACCESSIBLE, "GetState", &())?;
        let mut described = Described {
            role,
            name,
            states,
            text: None,
        };
        if described.has(state::EDITABLE)
            && self
                .interfaces(element)?
                .iter()
                .any(|name| name == "org.a11y.atspi.Text")
        {
            let count: i32 = self.property(element, "org.a11y.atspi.Text", "CharacterCount")?;
            described.text =
                Some(self.call(element, "org.a11y.atspi.Text", "GetText", &(0i32, count))?);
        }
        Ok(described)
    }

    fn act(&mut self, element: &Element, act: &Act) -> Result<(), String> {
        let done: bool = match act {
            Act::Click => {
                let count: i32 = self.property(element, "org.a11y.atspi.Action", "NActions")?;
                if count == 0 {
                    return Err(format!("{} has no action to click", element.reference()));
                }
                let names: Vec<String> = (0..count)
                    .map(|index| self.call(element, "org.a11y.atspi.Action", "GetName", &(index,)))
                    .collect::<Result<_, _>>()?;
                let index = names
                    .iter()
                    .position(|name| {
                        ["click", "press", "activate", "toggle", "jump"].contains(&name.as_str())
                    })
                    .unwrap_or(0);
                self.call(
                    element,
                    "org.a11y.atspi.Action",
                    "DoAction",
                    &(index as i32,),
                )?
            }
            Act::Focus => self.call(element, "org.a11y.atspi.Component", "GrabFocus", &())?,
            Act::SetText(text) => self.call(
                element,
                "org.a11y.atspi.EditableText",
                "SetTextContents",
                &(text.as_str(),),
            )?,
        };
        if done {
            Ok(())
        } else {
            Err(format!("{} refused to {act:?}", element.reference()))
        }
    }
}

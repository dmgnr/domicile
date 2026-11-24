//! `domicile mcp`'s browser tools: a browser window's page, and each view it
//! holds, read as its accessibility tree and driven by the elements in it,
//! through `domicile devtools`. They need no screenshot and work on a window
//! the desk hides.

use std::collections::HashMap;
use std::io;

use domicile_protocol::ListedView;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::changes::{changed, SETTLE};
use super::{said, string, Ran};

/// A browser tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Browser {
    Snapshot,
    Click,
    Type,
    Key,
    Navigate,
    Screenshot,
}

/// The window the browser tools name to reach the shell's own page: its
/// bars, panels and dialogs.
const SHELL: &str = crate::control::SHELL_WINDOW;

/// The longest name or value a snapshot shows of one element, in characters.
const LONGEST: usize = 200;

/// A browser tool's description, its arguments' JSON schemas and which are
/// required.
pub(super) fn described(tool: Browser) -> (&'static str, Value, Vec<&'static str>) {
    let window = json!({"type": "string", "description": "A browser window's id, from list_windows, or \"shell\" for the shell's own bars, panels and dialogs."});
    let element =
        json!({"type": "string", "description": "An element's ref, from browser_snapshot."});
    let view = json!({"type": "string", "description": "One of the window's views, from browser_snapshot or list_windows. Left out, the window's own page."});
    match tool {
        Browser::Snapshot => (
            "Read a browser window's page, then each view it holds, as accessibility trees: one element a line, with the ref the other browser tools take. An Electron app such as Claude or Slack draws its page in views. Works on hidden windows; private ones are refused.",
            json!({"window": window}),
            vec!["window"],
        ),
        Browser::Click => (
            "Click an element of a browser window's page or view by its ref, scrolling it into view first. Answers what it changed in the window.",
            json!({"window": window, "ref": element}),
            vec!["window", "ref"],
        ),
        Browser::Type => (
            "Type text into a browser window's page or view: into the element with ref, focusing it first, or where its focus is. Answers what it changed in the window.",
            json!({"window": window, "ref": element, "view": view, "text": {"type": "string"}}),
            vec!["window", "text"],
        ),
        Browser::Key => (
            "Press and release a key in a browser window's page or view. Answers what it changed in the window.",
            json!({"window": window, "view": view, "key": {"type": "string", "enum": KEYS.iter().map(|key| key.0).collect::<Vec<_>>()}}),
            vec!["window", "key"],
        ),
        Browser::Navigate => (
            "Load an http or https address in a browser window. Answers what it changed in the window.",
            json!({"window": window, "url": {"type": "string"}}),
            vec!["window", "url"],
        ),
        Browser::Screenshot => (
            "Take a WebP of a browser window's page or view as it draws, hidden or not.",
            json!({"window": window, "view": view}),
            vec!["window"],
        ),
    }
}

/// `tools/call`'s result for browser tool `tool` with `arguments`. A read
/// keeps the window's outline in `read`; an act answers what it changed.
pub(super) fn called(
    tool: Browser,
    arguments: &Map<String, Value>,
    domicile: &mut impl FnMut(&[String]) -> io::Result<Ran>,
    read: &mut HashMap<String, String>,
) -> io::Result<Value> {
    let window = match string(arguments, "window") {
        Ok(Some(window)) => window,
        Ok(None) => return Ok(said(false, "this tool takes a window id".to_string())),
        Err(why) => return Ok(said(false, why)),
    };
    let (view, element) = match aimed(arguments) {
        Ok(aim) => aim,
        Err(why) => return Ok(said(false, why)),
    };
    let mut page = Page {
        window,
        view,
        domicile,
    };
    let answer = match carried_out(tool, arguments, element, &mut page)? {
        Ok(answer) => answer,
        Err(why) => return Ok(said(false, why)),
    };
    match tool {
        Browser::Snapshot => {
            let outline = answer["content"][0]["text"]
                .as_str()
                .expect("a browser tool answers text");
            read.insert(page.window.clone(), outline.to_string());
            Ok(answer)
        }
        Browser::Screenshot => Ok(answer),
        Browser::Click | Browser::Type | Browser::Key | Browser::Navigate => {
            let did = answer["content"][0]["text"]
                .as_str()
                .expect("a browser tool answers text");
            std::thread::sleep(SETTLE);
            page.view = None;
            let after = match outline_of(&mut page)? {
                Ok(after) => after,
                Err(why) => {
                    return Ok(said(
                        true,
                        format!("{did}\nIt could not be read again: {why}"),
                    ))
                }
            };
            let changes = changed(read.get(&page.window).map(String::as_str), &after);
            read.insert(page.window.clone(), after);
            Ok(said(true, format!("{did}\n{changes}")))
        }
    }
}

/// A browser window's page, or its view `view`, which `domicile devtools`
/// sends methods to.
struct Page<'a, D> {
    window: String,
    view: Option<String>,
    domicile: &'a mut D,
}

impl<D: FnMut(&[String]) -> io::Result<Ran>> Page<'_, D> {
    /// `method`'s result, or why there is none.
    fn send(&mut self, method: &str, params: Value) -> io::Result<Result<Value, String>> {
        let view = self
            .view
            .iter()
            .flat_map(|view| ["--view".to_string(), view.clone()]);
        let ran = (self.domicile)(
            &std::iter::once("devtools".to_string())
                .chain(view)
                .chain([self.window.clone(), method.to_string(), params.to_string()])
                .collect::<Vec<_>>(),
        )?;
        if !ran.success {
            return Ok(Err(ran.stderr));
        }
        serde_json::from_str(&ran.stdout).map(Ok).map_err(|why| {
            io::Error::other(format!(
                "domicile devtools printed {:?}, which is not JSON: {why}",
                ran.stdout
            ))
        })
    }

    /// The views the window holds, as `domicile list-windows` lists them, or
    /// why there are none.
    fn views(&mut self) -> io::Result<Result<Vec<ListedView>, String>> {
        let ran = (self.domicile)(&["list-windows".to_string(), "--json".to_string()])?;
        if !ran.success {
            return Ok(Err(ran.stderr));
        }
        let windows: Vec<Listed> = serde_json::from_str(&ran.stdout).map_err(|why| {
            io::Error::other(format!(
                "domicile list-windows printed {:?}, which is not its windows: {why}",
                ran.stdout
            ))
        })?;
        Ok(windows
            .into_iter()
            .find(|listed| listed.id == self.window)
            .map(|listed| listed.views)
            .ok_or_else(|| format!("window {} closed", self.window)))
    }
}

/// What the browser tools read of a window `domicile list-windows` lists.
#[derive(Deserialize)]
struct Listed {
    id: String,
    views: Vec<ListedView>,
}

/// Sends `$method` with `$params`, returning the tool's refusal if it fails.
macro_rules! sent {
    ($page:expr, $method:expr, $params:expr) => {
        match $page.send($method, $params)? {
            Ok(result) => result,
            Err(why) => return Ok(Err(why)),
        }
    };
}

/// The window's page, then each view it holds, as outlines, or why they
/// can't be read.
fn outline_of<D: FnMut(&[String]) -> io::Result<Ran>>(
    page: &mut Page<'_, D>,
) -> io::Result<Result<String, String>> {
    let tree = sent!(page, "Accessibility.getFullAXTree", json!({}));
    let mut lines = outline(&tree, 0, "");
    // The shell's page holds no views, and is no window list-windows lists.
    if page.window == SHELL {
        return Ok(Ok(lines));
    }
    let views = match page.views()? {
        Ok(views) => views,
        Err(why) => return Ok(Err(why)),
    };
    for view in views {
        page.view = Some(view.id.clone());
        let tree = sent!(page, "Accessibility.getFullAXTree", json!({}));
        let [x, y] = view.position;
        let [width, height] = view.size;
        lines.push_str(&format!(
            "- view {}, at {x},{y}, {width}x{height}\n",
            view.id
        ));
        lines.push_str(&outline(&tree, 1, &format!("{}:", view.id)));
    }
    Ok(Ok(lines))
}

fn carried_out<D: FnMut(&[String]) -> io::Result<Ran>>(
    tool: Browser,
    arguments: &Map<String, Value>,
    element: Option<u64>,
    page: &mut Page<'_, D>,
) -> io::Result<Result<Value, String>> {
    match tool {
        Browser::Snapshot => Ok(outline_of(page)?.map(|lines| said(true, lines))),
        Browser::Click => {
            let Some(element) = element else {
                return Ok(Err("browser_click takes the ref of an element".to_string()));
            };
            let node = json!({"backendNodeId": element});
            sent!(page, "DOM.scrollIntoViewIfNeeded", node.clone());
            let quads = sent!(page, "DOM.getContentQuads", node);
            let Some((x, y)) = middle(&quads) else {
                return Ok(Err(format!(
                    "element {element} has no box on the page to click; it may be hidden"
                )));
            };
            for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
                sent!(
                    page,
                    "Input.dispatchMouseEvent",
                    json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
                );
            }
            Ok(Ok(said(true, format!("clicked element {element}"))))
        }
        Browser::Type => {
            let text = match string(arguments, "text") {
                Ok(Some(text)) => text,
                Ok(None) => return Ok(Err("browser_type takes text".to_string())),
                Err(why) => return Ok(Err(why)),
            };
            if let Some(element) = element {
                sent!(page, "DOM.focus", json!({"backendNodeId": element}));
            }
            sent!(page, "Input.insertText", json!({"text": text}));
            Ok(Ok(said(true, "typed".to_string())))
        }
        Browser::Key => {
            let named = string(arguments, "key").ok().flatten();
            let Some(&(key, code, vk, text)) =
                KEYS.iter().find(|known| Some(known.0) == named.as_deref())
            else {
                return Ok(Err(format!(
                    "browser_key takes one of {}",
                    KEYS.iter().map(|key| key.0).collect::<Vec<_>>().join(", ")
                )));
            };
            let mut down =
                json!({"type": "keyDown", "key": key, "code": code, "windowsVirtualKeyCode": vk});
            if let Some(text) = text {
                down["text"] = json!(text);
            }
            sent!(page, "Input.dispatchKeyEvent", down);
            sent!(
                page,
                "Input.dispatchKeyEvent",
                json!({"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk})
            );
            Ok(Ok(said(true, format!("pressed {key}"))))
        }
        Browser::Navigate => {
            let url = match string(arguments, "url") {
                Ok(Some(url)) => url,
                Ok(None) => return Ok(Err("browser_navigate takes a url".to_string())),
                Err(why) => return Ok(Err(why)),
            };
            let navigated = sent!(page, "Page.navigate", json!({"url": url}));
            match navigated["errorText"].as_str() {
                Some(why) if !why.is_empty() => Ok(Err(format!("{url} did not load: {why}"))),
                _ => Ok(Ok(said(true, format!("loading {url}")))),
            }
        }
        Browser::Screenshot => {
            let shot = sent!(
                page,
                "Page.captureScreenshot",
                json!({"format": "webp", "quality": 70})
            );
            let Some(data) = shot["data"].as_str() else {
                return Ok(Err("the page answered no image".to_string()));
            };
            Ok(Ok(json!({
                "content": [{"type": "image", "data": data, "mimeType": "image/webp"}],
                "isError": false,
            })))
        }
    }
}

/// The keys `browser_key` presses: the key's name, its code, its Windows
/// virtual key code, and the text it types, if any.
const KEYS: [(&str, &str, u32, Option<&str>); 14] = [
    ("Enter", "Enter", 13, Some("\r")),
    ("Tab", "Tab", 9, None),
    ("Escape", "Escape", 27, None),
    ("Backspace", "Backspace", 8, None),
    ("Delete", "Delete", 46, None),
    ("Space", "Space", 32, Some(" ")),
    ("ArrowUp", "ArrowUp", 38, None),
    ("ArrowDown", "ArrowDown", 40, None),
    ("ArrowLeft", "ArrowLeft", 37, None),
    ("ArrowRight", "ArrowRight", 39, None),
    ("Home", "Home", 36, None),
    ("End", "End", 35, None),
    ("PageUp", "PageUp", 33, None),
    ("PageDown", "PageDown", 34, None),
];

/// The view a tool acts in and the element argument `ref` names, if given.
/// A ref from a view, `<view>:<element>`, names its view; argument `view`
/// names one for a tool given no ref.
fn aimed(arguments: &Map<String, Value>) -> Result<(Option<String>, Option<u64>), String> {
    let view = string(arguments, "view")?;
    let not_a_ref =
        |element: &Value| format!("ref is an element's ref from browser_snapshot, not {element}");
    let (in_view, element) = match arguments.get("ref") {
        None => (None, None),
        Some(Value::Number(element)) => (
            None,
            Some(
                element
                    .as_u64()
                    .ok_or_else(|| not_a_ref(&Value::Number(element.clone())))?,
            ),
        ),
        Some(Value::String(said)) => {
            let (in_view, element) = match said.split_once(':') {
                Some((in_view, element)) => (Some(in_view.to_string()), element),
                None => (None, said.as_str()),
            };
            let element = element
                .parse()
                .map_err(|_| not_a_ref(&Value::String(said.clone())))?;
            (in_view, Some(element))
        }
        Some(other) => return Err(not_a_ref(other)),
    };
    match (in_view, view) {
        (Some(in_view), Some(view)) if in_view != view => Err(format!(
            "ref {in_view}:{} is in view {in_view}, not view {view}",
            element.expect("a ref names its view")
        )),
        (Some(in_view), _) => Ok((Some(in_view), element)),
        (None, view) => Ok((view, element)),
    }
}

/// The middle of the first quad DOM.getContentQuads answers, in the page's
/// CSS pixels, as Input.dispatchMouseEvent takes them.
fn middle(quads: &Value) -> Option<(f64, f64)> {
    let quad: Vec<f64> = quads["quads"]
        .get(0)?
        .as_array()?
        .iter()
        .map(Value::as_f64)
        .collect::<Option<_>>()?;
    let [x1, y1, x2, y2, x3, y3, x4, y4] = quad.as_slice() else {
        return None;
    };
    Some(((x1 + x2 + x3 + x4) / 4.0, (y1 + y2 + y3 + y4) / 4.0))
}

/// Roles that only group others, which a snapshot leaves out unless named.
const GROUPING: [&str; 5] = [
    "generic",
    "none",
    "presentation",
    "InlineTextBox",
    "LineBreak",
];

/// Accessibility.getFullAXTree's nodes as an outline indented from `depth`,
/// one element a line: its role, name, ref after `prefix`, value and states.
/// Ignored and unnamed grouping nodes give their place to their children, and
/// text that repeats its parent's name is left out.
fn outline(tree: &Value, depth: usize, prefix: &str) -> String {
    let nodes: Vec<&Value> = tree["nodes"]
        .as_array()
        .map_or(Vec::new(), |nodes| nodes.iter().collect());
    let by_id: std::collections::HashMap<&str, &Value> = nodes
        .iter()
        .filter_map(|node| Some((node["nodeId"].as_str()?, *node)))
        .collect();
    let mut lines = String::new();
    if let Some(root) = nodes.first() {
        write_node(root, &by_id, depth, "", prefix, &mut lines);
    }
    lines
}

fn write_node(
    node: &Value,
    by_id: &std::collections::HashMap<&str, &Value>,
    depth: usize,
    parent_name: &str,
    prefix: &str,
    lines: &mut String,
) {
    let role = node["role"]["value"].as_str().unwrap_or("");
    let name = node["name"]["value"].as_str().unwrap_or("");
    let ignored = node["ignored"].as_bool().unwrap_or(false);
    let shown = !ignored
        && !(name.is_empty() && GROUPING.contains(&role))
        && !(role == "StaticText" && (name.is_empty() || name == parent_name));
    let (depth_below, name_below) = if shown {
        lines.push_str(&"  ".repeat(depth));
        lines.push_str("- ");
        lines.push_str(role);
        if !name.is_empty() {
            lines.push_str(&format!(" {:?}", shortened(name)));
        }
        if let Some(element) = node["backendDOMNodeId"].as_u64() {
            lines.push_str(&format!(" [ref={prefix}{element}]"));
        }
        if let Some(value) = node["value"]["value"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            lines.push_str(&format!(" value={:?}", shortened(value)));
        }
        for property in node["properties"].as_array().into_iter().flatten() {
            let state = property["name"].as_str().unwrap_or("");
            let value = &property["value"]["value"];
            match state {
                "focused" | "disabled" | "required" | "readonly" | "modal" if value == true => {
                    lines.push(' ');
                    lines.push_str(state);
                }
                "checked" | "pressed" | "expanded" | "selected" => {
                    lines.push_str(&format!(" {state}={value}"));
                }
                _ => {}
            }
        }
        lines.push('\n');
        (depth + 1, name)
    } else {
        (depth, parent_name)
    };
    for child in node["childIds"].as_array().into_iter().flatten() {
        if let Some(child) = child.as_str().and_then(|id| by_id.get(id)) {
            write_node(child, by_id, depth_below, name_below, prefix, lines);
        }
    }
}

/// `text` cut to [`LONGEST`] characters.
fn shortened(text: &str) -> String {
    match text.char_indices().nth(LONGEST) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

//! `domicile mcp`: a Model Context Protocol server over stdio, so an agent
//! such as Claude Code can drive the running desktop.
//!
//! Each tool runs one `domicile` verb and answers what it printed. Reading the
//! desktop goes through the CLI, so a tool and its verb cannot disagree. See
//! `docs/CLI.md#domicile-mcp`.
//!
//! The first tool call asks the user to let the agent in, through `domicile
//! agent`: the whole desk, or only some windows. Every call after is checked
//! against what they allowed, and listed in the shell as what the agent did.
//! See `docs/AGENTS.md`.

mod acme;
mod browser;
mod changes;
mod http;
mod oauth;
pub mod web;

use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use browser::Browser;
pub use http::{serve_http, Web, IDLE_MS};
pub use oauth::{sign_out, signed_in, Answer, Asks, Said, SignedIn, ASK_MS, SIGNED_IN_FILE};

use domicile_protocol::{AgentReach, DeskShot};
use serde_json::{json, Map, Value};

/// The protocol versions this server speaks, newest first.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// JSON-RPC error codes.
const PARSE_ERROR: i64 = -32700;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// What a run of `domicile` printed, and whether it succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// What the user let an agent do, from `domicile agent`.
pub struct Grant {
    /// What the user lets it reach now; they may change it.
    pub reach: Box<dyn Fn() -> AgentReach>,
    /// Whether the user has stopped it since.
    pub stopped: Box<dyn Fn() -> bool>,
    /// Lists what it did, in the shell.
    pub did: Box<dyn FnMut(&str)>,
}

/// What an agent calls itself when its client gives no name.
const UNNAMED: &str = "An agent";

/// The agent this server serves, and what the user let it do.
struct Session {
    /// As its client names itself in `initialize`.
    name: String,
    /// `None` until its first tool call asks the user; then the grant, or
    /// why there is none.
    grant: Option<Result<Grant, String>>,
    /// Each window's title, as last listed, to say where the agent acted.
    titles: HashMap<String, String>,
    /// The last screenshot, whose pixels the pointer tools take.
    view: Option<View>,
    /// Each window's outline, by id, as the agent last read it, to answer
    /// an act with what it changed.
    read: HashMap<String, String>,
}

/// Runs the `domicile` binary with the arguments it is given.
type Runs<'a> = dyn FnMut(&[String]) -> io::Result<Ran> + 'a;

/// Asks the user to let the agent it names in.
type Admits<'a> = dyn FnMut(&str) -> Result<Grant, String> + 'a;

/// One agent's conversation with this server: what it is called, what the
/// user let it do, and the `domicile` it drives. Each transport keeps one per
/// session.
pub struct Agent<'a> {
    session: Session,
    domicile: Box<Runs<'a>>,
    admit: Box<Admits<'a>>,
}

impl<'a> Agent<'a> {
    /// `domicile` runs the `domicile` binary with the arguments it is given.
    /// `admit` asks the user to let the agent it names in, and holds it in
    /// until this is dropped.
    pub fn new(
        domicile: impl FnMut(&[String]) -> io::Result<Ran> + 'a,
        admit: impl FnMut(&str) -> Result<Grant, String> + 'a,
    ) -> Agent<'a> {
        Agent {
            session: Session {
                name: UNNAMED.to_string(),
                grant: None,
                titles: HashMap::new(),
                view: None,
                read: HashMap::new(),
            },
            domicile: Box::new(domicile),
            admit: Box::new(admit),
        }
    }

    /// The reply to one JSON-RPC message, or `None` for a notification.
    pub fn answer(&mut self, message: &Value) -> io::Result<Option<Value>> {
        answer(
            message,
            &mut self.domicile,
            &mut self.admit,
            &mut self.session,
        )
    }

    /// The reply to one line of JSON-RPC, which may not parse.
    pub fn answer_line(&mut self, line: &str) -> io::Result<Option<Value>> {
        match serde_json::from_str::<Value>(line) {
            Ok(message) => self.answer(&message),
            Err(why) => Ok(Some(error(&Value::Null, PARSE_ERROR, &why.to_string()))),
        }
    }
}

/// Answers each JSON-RPC message on `input`, one per line, on `output`, until
/// `input` ends, as one [`Agent`].
pub fn serve(
    input: impl BufRead,
    mut output: impl Write,
    domicile: impl FnMut(&[String]) -> io::Result<Ran>,
    admit: impl FnMut(&str) -> Result<Grant, String>,
) -> io::Result<()> {
    let mut agent = Agent::new(domicile, admit);
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = agent.answer_line(&line)? {
            writeln!(output, "{reply}")?;
            output.flush()?;
        }
    }
    Ok(())
}

/// The reply to `message`, or `None` for a notification.
fn answer(
    message: &Value,
    domicile: &mut impl FnMut(&[String]) -> io::Result<Ran>,
    admit: &mut impl FnMut(&str) -> Result<Grant, String>,
    session: &mut Session,
) -> io::Result<Option<Value>> {
    let Some(id) = message.get("id") else {
        return Ok(None);
    };
    let params = &message["params"];
    let reply = match message["method"].as_str() {
        Some("initialize") => {
            session.name = named(params);
            result(id, initialized(params))
        }
        Some("ping") => result(id, json!({})),
        Some("tools/list") => result(id, json!({"tools": listed_tools()})),
        Some("tools/call") => match params["name"].as_str().and_then(tool) {
            Some(tool) => result(
                id,
                guarded(tool, &params["arguments"], domicile, admit, session)?,
            ),
            None => error(id, INVALID_PARAMS, &format!("no tool {}", params["name"])),
        },
        _ => error(
            id,
            METHOD_NOT_FOUND,
            &format!("no method {}", message["method"]),
        ),
    };
    Ok(Some(reply))
}

/// `initialize`'s result: the client's protocol version when this server
/// speaks it, else the newest this server does.
fn initialized(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str();
    let version = PROTOCOL_VERSIONS
        .into_iter()
        .find(|version| Some(*version) == asked)
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "domicile", "version": env!("CARGO_PKG_VERSION")},
        "instructions": INSTRUCTIONS,
    })
}

/// How an agent should use the tools, sent in `initialize`. Reading a window
/// as text takes fewer steps and tokens than looking at the desk.
const INSTRUCTIONS: &str = "Read and act on windows as text first: list_windows, then \
    browser_snapshot or app_snapshot, then the browser_ and app_ tools by ref. The \
    browser_ tools reach the shell's own bars, panels and dialogs as window \"shell\". \
    Each act answers what it changed in the window, so there is no need to look again. \
    Use screenshot only for what a tree can't show: images, layout, or an app that \
    doesn't support accessibility. Zoom into an area rather than taking the whole desk \
    again. When you are done with the desktop, call stop_using_desktop.";

/// What the client calls itself in `initialize`: its title, else its name.
fn named(params: &Value) -> String {
    let client = &params["clientInfo"];
    [&client["title"], &client["name"]]
        .into_iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|name| !name.is_empty())
        .map_or_else(|| UNNAMED.to_string(), str::to_string)
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// A tool: the `domicile` verb it runs.
#[derive(Debug, Clone, Copy)]
enum Tool {
    /// A verb whose `--json` listing is the answer.
    Listing(&'static str),
    SendShell,
    Exec,
    Open,
    /// A verb that takes a `list-windows` id.
    WindowAct(&'static str),
    Theme,
    Screenshot,
    Click,
    MovePointer,
    Drag,
    Scroll,
    Key,
    TypeText,
    /// A browser window driven through `domicile devtools`.
    Browser(Browser),
    /// `accessibility`: a native window's tree.
    AppSnapshot,
    /// `accessibility-act` with this act, which takes no text but `set-text`.
    AppAct(&'static str),
    /// Asks the user again, after they stopped the agent or turned it away.
    AskToUse,
    /// Lets go of the desktop, ending the agent's grant.
    StopUsing,
}

/// Where the last screenshot's top-left corner is on the desk, and how many
/// pixels of the desk each of its pixels is, across and down.
#[derive(Debug, Clone, Copy)]
struct View {
    left: f64,
    top: f64,
    across: f64,
    down: f64,
}

/// The longest side of a screenshot, in pixels. Models see larger images
/// shrunk, which would move every point they read off one.
const FIT: u32 = 1280;

/// Each tool, by name, in the order `tools/list` gives them.
const TOOLS: [(&str, Tool); 31] = [
    ("list_windows", Tool::Listing("list-windows")),
    ("list_displays", Tool::Listing("list-displays")),
    ("list_inputs", Tool::Listing("list-inputs")),
    ("status", Tool::Listing("status")),
    ("list_shell_commands", Tool::Listing("list-shell-commands")),
    ("list_bindings", Tool::Listing("list-bindings")),
    ("send_shell", Tool::SendShell),
    ("exec", Tool::Exec),
    ("open", Tool::Open),
    ("focus_window", Tool::WindowAct("focus-window")),
    ("close_window", Tool::WindowAct("close-window")),
    ("theme", Tool::Theme),
    ("screenshot", Tool::Screenshot),
    ("click", Tool::Click),
    ("move_pointer", Tool::MovePointer),
    ("drag", Tool::Drag),
    ("scroll", Tool::Scroll),
    ("key", Tool::Key),
    ("type_text", Tool::TypeText),
    ("browser_snapshot", Tool::Browser(Browser::Snapshot)),
    ("browser_click", Tool::Browser(Browser::Click)),
    ("browser_type", Tool::Browser(Browser::Type)),
    ("browser_key", Tool::Browser(Browser::Key)),
    ("browser_navigate", Tool::Browser(Browser::Navigate)),
    ("browser_screenshot", Tool::Browser(Browser::Screenshot)),
    ("app_snapshot", Tool::AppSnapshot),
    ("app_click", Tool::AppAct("click")),
    ("app_focus", Tool::AppAct("focus")),
    ("app_set_text", Tool::AppAct("set-text")),
    ("ask_to_use_desktop", Tool::AskToUse),
    ("stop_using_desktop", Tool::StopUsing),
];

fn tool(name: &str) -> Option<Tool> {
    TOOLS
        .into_iter()
        .find(|(named, _)| *named == name)
        .map(|(_, tool)| tool)
}

fn listed_tools() -> Vec<Value> {
    TOOLS
        .into_iter()
        .map(|(name, tool)| {
            let (description, properties, required) = described(tool);
            json!({
                "name": name,
                "description": description,
                "inputSchema": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            })
        })
        .collect()
}

/// A tool's description, its arguments' JSON schemas and which are required.
fn described(tool: Tool) -> (&'static str, Value, Vec<&'static str>) {
    let window_id =
        json!({"id": {"type": "string", "description": "The window's id, from list_windows."}});
    let coordinate = json!({"type": "number", "description": "In the last screenshot's pixels."});
    let point = json!({"type": "array", "items": coordinate, "minItems": 2, "maxItems": 2});
    let native =
        json!({"type": "string", "description": "A native window's id, from list_windows."});
    let app_element =
        json!({"type": "string", "description": "An element's ref, from app_snapshot."});
    match tool {
        Tool::Listing("list-windows") => (
            "List the windows, native and browser, as JSON: id, kind, title, app, pid, size, focused, url, private, and the views a browser window holds.",
            json!({}),
            vec![],
        ),
        Tool::Listing("list-displays") => (
            "List the displays as JSON: name, mode, scale, position, and whether each is on.",
            json!({}),
            vec![],
        ),
        Tool::Listing("list-inputs") => (
            "List the keyboards, pointers and touch devices as JSON.",
            json!({}),
            vec![],
        ),
        Tool::Listing("status") => (
            "The desktop's state as JSON: shell, theme, keymap, lock, screens, and what keeps them on or captures the desktop.",
            json!({}),
            vec![],
        ),
        Tool::Listing("list-shell-commands") => (
            "List the commands send_shell takes, as the shell describes them, as JSON.",
            json!({}),
            vec![],
        ),
        Tool::Listing(_) => (
            "List the shell's keys and gestures in each binding mode and what they run, as JSON.",
            json!({}),
            vec![],
        ),
        Tool::SendShell => (
            "Run a shell command, as a keybinding does, and answer what it printed. list_shell_commands lists them.",
            json!({"words": {"type": "array", "items": {"type": "string"}, "description": "The command and its arguments, such as [\"focus\", \"left\"]."}}),
            vec!["words"],
        ),
        Tool::Exec => (
            "Start a program as the desktop starts apps, without a shell, its name found on the desktop's PATH. Fails saying why when it does not start.",
            json!({"argv": {"type": "array", "items": {"type": "string"}, "minItems": 1, "description": "The program and its arguments, such as [\"kitty\", \"--hold\", \"btop\"]."}}),
            vec!["argv"],
        ),
        Tool::Open => (
            "Open a file, folder or URL with its default app; a URL opens in a browser window.",
            json!({
                "target": {"type": "string", "description": "An absolute path or a URL."},
                "app": {"type": "boolean", "description": "Open a site as an app, with no address bar."},
                "profile": {"type": "string", "description": "The browser profile a URL opens in."},
            }),
            vec!["target"],
        ),
        Tool::WindowAct("focus-window") => (
            "Show and focus a window.",
            window_id,
            vec!["id"],
        ),
        Tool::WindowAct(_) => ("Ask a window to close.", window_id, vec!["id"]),
        Tool::Theme => (
            "Set the theme to light or dark, or toggle it. With no change, answer the current theme.",
            json!({"change": {"type": "string", "enum": ["light", "dark", "toggle"]}}),
            vec![],
        ),
        Tool::Screenshot => (
            "Take a PNG of every monitor, or of an area of the last screenshot, at most 1280 pixels across. The pointer tools take points in its pixels. Slower and larger than browser_snapshot and app_snapshot: use it only for what they can't show. To read small text, take an area rather than changing windows or the layout.",
            json!({"area": {"type": "array", "items": coordinate, "minItems": 4, "maxItems": 4, "description": "[x, y, width, height] of the last screenshot, to zoom into."}}),
            vec![],
        ),
        Tool::Click => (
            "Click at a point of the last screenshot. In a window with a tree, browser_click or app_click by ref instead.",
            json!({
                "x": coordinate,
                "y": coordinate,
                "button": {"type": "string", "enum": ["left", "right", "middle"]},
                "count": {"type": "integer", "enum": [1, 2], "description": "2 double-clicks the left button."},
            }),
            vec!["x", "y"],
        ),
        Tool::MovePointer => (
            "Move the pointer to a point of the last screenshot.",
            json!({"x": coordinate, "y": coordinate}),
            vec!["x", "y"],
        ),
        Tool::Drag => (
            "Press the left button at one point of the last screenshot and release it at another.",
            json!({"from": point, "to": point}),
            vec!["from", "to"],
        ),
        Tool::Scroll => (
            "Scroll at a point of the last screenshot, by dx and dy of its pixels; positive is right and down.",
            json!({"x": coordinate, "y": coordinate, "dx": coordinate, "dy": coordinate}),
            vec!["x", "y", "dx", "dy"],
        ),
        Tool::Key => (
            "Press a chord of XKB keysym names, such as ctrl+l, Return or alt+Tab.",
            json!({"chord": {"type": "string"}}),
            vec!["chord"],
        ),
        Tool::TypeText => (
            "Type text on the keyboard, where the focus is. In a window with a tree, browser_type or app_set_text instead.",
            json!({"text": {"type": "string"}}),
            vec!["text"],
        ),
        Tool::Browser(browser) => browser::described(browser),
        Tool::AppSnapshot => (
            "Read a native window's accessibility tree: one element a line, with the ref the other app tools take. Needs an app that supports accessibility; works on hidden windows.",
            json!({"window": native}),
            vec!["window"],
        ),
        Tool::AppAct("click") => (
            "Click an element of a native window by its ref, running its own click or press action. Answers what it changed in the window.",
            json!({"window": native, "ref": app_element}),
            vec!["window", "ref"],
        ),
        Tool::AppAct("focus") => (
            "Give an element of a native window the keyboard focus, by its ref. Answers what it changed in the window.",
            json!({"window": native, "ref": app_element}),
            vec!["window", "ref"],
        ),
        Tool::AppAct(_) => (
            "Replace the text of an editable element of a native window, by its ref. Answers what it changed in the window.",
            json!({"window": native, "ref": app_element, "text": {"type": "string"}}),
            vec!["window", "ref", "text"],
        ),
        Tool::AskToUse => (
            "Ask the user again to let you use the desktop, after they stopped you or turned you away. Only when the user asks you to: it shows them a dialog.",
            json!({}),
            vec![],
        ),
        Tool::StopUsing => (
            "Let go of the desktop once you are done with it, so the user sees you are gone. Your next tool call asks the user again.",
            json!({}),
            vec![],
        ),
    }
}

/// `tools/call`'s result for `tool` with `arguments`, once the user lets the
/// agent in and only within what they allowed.
fn guarded(
    tool: Tool,
    arguments: &Value,
    domicile: &mut impl FnMut(&[String]) -> io::Result<Ran>,
    admit: &mut impl FnMut(&str) -> Result<Grant, String>,
    session: &mut Session,
) -> io::Result<Value> {
    // A call with no arguments may leave them out.
    let none = Map::new();
    let arguments = match arguments {
        Value::Null => &none,
        Value::Object(arguments) => arguments,
        other => return Ok(said(false, format!("arguments are an object, not {other}"))),
    };
    let name = session.name.clone();
    match tool {
        Tool::AskToUse => return Ok(asked_again(admit, session)),
        Tool::StopUsing => return Ok(let_go(session)),
        _ => {}
    }
    let grant = match session.grant.get_or_insert_with(|| admitted(admit, &name)) {
        Ok(grant) => grant,
        Err(why) => return Ok(said(false, why.clone())),
    };
    if (grant.stopped)() {
        return Ok(said(false, stopped(&name)));
    }
    // Read once per call: a change the user makes applies from the next.
    let reach = (grant.reach)();
    if let AgentReach::Windows { windows } = &reach {
        if let Err(why) = within(tool, arguments, windows, &name) {
            return Ok(said(false, why));
        }
        for window in windows {
            session
                .titles
                .entry(window.id.clone())
                .or_insert_with(|| window.title.clone());
        }
    }
    let mut answered = called(
        tool,
        arguments,
        domicile,
        &mut session.view,
        &mut session.read,
    )?;
    if answered["isError"] == json!(false) {
        if tool_is_listing_windows(tool) {
            answered = listed_windows(answered, &reach, &mut session.titles);
        }
        (grant.did)(&what_it_did(tool, arguments, &session.titles));
    }
    Ok(answered)
}

/// The grant the user gives agent `name` when asked, or why there is none.
fn admitted(
    admit: &mut impl FnMut(&str) -> Result<Grant, String>,
    name: &str,
) -> Result<Grant, String> {
    admit(name).map_err(|why| {
        format!(
            "The user did not let {name} use this desktop ({}). If they ask you to try again, \
             call ask_to_use_desktop.",
            why.trim()
        )
    })
}

fn stopped(name: &str) -> String {
    format!(
        "The user stopped {name} from the desktop. If they ask you to use it again, call \
         ask_to_use_desktop."
    )
}

/// `ask_to_use_desktop`'s result: asks the user again unless the agent is in
/// now, dropping a grant they stopped first.
fn asked_again(
    admit: &mut impl FnMut(&str) -> Result<Grant, String>,
    session: &mut Session,
) -> Value {
    let name = session.name.clone();
    if let Some(Ok(grant)) = &session.grant {
        if !(grant.stopped)() {
            return said(
                true,
                format!("The user already lets {name} use this desktop."),
            );
        }
    }
    session.grant = None;
    let grant = admitted(admit, &name);
    let answer = match &grant {
        Ok(_) => said(true, format!("The user let {name} use this desktop.")),
        Err(why) => said(false, why.clone()),
    };
    session.grant = Some(grant);
    answer
}

/// `stop_using_desktop`'s result: drops the grant, which ends the agent's
/// `domicile agent` and its place in the bar, and what it read through it.
fn let_go(session: &mut Session) -> Value {
    let name = &session.name;
    session.view = None;
    session.read.clear();
    match session.grant.take() {
        Some(Ok(grant)) if !(grant.stopped)() => {
            said(true, format!("{name} no longer uses this desktop."))
        }
        _ => said(true, format!("{name} was not using this desktop.")),
    }
}

fn tool_is_listing_windows(tool: Tool) -> bool {
    matches!(tool, Tool::Listing("list-windows"))
}

/// Whether `tool` with `arguments` acts only on `windows`, the ones the user
/// shared with agent `name`, or why not.
fn within(
    tool: Tool,
    arguments: &Map<String, Value>,
    windows: &[domicile_protocol::AgentWindow],
    name: &str,
) -> Result<(), String> {
    let window = match tool {
        Tool::Listing("list-windows") => return Ok(()),
        Tool::WindowAct("close-window") => arguments.get("id"),
        Tool::Browser(_) | Tool::AppSnapshot | Tool::AppAct(_) => arguments.get("window"),
        _ => {
            return Err(format!(
                "The user shared only some windows with {name}, and this tool reaches the \
                 whole desktop. Use list_windows, then the browser_ and app_ tools on the \
                 windows it lists."
            ))
        }
    };
    match window.and_then(Value::as_str) {
        Some(id) if windows.iter().any(|shared| shared.id == id) => Ok(()),
        Some(id) => Err(format!(
            "The user did not share window {id} with {name}. list_windows lists the ones they did."
        )),
        // The tool says what it lacks.
        None => Ok(()),
    }
}

/// `list_windows`'s answer with only the windows `reach` reaches, noting
/// each one's title in `titles`.
fn listed_windows(
    answered: Value,
    reach: &AgentReach,
    titles: &mut HashMap<String, String>,
) -> Value {
    let Some(Ok(mut windows)) = answered["content"][0]["text"]
        .as_str()
        .map(serde_json::from_str::<Vec<Value>>)
    else {
        return answered;
    };
    for window in &windows {
        if let (Some(id), Some(title)) = (window["id"].as_str(), window["title"].as_str()) {
            titles.insert(id.to_string(), title.to_string());
        }
    }
    let AgentReach::Windows { windows: shared } = reach else {
        return answered;
    };
    windows.retain(|window| {
        shared
            .iter()
            .any(|shared| window["id"] == shared.id.as_str())
    });
    let mut printed = serde_json::to_string_pretty(&windows).expect("windows serialize");
    printed.push('\n');
    said(true, printed)
}

/// What the shell lists the agent as having done with `tool`. Never what
/// it typed, which may be a password.
fn what_it_did(
    tool: Tool,
    arguments: &Map<String, Value>,
    titles: &HashMap<String, String>,
) -> String {
    let window = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(|id| match titles.get(id) {
                Some(title) if !title.is_empty() => title.clone(),
                _ => "a window".to_string(),
            })
            .unwrap_or_else(|| "a window".to_string())
    };
    match tool {
        Tool::Listing("list-windows") => "Listed the windows".to_string(),
        Tool::Listing("list-displays") => "Listed the displays".to_string(),
        Tool::Listing("list-inputs") => "Listed the keyboards and pointers".to_string(),
        Tool::Listing("status") => "Read the desktop's status".to_string(),
        Tool::Listing(_) => "Read the shell's commands".to_string(),
        Tool::SendShell => "Ran a shell command".to_string(),
        Tool::Exec => "Started a program".to_string(),
        Tool::Open => "Opened something".to_string(),
        Tool::WindowAct("focus-window") => format!("Focused {}", window("id")),
        Tool::WindowAct(_) => format!("Closed {}", window("id")),
        Tool::Theme => "Changed the theme".to_string(),
        Tool::Screenshot => "Took a screenshot".to_string(),
        Tool::Click => "Clicked".to_string(),
        Tool::MovePointer => "Moved the pointer".to_string(),
        Tool::Drag => "Dragged".to_string(),
        Tool::Scroll => "Scrolled".to_string(),
        Tool::Key => "Pressed a key".to_string(),
        Tool::TypeText => "Typed".to_string(),
        Tool::Browser(Browser::Snapshot) | Tool::AppSnapshot => {
            format!("Read {}", window("window"))
        }
        Tool::Browser(Browser::Click) | Tool::AppAct("click") => {
            format!("Clicked in {}", window("window"))
        }
        Tool::Browser(Browser::Type) | Tool::AppAct("set-text") => {
            format!("Typed in {}", window("window"))
        }
        Tool::Browser(Browser::Key) => format!("Pressed a key in {}", window("window")),
        Tool::Browser(Browser::Navigate) => format!("Loaded a page in {}", window("window")),
        Tool::Browser(Browser::Screenshot) => format!("Took a screenshot of {}", window("window")),
        Tool::AppAct(_) => format!("Moved the focus in {}", window("window")),
        Tool::AskToUse | Tool::StopUsing => {
            unreachable!("guarded answers ask_to_use_desktop and stop_using_desktop itself")
        }
    }
}

/// `tools/call`'s result for `tool` with `arguments`.
fn called(
    tool: Tool,
    arguments: &Map<String, Value>,
    domicile: &mut impl FnMut(&[String]) -> io::Result<Ran>,
    view: &mut Option<View>,
    read: &mut HashMap<String, String>,
) -> io::Result<Value> {
    match tool {
        Tool::Screenshot => return screenshot(arguments, domicile, view),
        Tool::Browser(browser) => return browser::called(browser, arguments, domicile, read),
        _ => {}
    }
    let runs = match commands(tool, arguments, *view) {
        Ok(runs) => runs,
        Err(why) => return Ok(said(false, why)),
    };
    // Each run in turn, up to the first that fails.
    let mut printed = String::new();
    for args in runs {
        let ran = domicile(&args)?;
        if !ran.success {
            return Ok(said(false, ran.stderr));
        }
        printed.push_str(&ran.stdout);
    }
    let window = string(arguments, "window").ok().flatten();
    match (tool, window) {
        (Tool::AppSnapshot, Some(window)) => {
            read.insert(window, printed.clone());
        }
        (Tool::AppAct(_), Some(window)) => {
            std::thread::sleep(changes::SETTLE);
            let ran = domicile(&["accessibility".to_string(), window.clone()])?;
            if !ran.success {
                printed.push_str(&format!("It could not be read again: {}", ran.stderr));
                return Ok(said(true, printed));
            }
            printed.push_str(&changes::changed(
                read.get(&window).map(String::as_str),
                &ran.stdout,
            ));
            read.insert(window, ran.stdout);
        }
        _ => {}
    }
    Ok(said(true, printed))
}

/// The runs of `domicile` that carry out `tool`, or why `arguments` don't
/// make any.
fn commands(
    tool: Tool,
    arguments: &Map<String, Value>,
    view: Option<View>,
) -> Result<Vec<Vec<String>>, String> {
    let words = |words: &[&str]| words.iter().map(|word| word.to_string()).collect();
    match tool {
        Tool::Listing(verb) => Ok(vec![words(&[verb, "--json"])]),
        Tool::SendShell => {
            let said = arguments
                .get("words")
                .and_then(Value::as_array)
                .ok_or("send_shell takes words, an array of strings")?;
            let said = said
                .iter()
                .map(|word| word.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .ok_or("send_shell's words are strings")?;
            Ok(vec![[words(&["send-shell"]), said].concat()])
        }
        Tool::Exec => {
            let argv = arguments
                .get("argv")
                .and_then(Value::as_array)
                .ok_or("exec takes argv, an array of strings")?;
            let argv = argv
                .iter()
                .map(|word| word.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .ok_or("exec's argv are strings")?;
            match argv.is_empty() {
                true => Err("exec's argv names no program".to_string()),
                false => Ok(vec![[words(&["exec"]), argv].concat()]),
            }
        }
        Tool::Open => {
            let target = string(arguments, "target")?.ok_or("open takes a target")?;
            let app = match arguments.get("app") {
                None => false,
                Some(app) => app.as_bool().ok_or("open's app is true or false")?,
            };
            let profile = string(arguments, "profile")?;
            Ok(vec![[
                words(&["open"]),
                app.then(|| "--app".to_string()).into_iter().collect(),
                profile
                    .map(|profile| vec!["--profile".to_string(), profile])
                    .unwrap_or_default(),
                vec![target],
            ]
            .concat()])
        }
        Tool::WindowAct(verb) => {
            let id = string(arguments, "id")?.ok_or("this tool takes a window id")?;
            Ok(vec![vec![verb.to_string(), id]])
        }
        Tool::Theme => Ok(vec![[
            words(&["theme"]),
            string(arguments, "change")?.into_iter().collect(),
        ]
        .concat()]),
        Tool::Screenshot | Tool::Browser(_) => {
            unreachable!("screenshot and the browser tools are not single runs")
        }
        Tool::Click => {
            let at = on_the_desk(view, number(arguments, "x")?, number(arguments, "y")?)?;
            let action = match (string(arguments, "button")?.as_deref(), arguments.get("count")) {
                (None | Some("left"), None) => "click",
                (None | Some("left"), Some(count)) if count == 1 => "click",
                (None | Some("left"), Some(count)) if count == 2 => "double-click",
                (Some("right"), None) => "right-click",
                (Some("middle"), None) => "middle-click",
                _ => return Err("click takes a left, right or middle button, and a count of 1 or 2 for the left one".to_string()),
            };
            Ok(vec![words(&["pointer", &at, action])])
        }
        Tool::MovePointer => {
            let at = on_the_desk(view, number(arguments, "x")?, number(arguments, "y")?)?;
            Ok(vec![words(&["pointer", &at])])
        }
        Tool::Drag => {
            let (from, to) = (pair(arguments, "from")?, pair(arguments, "to")?);
            Ok(vec![words(&[
                "drag",
                &on_the_desk(view, from.0, from.1)?,
                &on_the_desk(view, to.0, to.1)?,
            ])])
        }
        Tool::Scroll => {
            let at = on_the_desk(view, number(arguments, "x")?, number(arguments, "y")?)?;
            let by = across_the_desk(view, number(arguments, "dx")?, number(arguments, "dy")?)?;
            Ok(vec![words(&["pointer", &at]), words(&["scroll", &by])])
        }
        Tool::Key => {
            let chord = string(arguments, "chord")?.ok_or("key takes a chord")?;
            Ok(vec![vec!["key".to_string(), chord]])
        }
        Tool::TypeText => {
            let text = string(arguments, "text")?.ok_or("type_text takes text")?;
            Ok(vec![vec!["type".to_string(), text]])
        }
        Tool::AppSnapshot => {
            let window = string(arguments, "window")?.ok_or("app_snapshot takes a window id")?;
            Ok(vec![vec!["accessibility".to_string(), window]])
        }
        Tool::AppAct(act) => {
            let window = string(arguments, "window")?.ok_or("this tool takes a window id")?;
            let element = string(arguments, "ref")?.ok_or("this tool takes an element's ref")?;
            let text = match act {
                "set-text" => vec![string(arguments, "text")?.ok_or("app_set_text takes text")?],
                _ => Vec::new(),
            };
            Ok(vec![[
                words(&["accessibility-act"]),
                vec![window, element, act.to_string()],
                text,
            ]
            .concat()])
        }
        Tool::AskToUse | Tool::StopUsing => {
            unreachable!("guarded answers ask_to_use_desktop and stop_using_desktop itself")
        }
    }
}

/// `x`, `y` in the last screenshot's pixels as `x,y` in the desk's, as
/// `domicile pointer` and `scroll` take them.
fn on_the_desk(view: Option<View>, x: f64, y: f64) -> Result<String, String> {
    let view = taken(view)?;
    Ok(format!(
        "{},{}",
        view.left + x * view.across,
        view.top + y * view.down
    ))
}

/// A distance `dx`, `dy` in the last screenshot's pixels as one in the
/// desk's, as `domicile scroll` takes it.
fn across_the_desk(view: Option<View>, dx: f64, dy: f64) -> Result<String, String> {
    let view = taken(view)?;
    Ok(format!("{},{}", dx * view.across, dy * view.down))
}

/// The last screenshot's view, or why there is none.
fn taken(view: Option<View>) -> Result<View, String> {
    view.ok_or_else(|| "take a screenshot first: points are in its pixels".to_string())
}

/// Argument `area`, `[x, y, width, height]` of the last screenshot, as the
/// area of the desk `domicile screenshot --area` takes, rounded out to whole
/// pixels.
fn desk_area(view: Option<View>, arguments: &Map<String, Value>) -> Result<Option<String>, String> {
    let Some(area) = arguments.get("area") else {
        return Ok(None);
    };
    let not_an_area = || format!("area is [x, y, width, height], not {area}");
    let numbers: Vec<f64> = area
        .as_array()
        .ok_or_else(not_an_area)?
        .iter()
        .map(Value::as_f64)
        .collect::<Option<_>>()
        .ok_or_else(not_an_area)?;
    let [x, y, width, height] = numbers.as_slice() else {
        return Err(not_an_area());
    };
    let view = taken(view)?;
    let left = (view.left + x * view.across).floor();
    let top = (view.top + y * view.down).floor();
    let right = (view.left + (x + width) * view.across).ceil();
    let bottom = (view.top + (y + height) * view.down).ceil();
    Ok(Some(format!(
        "{left},{top},{}x{}",
        right - left,
        bottom - top
    )))
}

/// Argument `name`, a number.
fn number(arguments: &Map<String, Value>, name: &str) -> Result<f64, String> {
    arguments
        .get(name)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{name} is a number"))
}

/// Argument `name`, a point as `[x, y]`.
fn pair(arguments: &Map<String, Value>, name: &str) -> Result<(f64, f64), String> {
    match arguments
        .get(name)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
    {
        Some([x, y]) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => Ok((x, y)),
            _ => Err(format!("{name} is two numbers, [x, y]")),
        },
        _ => Err(format!("{name} is two numbers, [x, y]")),
    }
}

/// Argument `name`, if given, or why it is not a string.
fn string(arguments: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match arguments.get(name) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(other) => Err(format!("{name} is a string, and was given {other}")),
    }
}

/// Runs `domicile screenshot --fit` into a temporary file, of argument
/// `area` of the last screenshot if given, answers the PNG, and keeps how its
/// pixels map to the desk's in `view`.
fn screenshot(
    arguments: &Map<String, Value>,
    domicile: &mut impl FnMut(&[String]) -> io::Result<Ran>,
    view: &mut Option<View>,
) -> io::Result<Value> {
    let area = match desk_area(*view, arguments) {
        Ok(area) => area,
        Err(why) => return Ok(said(false, why)),
    };
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("screenshot.png");
    let ran = domicile(
        &[
            "screenshot".to_string(),
            "--fit".to_string(),
            FIT.to_string(),
        ]
        .into_iter()
        .chain(
            area.into_iter()
                .flat_map(|area| ["--area".to_string(), area]),
        )
        .chain([file.to_string_lossy().into_owned()])
        .collect::<Vec<_>>(),
    )?;
    if !ran.success {
        return Ok(said(false, ran.stderr));
    }
    let shot: DeskShot = serde_json::from_str(&ran.stdout).map_err(|why| {
        io::Error::other(format!(
            "domicile screenshot --fit printed {:?}, which is not what a shot shows: {why}",
            ran.stdout
        ))
    })?;
    *view = Some(View {
        left: f64::from(shot.place.position.0),
        top: f64::from(shot.place.position.1),
        across: f64::from(shot.place.size.0) / f64::from(shot.width),
        down: f64::from(shot.place.size.1) / f64::from(shot.height),
    });
    let png = std::fs::read(&file)?;
    Ok(json!({
        "content": [
            {"type": "image", "data": base64(&png), "mimeType": "image/png"},
            {"type": "text", "text": format!("{}x{} pixels; the pointer tools take points in them.", shot.width, shot.height)},
        ],
        "isError": false,
    }))
}

/// A tool result of text.
fn said(success: bool, text: String) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": !success})
}

/// Standard base64, with padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes
        .chunks(3)
        .flat_map(|chunk| {
            let word = chunk.iter().enumerate().fold(0u32, |word, (at, byte)| {
                word | u32::from(*byte) << (16 - 8 * at)
            });
            (0..4).map(move |at| {
                if at <= chunk.len() {
                    char::from(ALPHABET[(word >> (18 - 6 * at) & 63) as usize])
                } else {
                    '='
                }
            })
        })
        .collect()
}

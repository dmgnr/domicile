//! Tests for `domicile mcp`: the Model Context Protocol server over stdio.

use std::cell::{Cell, RefCell};
use std::io;
use std::rc::Rc;

use domicile_launch::mcp::{serve, Grant, Ran};
use domicile_protocol::{AgentReach, AgentWindow, WindowKind};
use serde_json::{json, Value};

/// Serves `requests`, one JSON-RPC message per line, with `domicile` standing
/// in for the `domicile` binary, and returns each reply. The user lets the
/// agent reach the whole desk.
fn served(requests: &[Value], domicile: impl FnMut(&[String]) -> io::Result<Ran>) -> Vec<Value> {
    served_letting(requests, domicile, |_| Ok(reaching(AgentReach::Desk).0))
}

/// [`served`], letting the agent in as `admit` says.
fn served_letting(
    requests: &[Value],
    domicile: impl FnMut(&[String]) -> io::Result<Ran>,
    admit: impl FnMut(&str) -> Result<Grant, String>,
) -> Vec<Value> {
    let input: String = requests
        .iter()
        .map(|request| format!("{request}\n"))
        .collect();
    let mut output = Vec::new();
    serve(input.as_bytes(), &mut output, domicile, admit).unwrap();
    String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn printed(stdout: &str) -> io::Result<Ran> {
    Ok(Ran {
        success: true,
        stdout: stdout.to_string(),
        stderr: String::new(),
    })
}

fn never_run(args: &[String]) -> io::Result<Ran> {
    panic!("ran domicile {args:?}")
}

fn call(name: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments}
    })
}

/// The arguments one tool call first runs `domicile` with.
fn ran_for(name: &str, arguments: Value) -> Vec<String> {
    let mut ran = Vec::new();
    served(&[call(name, arguments)], |args| {
        if ran.is_empty() {
            ran = args.to_vec();
        }
        printed("")
    });
    ran
}

#[test]
fn initialize_names_the_server_and_offers_tools() {
    let replies = served(
        &[json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}
        })],
        never_run,
    );
    assert_eq!(replies[0]["id"], 0);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "domicile");
    assert!(replies[0]["result"]["capabilities"]["tools"].is_object());
    // Agents read windows as text first, which is quicker and smaller than
    // looking at the desk.
    let instructions = replies[0]["result"]["instructions"].as_str().unwrap();
    for tool in [
        "list_windows",
        "browser_snapshot",
        "app_snapshot",
        "screenshot",
    ] {
        assert!(instructions.contains(tool), "{instructions}");
    }
}

#[test]
fn initialize_offers_its_own_version_for_one_it_does_not_speak() {
    let replies = served(
        &[json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {"protocolVersion": "1999-01-01", "capabilities": {}}
        })],
        never_run,
    );
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
}

#[test]
fn notifications_get_no_reply() {
    let replies = served(
        &[
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 7, "method": "ping"}),
        ],
        never_run,
    );
    assert_eq!(
        replies,
        vec![json!({"jsonrpc": "2.0", "id": 7, "result": {}})]
    );
}

#[test]
fn tools_list_describes_each_tool() {
    let replies = served(
        &[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})],
        never_run,
    );
    let tools = replies[0]["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "list_windows",
            "list_displays",
            "list_inputs",
            "status",
            "list_shell_commands",
            "list_bindings",
            "send_shell",
            "exec",
            "open",
            "focus_window",
            "close_window",
            "theme",
            "screenshot",
            "click",
            "move_pointer",
            "drag",
            "scroll",
            "key",
            "type_text",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_key",
            "browser_navigate",
            "browser_screenshot",
            "app_snapshot",
            "app_click",
            "app_focus",
            "app_set_text",
            "ask_to_use_desktop",
            "stop_using_desktop",
        ]
    );
    for tool in tools {
        assert!(tool["description"].is_string(), "{tool}");
        assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
    }
}

#[test]
fn a_listing_runs_its_verb_for_json_and_answers_what_it_printed() {
    let mut ran = Vec::new();
    let replies = served(&[call("list_windows", json!({}))], |args| {
        ran = args.to_vec();
        printed("[{\"title\":\"notes.org\"}]\n")
    });
    assert_eq!(ran, ["list-windows", "--json"]);
    assert_eq!(
        replies[0]["result"],
        json!({
            "content": [{"type": "text", "text": "[{\"title\":\"notes.org\"}]\n"}],
            "isError": false
        })
    );
}

#[test]
fn a_failed_command_is_a_tool_error_saying_why() {
    let replies = served(&[call("focus_window", json!({"id": "abc"}))], |_| {
        Ok(Ran {
            success: false,
            stdout: String::new(),
            stderr: "domicile: no window abc\n".to_string(),
        })
    });
    assert_eq!(replies[0]["result"]["isError"], true);
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "domicile: no window abc\n"
    );
}

#[test]
fn send_shell_passes_its_words() {
    assert_eq!(
        ran_for("send_shell", json!({"words": ["focus", "left"]})),
        ["send-shell", "focus", "left"]
    );
}

#[test]
fn exec_runs_its_argv() {
    assert_eq!(
        ran_for("exec", json!({"argv": ["kitty", "--hold", "btop"]})),
        ["exec", "kitty", "--hold", "btop"]
    );
}

#[test]
fn open_takes_an_app_flag_and_a_profile() {
    assert_eq!(
        ran_for("open", json!({"target": "https://example.com"})),
        ["open", "https://example.com"]
    );
    assert_eq!(
        ran_for(
            "open",
            json!({"target": "https://example.com", "app": true, "profile": "work"})
        ),
        ["open", "--app", "--profile", "work", "https://example.com"]
    );
}

#[test]
fn window_actions_take_the_window_id() {
    assert_eq!(
        ran_for("close_window", json!({"id": "abc"})),
        ["close-window", "abc"]
    );
}

#[test]
fn theme_with_no_change_prints_it() {
    assert_eq!(ran_for("theme", json!({})), ["theme"]);
    assert_eq!(
        ran_for("theme", json!({"change": "dark"})),
        ["theme", "dark"]
    );
}

/// What `domicile screenshot --fit` prints for a 3840x1080 desk fit into
/// 1280 pixels: a third of its size.
const THIRD: &str =
    "{\"place\":{\"position\":[0,0],\"size\":[3840,1080]},\"width\":1280,\"height\":360}\n";

/// What `domicile screenshot --fit` prints for the desk's area 300,150
/// 600x300, which fits.
const ZOOMED: &str =
    "{\"place\":{\"position\":[300,150],\"size\":[600,300]},\"width\":600,\"height\":300}\n";

/// Stands in for `domicile`: writes a PNG for `screenshot` and records every
/// other run in `ran`, and each `--area` asked for.
fn desk<'a>(ran: &'a mut Vec<Vec<String>>) -> impl FnMut(&[String]) -> io::Result<Ran> + 'a {
    move |args| {
        if args[0] == "screenshot" {
            assert_eq!(args[1..3], ["--fit", "1280"]);
            std::fs::write(args.last().unwrap(), b"\x89PNG").unwrap();
            match &args[3..] {
                [_] => printed(THIRD),
                [flag, area, _] if flag == "--area" => {
                    ran.push(vec![flag.clone(), area.clone()]);
                    printed(ZOOMED)
                }
                _ => panic!("ran domicile {args:?}"),
            }
        } else {
            ran.push(args.to_vec());
            printed("")
        }
    }
}

#[test]
fn screenshot_answers_the_desk_shrunk_to_fit_and_what_it_shows() {
    let mut ran = Vec::new();
    let replies = served(&[call("screenshot", json!({}))], desk(&mut ran));
    assert_eq!(
        replies[0]["result"]["content"][0],
        json!({"type": "image", "data": "iVBORw==", "mimeType": "image/png"})
    );
    assert!(replies[0]["result"]["content"][1]["text"]
        .as_str()
        .unwrap()
        .contains("1280x360"));
}

#[test]
fn pointing_before_a_screenshot_is_a_tool_error_asking_for_one() {
    let replies = served(&[call("click", json!({"x": 1, "y": 1}))], never_run);
    assert_eq!(replies[0]["result"]["isError"], true);
    assert!(replies[0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("screenshot"));
}

#[test]
fn pointer_tools_take_the_last_screenshots_pixels_to_the_desks() {
    let mut ran = Vec::new();
    served(
        &[
            call("screenshot", json!({})),
            call("click", json!({"x": 100, "y": 50})),
            call("click", json!({"x": 100, "y": 50, "button": "right"})),
            call("click", json!({"x": 100, "y": 50, "count": 2})),
            call("move_pointer", json!({"x": 1, "y": 2})),
            call("drag", json!({"from": [10, 10], "to": [20, 20.5]})),
            call("scroll", json!({"x": 1, "y": 1, "dx": 0, "dy": 40})),
        ],
        desk(&mut ran),
    );
    let ran: Vec<Vec<&str>> = ran
        .iter()
        .map(|args| args.iter().map(String::as_str).collect())
        .collect();
    assert_eq!(
        ran,
        [
            vec!["pointer", "300,150", "click"],
            vec!["pointer", "300,150", "right-click"],
            vec!["pointer", "300,150", "double-click"],
            vec!["pointer", "3,6"],
            vec!["drag", "30,30", "60,61.5"],
            vec!["pointer", "3,3"],
            vec!["scroll", "0,120"],
        ]
    );
}

#[test]
fn a_screenshot_of_an_area_of_the_last_zooms_in_and_points_go_there() {
    let mut ran = Vec::new();
    let replies = served(
        &[
            call("screenshot", json!({})),
            call("screenshot", json!({"area": [100, 50, 200, 100]})),
            call("click", json!({"x": 10, "y": 10})),
        ],
        desk(&mut ran),
    );
    assert!(replies[1]["result"]["content"][1]["text"]
        .as_str()
        .unwrap()
        .contains("600x300"));
    assert_eq!(
        ran,
        [
            vec!["--area".to_string(), "300,150,600x300".to_string()],
            vec![
                "pointer".to_string(),
                "310,160".to_string(),
                "click".to_string()
            ],
        ]
    );
    let replies = served(
        &[call("screenshot", json!({"area": [0, 0, 10, 10]}))],
        never_run,
    );
    assert_eq!(replies[0]["result"]["isError"], true);
}

#[test]
fn keys_and_text_go_to_key_and_type() {
    assert_eq!(
        ran_for("key", json!({"chord": "ctrl+l"})),
        ["key", "ctrl+l"]
    );
    assert_eq!(
        ran_for("type_text", json!({"text": "Hi there"})),
        ["type", "Hi there"]
    );
}

#[test]
fn a_missing_argument_is_a_tool_error_naming_it() {
    let replies = served(&[call("focus_window", json!({}))], never_run);
    assert_eq!(replies[0]["result"]["isError"], true);
    assert!(replies[0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("id"));
}

#[test]
fn an_unknown_tool_is_an_invalid_params_error() {
    let replies = served(&[call("power_off", json!({}))], never_run);
    assert_eq!(replies[0]["error"]["code"], -32602);
}

#[test]
fn an_unknown_method_is_method_not_found() {
    let replies = served(
        &[json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list"})],
        never_run,
    );
    assert_eq!(replies[0]["id"], 3);
    assert_eq!(replies[0]["error"]["code"], -32601);
}

#[test]
fn a_line_that_is_not_json_is_a_parse_error() {
    let mut output = Vec::new();
    serve("{not json\n".as_bytes(), &mut output, never_run, |_| {
        panic!("nothing was called")
    })
    .unwrap();
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["id"], Value::Null);
    assert_eq!(reply["error"]["code"], -32700);
}

#[test]
fn arguments_that_are_not_an_object_are_a_tool_error() {
    let replies = served(&[call("list_windows", json!("all"))], never_run);
    assert_eq!(replies[0]["result"]["isError"], true);
}

/// Stands in for `domicile devtools` on browser window `w1`: answers each
/// method from `answers` and records every run in `ran`.
fn page<'a>(
    answers: &'a [(&'a str, Value)],
    ran: &'a mut Vec<(String, Value)>,
) -> impl FnMut(&[String]) -> io::Result<Ran> + 'a {
    move |args| {
        if args == ["list-windows", "--json"] {
            return printed("[{\"id\": \"w1\", \"views\": []}]\n");
        }
        assert_eq!(args[..2], ["devtools", "w1"]);
        let params: Value = serde_json::from_str(&args[3]).unwrap();
        ran.push((args[2].clone(), params));
        let answer = answers
            .iter()
            .find(|(method, _)| *method == args[2])
            .map_or(json!({}), |(_, answer)| answer.clone());
        printed(&format!("{answer}\n"))
    }
}

#[test]
fn a_browser_snapshot_is_the_pages_accessibility_tree_with_refs() {
    let tree = json!({"nodes": [
        {"nodeId": "1", "ignored": false, "role": {"value": "RootWebArea"}, "name": {"value": "Inbox"}, "childIds": ["2", "3"], "backendDOMNodeId": 1},
        {"nodeId": "2", "ignored": true, "role": {"value": "none"}, "childIds": ["4"], "backendDOMNodeId": 5},
        {"nodeId": "4", "ignored": false, "role": {"value": "button"}, "name": {"value": "Compose"}, "childIds": ["6"], "backendDOMNodeId": 12},
        {"nodeId": "6", "ignored": false, "role": {"value": "StaticText"}, "name": {"value": "Compose"}, "childIds": [], "backendDOMNodeId": 13},
        {"nodeId": "3", "ignored": false, "role": {"value": "generic"}, "childIds": ["7"], "backendDOMNodeId": 20},
        {"nodeId": "7", "ignored": false, "role": {"value": "textbox"}, "name": {"value": "Search"}, "value": {"value": "from:ana"},
         "properties": [{"name": "focused", "value": {"value": true}}], "childIds": [], "backendDOMNodeId": 21}
    ]});
    let mut ran = Vec::new();
    let replies = served(
        &[call("browser_snapshot", json!({"window": "w1"}))],
        page(&[("Accessibility.getFullAXTree", tree)], &mut ran),
    );
    assert_eq!(
        ran,
        [("Accessibility.getFullAXTree".to_string(), json!({}))]
    );
    assert_eq!(replies[0]["result"]["isError"], false);
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "- RootWebArea \"Inbox\" [ref=1]\n  \
         - button \"Compose\" [ref=12]\n  \
         - textbox \"Search\" [ref=21] value=\"from:ana\" focused\n"
    );
}

#[test]
fn a_browser_click_scrolls_the_element_into_view_and_clicks_its_middle() {
    let mut ran = Vec::new();
    let replies = served(
        &[call("browser_click", json!({"window": "w1", "ref": 12}))],
        page(
            &[(
                "DOM.getContentQuads",
                json!({"quads": [[10, 20, 110, 20, 110, 40, 10, 40]]}),
            )],
            &mut ran,
        ),
    );
    assert_eq!(replies[0]["result"]["isError"], false);
    let mouse = |kind: &str| {
        (
            "Input.dispatchMouseEvent".to_string(),
            json!({"type": kind, "x": 60.0, "y": 30.0, "button": "left", "clickCount": 1}),
        )
    };
    assert_eq!(
        ran,
        [
            (
                "DOM.scrollIntoViewIfNeeded".to_string(),
                json!({"backendNodeId": 12})
            ),
            (
                "DOM.getContentQuads".to_string(),
                json!({"backendNodeId": 12})
            ),
            mouse("mouseMoved"),
            mouse("mousePressed"),
            mouse("mouseReleased"),
            // Read again, to answer what it changed.
            ("Accessibility.getFullAXTree".to_string(), json!({})),
        ]
    );
}

#[test]
fn a_browser_click_on_an_element_with_no_box_says_so() {
    let mut ran = Vec::new();
    let replies = served(
        &[call("browser_click", json!({"window": "w1", "ref": 12}))],
        page(&[("DOM.getContentQuads", json!({"quads": []}))], &mut ran),
    );
    assert_eq!(replies[0]["result"]["isError"], true);
    assert!(replies[0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("12"));
}

#[test]
fn browser_type_focuses_the_element_then_inserts_the_text() {
    let mut ran = Vec::new();
    served(
        &[
            call(
                "browser_type",
                json!({"window": "w1", "ref": 21, "text": "hi"}),
            ),
            call("browser_type", json!({"window": "w1", "text": "there"})),
        ],
        page(&[], &mut ran),
    );
    assert_eq!(
        ran,
        [
            ("DOM.focus".to_string(), json!({"backendNodeId": 21})),
            ("Input.insertText".to_string(), json!({"text": "hi"})),
            ("Accessibility.getFullAXTree".to_string(), json!({})),
            ("Input.insertText".to_string(), json!({"text": "there"})),
            ("Accessibility.getFullAXTree".to_string(), json!({})),
        ]
    );
}

#[test]
fn browser_key_presses_and_releases_a_named_key() {
    let mut ran = Vec::new();
    served(
        &[call("browser_key", json!({"window": "w1", "key": "Enter"}))],
        page(&[], &mut ran),
    );
    assert_eq!(
        ran,
        [
            (
                "Input.dispatchKeyEvent".to_string(),
                json!({"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r"})
            ),
            (
                "Input.dispatchKeyEvent".to_string(),
                json!({"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
            ),
            ("Accessibility.getFullAXTree".to_string(), json!({})),
        ]
    );
    let replies = served(
        &[call(
            "browser_key",
            json!({"window": "w1", "key": "Hyperdrive"}),
        )],
        never_run,
    );
    assert_eq!(replies[0]["result"]["isError"], true);
}

#[test]
fn browser_navigate_goes_to_the_address() {
    let mut ran = Vec::new();
    served(
        &[call(
            "browser_navigate",
            json!({"window": "w1", "url": "https://example.com/"}),
        )],
        page(&[], &mut ran),
    );
    assert_eq!(
        ran,
        [
            (
                "Page.navigate".to_string(),
                json!({"url": "https://example.com/"})
            ),
            ("Accessibility.getFullAXTree".to_string(), json!({})),
        ]
    );
}

#[test]
fn a_browser_screenshot_is_a_small_webp_of_the_page() {
    let mut ran = Vec::new();
    let replies = served(
        &[call("browser_screenshot", json!({"window": "w1"}))],
        page(
            &[("Page.captureScreenshot", json!({"data": "UklGRg=="}))],
            &mut ran,
        ),
    );
    assert_eq!(
        ran,
        [(
            "Page.captureScreenshot".to_string(),
            json!({"format": "webp", "quality": 70})
        )]
    );
    assert_eq!(
        replies[0]["result"]["content"][0],
        json!({"type": "image", "data": "UklGRg==", "mimeType": "image/webp"})
    );
}

/// Stands in for `domicile` on Claude's window `w1`, whose page is empty and
/// whose chat is view `9` at 200,40: answers each method from `answers` and
/// records every run in `ran` with the view it went to.
fn electron_window<'a>(
    answers: &'a [(&'a str, Value)],
    ran: &'a mut Vec<(Option<String>, String, Value)>,
) -> impl FnMut(&[String]) -> io::Result<Ran> + 'a {
    move |args| {
        if args == ["list-windows", "--json"] {
            return printed(
                "[{\"id\": \"w1\", \"views\": [{\"id\": \"9\", \"position\": [200, 40], \"size\": [600, 560]}]}]\n",
            );
        }
        let (view, args) = match args {
            [devtools, flag, view, rest @ ..] if devtools == "devtools" && flag == "--view" => {
                (Some(view.clone()), rest)
            }
            [devtools, rest @ ..] if devtools == "devtools" => (None, rest),
            _ => panic!("ran domicile {args:?}"),
        };
        assert_eq!(args[0], "w1");
        let params: Value = serde_json::from_str(&args[2]).unwrap();
        ran.push((view.clone(), args[1].clone(), params));
        let answer = answers
            .iter()
            .find(|(method, _)| *method == args[1] && view.is_some())
            .map_or(json!({"nodes": []}), |(_, answer)| answer.clone());
        printed(&format!("{answer}\n"))
    }
}

#[test]
fn a_browser_snapshot_reads_each_view_the_window_holds_with_its_refs() {
    let chat = json!({"nodes": [
        {"nodeId": "1", "ignored": false, "role": {"value": "RootWebArea"}, "name": {"value": "Claude"}, "childIds": ["2"], "backendDOMNodeId": 1},
        {"nodeId": "2", "ignored": false, "role": {"value": "checkbox"}, "name": {"value": "Claude Code can use your desktop"},
         "properties": [{"name": "checked", "value": {"value": "true"}}], "childIds": [], "backendDOMNodeId": 12}
    ]});
    let mut ran = Vec::new();
    let replies = served(
        &[call("browser_snapshot", json!({"window": "w1"}))],
        electron_window(&[("Accessibility.getFullAXTree", chat)], &mut ran),
    );
    assert_eq!(
        ran,
        [
            (None, "Accessibility.getFullAXTree".to_string(), json!({})),
            (
                Some("9".to_string()),
                "Accessibility.getFullAXTree".to_string(),
                json!({})
            ),
        ]
    );
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "- view 9, at 200,40, 600x560\n  \
         - RootWebArea \"Claude\" [ref=9:1]\n    \
         - checkbox \"Claude Code can use your desktop\" [ref=9:12] checked=\"true\"\n"
    );
}

#[test]
fn browser_tools_act_in_the_view_a_ref_names_or_the_view_given() {
    let mut ran = Vec::new();
    let replies = served(
        &[
            call("browser_click", json!({"window": "w1", "ref": "9:12"})),
            call(
                "browser_key",
                json!({"window": "w1", "view": "9", "key": "Tab"}),
            ),
            call("browser_screenshot", json!({"window": "w1", "view": "9"})),
        ],
        electron_window(
            &[
                (
                    "DOM.getContentQuads",
                    json!({"quads": [[10, 20, 110, 20, 110, 40, 10, 40]]}),
                ),
                ("Page.captureScreenshot", json!({"data": "UklGRg=="})),
            ],
            &mut ran,
        ),
    );
    assert!(
        replies
            .iter()
            .all(|reply| reply["result"]["isError"] == false),
        "{replies:?}"
    );
    // Reading the window again, after each act, reads all of it.
    assert!(
        ran.iter()
            .filter(|(_, method, _)| method != "Accessibility.getFullAXTree")
            .all(|(view, _, _)| view.as_deref() == Some("9")),
        "{ran:?}"
    );
    assert_eq!(ran[1].2, json!({"backendNodeId": 12}));
}

#[test]
fn a_ref_from_one_view_is_refused_in_another() {
    let replies = served(
        &[call(
            "browser_type",
            json!({"window": "w1", "view": "7", "ref": "9:12", "text": "hi"}),
        )],
        never_run,
    );
    assert_eq!(replies[0]["result"]["isError"], true);
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "ref 9:12 is in view 9, not view 7"
    );
}

#[test]
fn a_browser_tool_passes_on_why_devtools_refused() {
    let replies = served(&[call("browser_snapshot", json!({"window": "w9"}))], |_| {
        Ok(Ran {
            success: false,
            stdout: String::new(),
            stderr: "domicile: window w9 is private, and agents do not drive private windows\n"
                .to_string(),
        })
    });
    assert_eq!(replies[0]["result"]["isError"], true);
    assert!(replies[0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("private"));
}

#[test]
fn app_tools_read_and_act_on_a_native_windows_accessibility_tree() {
    assert_eq!(
        ran_for("app_snapshot", json!({"window": "kD3m"})),
        ["accessibility", "kD3m"]
    );
    assert_eq!(
        ran_for("app_click", json!({"window": "kD3m", "ref": ":1.7/w/1"})),
        ["accessibility-act", "kD3m", ":1.7/w/1", "click"]
    );
    assert_eq!(
        ran_for("app_focus", json!({"window": "kD3m", "ref": ":1.7/w/1"})),
        ["accessibility-act", "kD3m", ":1.7/w/1", "focus"]
    );
    assert_eq!(
        ran_for(
            "app_set_text",
            json!({"window": "kD3m", "ref": ":1.7/w/1", "text": "hi"})
        ),
        ["accessibility-act", "kD3m", ":1.7/w/1", "set-text", "hi"]
    );
    let replies = served(&[call("app_click", json!({"window": "kD3m"}))], never_run);
    assert_eq!(replies[0]["result"]["isError"], true);
}

/// A grant of `reach`, and what it was told the agent did. Never stopped.
fn reaching(reach: AgentReach) -> (Grant, Rc<RefCell<Vec<String>>>) {
    let did = Rc::new(RefCell::new(Vec::new()));
    let told = Rc::clone(&did);
    (
        Grant {
            reach: Box::new(move || reach.clone()),
            stopped: Box::new(|| false),
            did: Box::new(move |said| told.borrow_mut().push(said.to_string())),
        },
        did,
    )
}

fn shared(id: &str, kind: WindowKind, title: &str) -> AgentWindow {
    AgentWindow {
        id: id.into(),
        kind,
        title: title.into(),
        app: None,
    }
}

/// Only the browser window `w1` ("Pull requests") and the native window
/// `n1` ("Notes").
fn two_windows() -> AgentReach {
    AgentReach::Windows {
        windows: vec![
            shared("w1", WindowKind::Browser, "Pull requests"),
            shared("n1", WindowKind::Native, "Notes"),
        ],
    }
}

#[test]
fn the_first_tool_call_asks_the_user_once_in_the_clients_name() {
    let asked = Rc::new(RefCell::new(Vec::new()));
    let asking = Rc::clone(&asked);
    served_letting(
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-code", "title": "Claude Code"}}
            }),
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            call("status", json!({})),
            call("status", json!({})),
        ],
        |_| printed("{}"),
        move |name| {
            asking.borrow_mut().push(name.to_string());
            Ok(reaching(AgentReach::Desk).0)
        },
    );
    assert_eq!(*asked.borrow(), ["Claude Code"]);
}

#[test]
fn an_agent_the_user_did_not_let_in_is_refused_every_call_without_asking_again() {
    let asked = Cell::new(0);
    let replies = served_letting(
        &[call("status", json!({})), call("status", json!({}))],
        never_run,
        |_| {
            asked.set(asked.get() + 1);
            Err("the user did not let it in".to_string())
        },
    );
    assert_eq!(asked.get(), 1);
    for reply in &replies {
        assert_eq!(reply["result"]["isError"], true);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("did not let An agent use this desktop"),
            "{text}"
        );
    }
}

#[test]
fn an_agent_the_user_stopped_is_refused() {
    let replies = served_letting(&[call("status", json!({}))], never_run, |_| {
        Ok(Grant {
            reach: Box::new(|| AgentReach::Desk),
            stopped: Box::new(|| true),
            did: Box::new(|_| ()),
        })
    });
    let text = replies[0]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("stopped"), "{text}");
}

#[test]
fn a_stopped_agent_asks_again_only_through_ask_to_use_desktop() {
    let asked = Rc::new(Cell::new(0));
    let asking = Rc::clone(&asked);
    let replies = served_letting(
        &[
            call("status", json!({})),
            call("status", json!({})),
            call("ask_to_use_desktop", json!({})),
            call("status", json!({})),
            call("ask_to_use_desktop", json!({})),
        ],
        |_| printed("{}"),
        move |_| {
            asking.set(asking.get() + 1);
            // The first grant the user stops at once; the second holds.
            let stopped = asking.get() == 1;
            Ok(Grant {
                reach: Box::new(|| AgentReach::Desk),
                stopped: Box::new(move || stopped),
                did: Box::new(|_| ()),
            })
        },
    );
    let text = |reply: &Value| {
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    };
    for reply in &replies[..2] {
        assert_eq!(reply["result"]["isError"], true);
        assert!(
            text(reply).contains("call ask_to_use_desktop"),
            "{}",
            text(reply)
        );
    }
    assert_eq!(replies[2]["result"]["isError"], false);
    assert!(
        text(&replies[2]).contains("let An agent use"),
        "{}",
        text(&replies[2])
    );
    assert_eq!(replies[3]["result"]["isError"], false);
    assert!(
        text(&replies[4]).contains("already"),
        "{}",
        text(&replies[4])
    );
    assert_eq!(asked.get(), 2, "it asks once more, when asked to");
}

#[test]
fn an_agent_turned_away_can_ask_again() {
    let asked = Cell::new(0);
    let replies = served_letting(
        &[
            call("status", json!({})),
            call("ask_to_use_desktop", json!({})),
            call("status", json!({})),
        ],
        |_| printed("{}"),
        |_| {
            asked.set(asked.get() + 1);
            if asked.get() == 1 {
                Err("the user did not let it in".to_string())
            } else {
                Ok(reaching(AgentReach::Desk).0)
            }
        },
    );
    assert_eq!(replies[0]["result"]["isError"], true);
    assert_eq!(replies[1]["result"]["isError"], false);
    assert_eq!(replies[2]["result"]["isError"], false);
    assert_eq!(asked.get(), 2);
}

/// Sets its flag when dropped, as a grant's `domicile agent` ends.
struct Ends(Rc<Cell<bool>>);

impl Drop for Ends {
    fn drop(&mut self) {
        self.0.set(true);
    }
}

#[test]
fn stop_using_desktop_lets_go_of_the_grant_and_the_next_call_asks_again() {
    let ended = Rc::new(Cell::new(false));
    let asked = Rc::new(Cell::new(0));
    let (ending, asking) = (Rc::clone(&ended), Rc::clone(&asked));
    let replies = served_letting(
        &[
            call("status", json!({})),
            call("stop_using_desktop", json!({})),
            call("status", json!({})),
        ],
        |_| printed("{}"),
        move |_| {
            asking.set(asking.get() + 1);
            if asking.get() == 2 {
                assert!(ending.get(), "the first grant ends before it asks again");
            }
            let ends = Ends(Rc::clone(&ending));
            Ok(Grant {
                reach: Box::new(|| AgentReach::Desk),
                stopped: Box::new(|| false),
                did: Box::new(move |_| {
                    let _ = &ends;
                }),
            })
        },
    );
    assert_eq!(replies[1]["result"]["isError"], false);
    let text = replies[1]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("no longer uses"), "{text}");
    assert_eq!(replies[2]["result"]["isError"], false);
    assert_eq!(asked.get(), 2);
}

#[test]
fn stop_using_desktop_before_any_use_asks_nothing() {
    let replies = served_letting(&[call("stop_using_desktop", json!({}))], never_run, |_| {
        panic!("asked the user")
    });
    assert_eq!(replies[0]["result"]["isError"], false);
    let text = replies[0]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("was not using"), "{text}");
}

#[test]
fn what_an_agent_did_is_listed_with_the_windows_title_and_never_what_it_typed() {
    let (grant, did) = reaching(two_windows());
    let mut grant = Some(grant);
    served_letting(
        &[
            call(
                "app_set_text",
                json!({"window": "n1", "ref": ":1.7/w/1/text", "text": "hunter2"}),
            ),
            call("browser_snapshot", json!({"window": "w1"})),
        ],
        |args| match args[0].as_str() {
            "devtools" => printed("{\"nodes\": []}"),
            "list-windows" => printed("[{\"id\": \"w1\", \"views\": []}]"),
            _ => printed(""),
        },
        move |_| Ok(grant.take().expect("asked once")),
    );
    assert_eq!(*did.borrow(), ["Typed in Notes", "Read Pull requests"]);
}

#[test]
fn with_only_some_windows_the_desk_wide_tools_are_refused() {
    for (name, arguments) in [
        ("screenshot", json!({})),
        ("click", json!({"x": 1, "y": 1})),
        ("type_text", json!({"text": "hi"})),
        ("key", json!({"chord": "ctrl+l"})),
        ("send_shell", json!({"words": ["focus", "left"]})),
        ("exec", json!({"argv": ["kitty"]})),
        ("open", json!({"target": "https://example.com"})),
        ("focus_window", json!({"id": "n1"})),
        ("status", json!({})),
    ] {
        let replies = served_letting(&[call(name, arguments)], never_run, |_| {
            Ok(reaching(two_windows()).0)
        });
        let text = replies[0]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("only some windows"), "{name}: {text}");
    }
}

#[test]
fn with_only_some_windows_a_window_not_shared_is_refused() {
    for (name, arguments) in [
        ("browser_snapshot", json!({"window": "w2"})),
        ("app_snapshot", json!({"window": "n2"})),
        ("close_window", json!({"id": "n2"})),
    ] {
        let replies = served_letting(&[call(name, arguments)], never_run, |_| {
            Ok(reaching(two_windows()).0)
        });
        let text = replies[0]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("did not share window"), "{name}: {text}");
    }
}

#[test]
fn with_only_some_windows_list_windows_lists_only_those() {
    let replies = served_letting(
        &[call("list_windows", json!({}))],
        |_| {
            printed(
                r#"[{"id": "n1", "title": "Notes"}, {"id": "n2", "title": "Secrets"}, {"id": "w1", "title": "Pull requests"}]"#,
            )
        },
        |_| Ok(reaching(two_windows()).0),
    );
    let listed: Value =
        serde_json::from_str(replies[0]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        listed,
        json!([{"id": "n1", "title": "Notes"}, {"id": "w1", "title": "Pull requests"}])
    );
}

#[test]
fn a_change_the_user_makes_applies_from_the_next_call() {
    let reach = Rc::new(RefCell::new(AgentReach::Desk));
    let changing = Rc::clone(&reach);
    let mut grant = Some(Grant {
        reach: Box::new(move || changing.borrow().clone()),
        stopped: Box::new(|| false),
        did: Box::new(|_| ()),
    });
    let narrowed = Rc::clone(&reach);
    let replies = served_letting(
        &[call("status", json!({})), call("status", json!({}))],
        move |_| {
            // After the first call runs, the user narrows it to two windows,
            // which takes the desk-wide `status` away.
            *narrowed.borrow_mut() = two_windows();
            printed("{}")
        },
        move |_| Ok(grant.take().expect("asked once")),
    );
    assert_eq!(replies[0]["result"]["isError"], false);
    assert_eq!(replies[1]["result"]["isError"], true);
}

/// An accessibility tree of one button named `named`, ref 12, on page "Inbox".
fn one_button(named: &str) -> Value {
    json!({"nodes": [
        {"nodeId": "1", "ignored": false, "role": {"value": "RootWebArea"}, "name": {"value": "Inbox"}, "childIds": ["2"], "backendDOMNodeId": 1},
        {"nodeId": "2", "ignored": false, "role": {"value": "button"}, "name": {"value": named}, "childIds": [], "backendDOMNodeId": 12}
    ]})
}

/// Stands in for `domicile devtools` on browser window `w1`, whose tree is
/// each of `trees` in turn, the last one from then on.
fn changing_page(trees: Vec<Value>) -> impl FnMut(&[String]) -> io::Result<Ran> {
    let mut read = 0;
    move |args| {
        if args == ["list-windows", "--json"] {
            return printed("[{\"id\": \"w1\", \"views\": []}]\n");
        }
        let answer = match args[2].as_str() {
            "Accessibility.getFullAXTree" => {
                read += 1;
                trees[(read - 1).min(trees.len() - 1)].clone()
            }
            "DOM.getContentQuads" => json!({"quads": [[10, 20, 110, 20, 110, 40, 10, 40]]}),
            _ => json!({}),
        };
        printed(&format!("{answer}\n"))
    }
}

#[test]
fn a_browser_act_answers_what_changed_since_the_window_was_last_read() {
    let replies = served(
        &[
            call("browser_snapshot", json!({"window": "w1"})),
            call("browser_click", json!({"window": "w1", "ref": 12})),
            call("browser_key", json!({"window": "w1", "key": "Tab"})),
        ],
        changing_page(vec![one_button("Send"), one_button("Sent")]),
    );
    assert_eq!(
        replies[1]["result"]["content"][0]["text"],
        "clicked element 12\n\
         What changed in the window since it was last read:\n\
         gone: button \"Send\" [ref=12]\n\
         new: button \"Sent\" [ref=12]\n"
    );
    assert_eq!(
        replies[2]["result"]["content"][0]["text"],
        "pressed Tab\nNothing in the window changed.\n"
    );
}

#[test]
fn a_browser_act_on_a_window_not_read_yet_answers_all_of_it() {
    let replies = served(
        &[call("browser_type", json!({"window": "w1", "text": "hi"}))],
        changing_page(vec![one_button("Send")]),
    );
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "typed\nThe window now:\n\
         - RootWebArea \"Inbox\" [ref=1]\n  \
         - button \"Send\" [ref=12]\n"
    );
}

#[test]
fn an_app_act_answers_what_changed_since_the_window_was_last_read() {
    let mut reads = 0;
    let replies = served(
        &[
            call("app_snapshot", json!({"window": "kD3m"})),
            call("app_click", json!({"window": "kD3m", "ref": ":1.7/w/1"})),
        ],
        move |args| match args[0].as_str() {
            "accessibility" => {
                reads += 1;
                printed(match reads {
                    1 => "- frame \"Notes\" [ref=:1.7/w/0]\n  - push button \"Save\" [ref=:1.7/w/1]\n",
                    _ => "- frame \"Notes\" [ref=:1.7/w/0]\n  - push button \"Saved\" [ref=:1.7/w/1]\n",
                })
            }
            _ => printed(""),
        },
    );
    assert_eq!(
        replies[1]["result"]["content"][0]["text"],
        "What changed in the window since it was last read:\n\
         gone: push button \"Save\" [ref=:1.7/w/1]\n\
         new: push button \"Saved\" [ref=:1.7/w/1]\n"
    );
}

#[test]
fn an_act_whose_window_cannot_be_read_again_says_so_and_that_it_acted() {
    let refused = |stderr: &str| {
        Ok(Ran {
            success: false,
            stdout: String::new(),
            stderr: stderr.to_string(),
        })
    };
    let replies = served(
        &[
            call("browser_key", json!({"window": "w1", "key": "Tab"})),
            call("app_focus", json!({"window": "kD3m", "ref": ":1.7/w/1"})),
        ],
        |args| match (args[0].as_str(), args.get(2).map(String::as_str)) {
            ("devtools", Some("Accessibility.getFullAXTree")) | ("accessibility", _) => {
                refused("domicile: the window closed\n")
            }
            _ => printed("{}\n"),
        },
    );
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "pressed Tab\nIt could not be read again: domicile: the window closed\n"
    );
    assert_eq!(
        replies[1]["result"]["content"][0]["text"],
        "{}\nIt could not be read again: domicile: the window closed\n"
    );
    assert!(replies
        .iter()
        .all(|reply| reply["result"]["isError"] == false));
}

#[test]
fn the_browser_tools_read_the_shells_own_page_as_window_shell() {
    let mut ran = Vec::new();
    let replies = served(
        &[call("browser_snapshot", json!({"window": "shell"}))],
        |args: &[String]| {
            ran.push(args.to_vec());
            printed(&format!("{}\n", one_button("Wi-Fi")))
        },
    );
    // The shell holds no views, and list-windows doesn't list it.
    assert_eq!(
        ran,
        [["devtools", "shell", "Accessibility.getFullAXTree", "{}"]]
    );
    assert_eq!(
        replies[0]["result"]["content"][0]["text"],
        "- RootWebArea \"Inbox\" [ref=1]\n  - button \"Wi-Fi\" [ref=12]\n"
    );
}

#[test]
fn an_agent_given_only_some_windows_cannot_reach_the_shell() {
    let replies = served_letting(
        &[call("browser_snapshot", json!({"window": "shell"}))],
        never_run,
        |_| Ok(reaching(two_windows()).0),
    );
    assert_eq!(replies[0]["result"]["isError"], true);
}

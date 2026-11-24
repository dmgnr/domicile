//! Every message the desktop sends a shell, for `domicile set-log-level trace
//! shell`.
//!
//! Each line names the message and the ids in it: which window, display or
//! request. Never what a field says: titles, notification text and clipboard
//! entries stay out of the log.

use serde::Serialize;
use serde_json::Value;

/// The fields a line keeps: ids, sizes and states. Anything else, such as a
/// title or a notification's body, is left out.
const KEPT: [&str; 26] = [
    "app_id",
    "id",
    "ids",
    "parent",
    "transient_for",
    "toplevel_id",
    "toplevel_ids",
    "desktop_id",
    "display",
    "monitor",
    "owner",
    "session",
    "serial",
    "request",
    "size",
    "position",
    "states",
    "state",
    "suspended",
    "urgent",
    "inhibits",
    "active",
    "composing",
    "power",
    "seconds",
    "protocol_version",
];

/// The longest a kept array is before it is cut.
const LONGEST_ARRAY: usize = 8;

/// Logs `message` at trace, as `to` says where it went.
pub fn trace(to: &str, message: &impl Serialize) {
    if tracing::enabled!(tracing::Level::TRACE) {
        tracing::trace!("host -> {to} {}", summarized(message));
    }
}

/// `message`'s type and the [`KEPT`] fields in it.
pub fn summarized(message: &impl Serialize) -> String {
    let value = serde_json::to_value(message).expect("a host message is plain data");
    let Value::Object(fields) = value else {
        return "a message with no type".to_string();
    };
    let kind = match fields.get("type") {
        Some(Value::String(kind)) => kind.clone(),
        _ => "a message with no type".to_string(),
    };
    let kept: Vec<String> = KEPT
        .iter()
        .filter_map(|name| {
            fields
                .get(*name)
                .and_then(shown)
                .map(|shown| format!("{name}={shown}"))
        })
        .collect();
    match kept.is_empty() {
        true => kind,
        false => format!("{kind} {}", kept.join(" ")),
    }
}

/// `value` as a line shows it, if it is a scalar or a short array of them.
fn shown(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(value.to_string()),
        Value::Array(items) => {
            let scalars: Option<Vec<String>> = items
                .iter()
                .take(LONGEST_ARRAY)
                .map(|item| match item {
                    Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(item.to_string()),
                    _ => None,
                })
                .collect();
            scalars.map(|scalars| {
                let more = match items.len() > LONGEST_ARRAY {
                    true => format!(",+{}", items.len() - LONGEST_ARRAY),
                    false => String::new(),
                };
                format!("[{}{more}]", scalars.join(","))
            })
        }
        Value::Object(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domicile_protocol::HostMessage;

    #[test]
    fn a_message_keeps_its_type_and_ids() {
        let message = HostMessage::AppResized {
            app_id: "app-3".into(),
            size: [640.0, 480.0],
        };
        assert_eq!(
            summarized(&message),
            r#"app_resized app_id="app-3" size=[640.0,480.0]"#
        );
    }

    #[test]
    fn a_message_leaves_out_what_its_text_says() {
        let message = HostMessage::AppTitled {
            app_id: "app-3".into(),
            title: Some("My bank statement".into()),
        };
        assert_eq!(summarized(&message), r#"app_titled app_id="app-3""#);
    }

    #[test]
    fn a_long_array_is_cut() {
        let ids: Vec<u32> = (1..=10).collect();
        assert_eq!(
            shown(&serde_json::json!(ids)).unwrap(),
            "[1,2,3,4,5,6,7,8,+2]"
        );
    }

    #[test]
    fn an_array_of_objects_is_left_out() {
        assert_eq!(shown(&serde_json::json!([{ "title": "x" }])), None);
    }
}

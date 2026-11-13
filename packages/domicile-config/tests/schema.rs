//! The config's JSON Schema, which editors and the SDK's generated types read.
//!
//! Fields that parse through `try_from` must describe what is written, not the
//! type they parse into.

use domicile_config::Config;
use serde_json::{json, Value};

fn schema() -> Value {
    serde_json::to_value(schemars::schema_for!(Config)).expect("a schema is JSON")
}

#[test]
fn the_schema_refuses_keys_the_config_refuses() {
    assert_eq!(schema()["additionalProperties"], json!(false));
}

#[test]
fn an_accent_color_is_written_as_a_hex_string() {
    let schema = schema();
    let color = &schema["$defs"]["AccentColor"];
    assert_eq!(color["type"], json!("string"), "{color}");
    assert_eq!(color["pattern"], json!("^#[0-9a-fA-F]{6}$"), "{color}");
}

#[test]
fn files_to_omit_are_written_as_a_list_of_globs() {
    let schema = schema();
    let omit = &schema["$defs"]["FilesOmit"];
    assert_eq!(omit["type"], json!("array"), "{omit}");
    assert_eq!(omit["items"], json!({ "type": "string" }), "{omit}");
}

/// The SDK's Zod schema fills in what a config leaves out from these, so a
/// field with no default would read as absent where the compositor fills it.
#[test]
fn every_optional_key_states_its_default() {
    let schema = schema();
    let root = "Config".to_owned();
    let objects = schema["$defs"]
        .as_object()
        .expect("definitions")
        .iter()
        .chain([(&root, &schema)]);
    for (name, object) in objects {
        let required = object["required"].as_array().cloned().unwrap_or_default();
        for (key, property) in object["properties"].as_object().into_iter().flatten() {
            let nullable = property.to_string().contains(r#""null""#);
            assert!(
                required.contains(&json!(key)) || nullable || property.get("default").is_some(),
                "{name}.{key} has no default: {property}"
            );
        }
    }
}

#[test]
fn defaults_are_written_as_a_config_writes_them() {
    let schema = schema();
    let files = &schema["properties"]["files"]["default"];
    assert_eq!(files, &json!({ "omit": ["**/.*"] }));
    let color: String = domicile_config::AccentColor([0x12, 0xab, 0xff]).into();
    assert_eq!(color, "#12abff");
}

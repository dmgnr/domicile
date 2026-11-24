//! The engine switch registering the apps' own schemes.

use domicile_launch::electron_schemes::schemes_switch;

#[test]
fn every_apps_schemes_go_in_one_switch() {
    let record = r#"{
      "claude": [
        { "scheme": "cowork-artifact", "privileges": ["secure", "standard"] },
        { "scheme": "app", "privileges": ["standard"] }
      ],
      "element": [{ "scheme": "vector", "privileges": [] }]
    }"#;

    assert_eq!(
        schemes_switch(record),
        Ok(Some(
            "--domicile-electron-schemes=app:standard;cowork-artifact:standard,secure;vector:"
                .to_string()
        ))
    );
}

#[test]
fn two_apps_scheme_gets_what_either_asked_for() {
    let record = r#"{
      "a": [{ "scheme": "app", "privileges": ["standard"] }],
      "b": [{ "scheme": "app", "privileges": ["supportFetchAPI", "standard"] }]
    }"#;

    assert_eq!(
        schemes_switch(record),
        Ok(Some(
            "--domicile-electron-schemes=app:standard,supportFetchAPI".to_string()
        ))
    );
}

#[test]
fn an_empty_record_registers_nothing() {
    assert_eq!(schemes_switch("{}"), Ok(None));
    assert_eq!(schemes_switch(r#"{ "a": [] }"#), Ok(None));
}

#[test]
fn a_record_electron_host_cannot_have_written_is_refused() {
    assert!(schemes_switch(r#"{ "a": [{ "scheme": "https", "privileges": [] }] }"#).is_err());
    assert!(schemes_switch(r#"{ "a": [{ "scheme": "App", "privileges": [] }] }"#).is_err());
    assert!(schemes_switch(r#"{ "a": [{ "scheme": "app", "privileges": ["stream"] }] }"#).is_err());
    assert!(schemes_switch("not json").is_err());
}

#[test]
fn known_apps_schemes_register_before_their_first_run() {
    use domicile_launch::electron_schemes::with_known;

    let switch = schemes_switch(&with_known("{}").unwrap()).unwrap().unwrap();
    assert!(
        switch.contains("vector:standard,secure,supportFetchAPI"),
        "{switch}"
    );
    assert!(
        switch.contains("sentry-ipc:secure,bypassCSP,corsEnabled,supportFetchAPI"),
        "{switch}"
    );
    assert!(
        switch.contains("slack-webapp-dev:standard,secure,bypassCSP,corsEnabled,supportFetchAPI"),
        "{switch}"
    );
    assert!(
        switch.contains("codex-sandbox:standard,secure,corsEnabled,supportFetchAPI"),
        "{switch}"
    );

    // What an app kept adds to what is known of it.
    let kept = r#"{ "element-desktop": [{ "scheme": "vector", "privileges": ["corsEnabled"] }] }"#;
    let switch = schemes_switch(&with_known(kept).unwrap()).unwrap().unwrap();
    assert!(
        switch.contains("vector:standard,secure,corsEnabled,supportFetchAPI"),
        "{switch}"
    );
    assert!(with_known("not json").is_err());
}

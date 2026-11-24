//! `org.freedesktop.impl.portal.AppChooser`: the user picks an application to
//! open a file or URI with. The frontend's `OpenURI` asks through it.

use std::collections::HashMap;
use std::sync::Arc;

use domicile_protocol::{AppChooserDialog, PortalAnswer, PortalKind};
use tracing::debug;
use zbus::object_server::ObjectServer;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use super::queue::{ask, Queue};
use super::request::Request;

/// The `AppChooser` backend object.
pub struct AppChooser {
    pub queue: Arc<Queue>,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.AppChooser")]
impl AppChooser {
    /// Ask, and answer with the portal's response and, on success, the
    /// `choice` and the application's `activation_token`.
    async fn choose_application(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        choices: Vec<String>,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let asked = Asked::read(choices, options);
        let parent_window = if asked.modal {
            parent_window.as_str()
        } else {
            ""
        };
        let answer = ask(
            &self.queue,
            server,
            handle,
            app_id,
            parent_window,
            asked.kind,
        )
        .await;
        (answer.response(), results(answer, asked.activation_token))
    }

    /// The frontend found more applications while the dialog is up.
    async fn update_choices(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        choices: Vec<String>,
    ) {
        let id = match server.interface::<_, Request>(&handle).await {
            Ok(request) => request.get().await.id,
            Err(why) => {
                debug!(%why, %handle, "new choices for a dialog that is gone");
                return;
            }
        };
        let revised = self.queue.revise(id, |kind| {
            if let PortalKind::AppChooser(dialog) = kind {
                dialog.choices = choices;
            }
        });
        if let Err(why) = revised {
            debug!(%why, %handle, "new choices for a dialog already answered");
        }
    }
}

/// What a `ChooseApplication` call asks.
#[derive(Debug, PartialEq)]
struct Asked {
    kind: PortalKind,
    /// Whether the dialog is modal over `parent_window`. Defaults to `true`,
    /// as the spec says.
    modal: bool,
    /// Handed back with the choice, to activate the chosen application.
    activation_token: Option<String>,
}

impl Asked {
    /// Read a call's `options`. An option of the wrong type reads as absent.
    fn read(choices: Vec<String>, mut options: HashMap<String, OwnedValue>) -> Asked {
        let mut text = |name: &str| {
            options
                .remove(name)
                .and_then(|value| String::try_from(value).ok())
        };
        let kind = PortalKind::AppChooser(AppChooserDialog {
            choices,
            last_choice: text("last_choice"),
            content_type: text("content_type"),
            uri: text("uri"),
            filename: text("filename"),
        });
        let activation_token = text("activation_token");
        let modal = options
            .remove("modal")
            .and_then(|value| bool::try_from(value).ok())
            .unwrap_or(true);
        Asked {
            kind,
            modal,
            activation_token,
        }
    }
}

/// The results for `answer`: the choice and token on success, else nothing.
fn results(answer: PortalAnswer, activation_token: Option<String>) -> HashMap<String, OwnedValue> {
    match answer {
        PortalAnswer::AppChooser { choice } => Some(("choice", choice))
            .into_iter()
            .chain(activation_token.map(|token| ("activation_token", token)))
            .map(|(name, value)| (name.to_string(), owned(value)))
            .collect(),
        // The queue gives a request only answers of its kind, a dismissal or
        // a refusal.
        PortalAnswer::Access
        | PortalAnswer::FileChooser(_)
        | PortalAnswer::RemoteDesktop { .. }
        | PortalAnswer::InputCapture
        | PortalAnswer::ScreenCast { .. }
        | PortalAnswer::Print { .. }
        | PortalAnswer::SaveToPdf { .. }
        | PortalAnswer::Stop
        | PortalAnswer::Pause
        | PortalAnswer::Resume
        | PortalAnswer::Discard
        | PortalAnswer::DynamicLauncher { .. }
        | PortalAnswer::GlobalShortcuts { .. }
        | PortalAnswer::Screenshot { .. }
        | PortalAnswer::ScreenshotWindow { .. }
        | PortalAnswer::ScreenshotBrowserWindow { .. }
        | PortalAnswer::PickColor { .. }
        | PortalAnswer::Agent { .. }
        | PortalAnswer::Change
        | PortalAnswer::Pressed
        | PortalAnswer::Released
        | PortalAnswer::Canceled
        | PortalAnswer::Refused => HashMap::new(),
    }
}

fn owned(text: String) -> OwnedValue {
    OwnedValue::try_from(Value::from(text)).expect("a string holds no file descriptor")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(sent: Vec<(&str, Value<'static>)>) -> HashMap<String, OwnedValue> {
        sent.into_iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    OwnedValue::try_from(value).expect("an ownable value"),
                )
            })
            .collect()
    }

    #[test]
    fn every_option_the_spec_names_is_read() {
        let asked = Asked::read(
            vec!["firefox".into()],
            options(vec![
                ("last_choice", Value::from("firefox")),
                ("modal", Value::from(false)),
                ("content_type", Value::from("text/html")),
                ("uri", Value::from("https://example.com/")),
                ("filename", Value::from("index.html")),
                ("activation_token", Value::from("token-1")),
            ]),
        );

        assert_eq!(
            asked,
            Asked {
                kind: PortalKind::AppChooser(AppChooserDialog {
                    choices: vec!["firefox".into()],
                    last_choice: Some("firefox".into()),
                    content_type: Some("text/html".into()),
                    uri: Some("https://example.com/".into()),
                    filename: Some("index.html".into()),
                }),
                modal: false,
                activation_token: Some("token-1".into()),
            }
        );
    }

    #[test]
    fn a_dialog_is_modal_unless_told_otherwise() {
        let asked = Asked::read(vec![], options(vec![("modal", Value::from("no"))]));

        assert!(asked.modal);
    }

    #[test]
    fn a_dismissal_hands_back_nothing() {
        assert_eq!(
            results(PortalAnswer::Canceled, Some("token-1".into())),
            HashMap::new()
        );
    }
}

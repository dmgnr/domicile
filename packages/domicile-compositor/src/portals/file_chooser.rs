//! `org.freedesktop.impl.portal.FileChooser`: the files an application opens,
//! or where it saves.
//!
//! The shell's picker matches extensions and answers with paths. This turns
//! the portal's globs, MIME types and byte-string paths into those, and the
//! answer back into `file://` URIs. See `docs/PORTALS.md`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use domicile_host::file_filters::{extensions, MimeTypes};
use domicile_protocol::{
    FileChoice, FileChoiceOption, FileChooserAnswer, FileChooserDialog, FileChooserMode,
    FileFilter, PortalAnswer, PortalKind,
};
use tracing::warn;
use zbus::object_server::ObjectServer;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use super::queue::{ask, Queue};

/// A portal filter: its name and `(type, pattern)` pairs.
type PortalFilter = (String, Vec<(u32, String)>);

/// A portal choice: id, label, `(id, label)` options and the initial option.
type PortalChoice = (String, String, Vec<(String, String)>, String);

/// The `FileChooser` backend object.
pub struct FileChooser {
    pub queue: Arc<Queue>,
    /// Where shared-mime-info's `globs2` files are, for MIME type filters.
    pub data_dirs: Vec<PathBuf>,
    /// The user's home directory, for the picker's places.
    pub home: String,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.FileChooser")]
impl FileChooser {
    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn open_file(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        title: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        self.choose(
            server,
            handle,
            app_id,
            &parent_window,
            FileChooserMode::Open,
            title,
            options,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn save_file(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        title: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        self.choose(
            server,
            handle,
            app_id,
            &parent_window,
            FileChooserMode::Save,
            title,
            options,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn save_files(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        title: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        self.choose(
            server,
            handle,
            app_id,
            &parent_window,
            FileChooserMode::SaveFiles,
            title,
            options,
        )
        .await
    }
}

impl FileChooser {
    #[allow(clippy::too_many_arguments)]
    async fn choose(
        &self,
        server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: &str,
        mode: FileChooserMode,
        title: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let types = MimeTypes::read(&self.data_dirs).unwrap_or_else(|why| {
            tracing::error!(%why, "MIME types are unreadable; file filters by type match nothing");
            MimeTypes::default()
        });
        let asked = Asked::new(mode, title, options, &types, &self.home);
        let kind = PortalKind::FileChooser(asked.dialog.clone());
        let answer = ask(&self.queue, server, handle, app_id, parent_window, kind).await;
        asked.respond(answer)
    }
}

/// A request as sent to the shell, and the portal filters its indices name.
struct Asked {
    dialog: FileChooserDialog,
    /// The portal's own filter for each of `dialog.filters`.
    filters: Vec<PortalFilter>,
}

impl Asked {
    /// The dialog `options` describe. An option of the wrong type reads as
    /// absent.
    fn new(
        mode: FileChooserMode,
        title: String,
        mut options: HashMap<String, OwnedValue>,
        types: &MimeTypes,
        home: &str,
    ) -> Self {
        let mut take = |name: &str| options.remove(name);
        let flag = |value: Option<OwnedValue>| value.and_then(|value| bool::try_from(value).ok());
        let text = |value: Option<OwnedValue>| value.and_then(|value| String::try_from(value).ok());
        let path = |value: Option<OwnedValue>| {
            value
                .and_then(|value| Vec::<u8>::try_from(value).ok())
                .map(|bytes| byte_string(&bytes))
        };

        let accept_label = text(take("accept_label"));
        let multiple = flag(take("multiple")).unwrap_or(false);
        let directory = flag(take("directory")).unwrap_or(false);
        let mut portal_filters: Vec<PortalFilter> = take("filters")
            .and_then(|value| Vec::try_from(value).ok())
            .unwrap_or_default();
        let current: Option<PortalFilter> =
            take("current_filter").and_then(|value| PortalFilter::try_from(value).ok());
        if let Some(current) = &current {
            if !portal_filters.contains(current) {
                portal_filters.push(current.clone());
            }
        }
        let (filters, sent): (Vec<PortalFilter>, Vec<FileFilter>) = portal_filters
            .into_iter()
            .filter_map(|(name, patterns)| {
                let extensions = extensions(&patterns, types)?;
                Some(((name.clone(), patterns), FileFilter { name, extensions }))
            })
            .unzip();
        let current_filter = current
            .and_then(|current| filters.iter().position(|kept| *kept == current))
            .map(|index| index as u32);
        let choices: Vec<PortalChoice> = take("choices")
            .and_then(|value| Vec::try_from(value).ok())
            .unwrap_or_default();
        let files: Vec<Vec<u8>> = take("files")
            .and_then(|value| Vec::try_from(value).ok())
            .unwrap_or_default();
        let mut current_folder = path(take("current_folder"));
        let mut current_name = text(take("current_name"));
        if let Some(file) = path(take("current_file")) {
            let file = PathBuf::from(file);
            current_folder = file.parent().map(|folder| folder.display().to_string());
            current_name = file
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
        }

        Asked {
            dialog: FileChooserDialog {
                mode,
                title,
                accept_label,
                multiple,
                directory,
                filters: sent,
                current_filter,
                current_folder,
                home: home.to_string(),
                current_name,
                files: files.iter().map(|name| byte_string(name)).collect(),
                choices: choices
                    .into_iter()
                    .map(|(id, label, options, initial)| FileChoice {
                        id,
                        label,
                        options: options
                            .into_iter()
                            .map(|(id, label)| FileChoiceOption { id, label })
                            .collect(),
                        initial,
                    })
                    .collect(),
            },
            filters,
        }
    }

    /// The portal's response and results for the shell's `answer`.
    fn respond(&self, answer: PortalAnswer) -> (u32, HashMap<String, OwnedValue>) {
        match answer {
            PortalAnswer::FileChooser(chosen) => match self.results(chosen) {
                Ok(results) => (0, results),
                Err(why) => {
                    warn!(why, "the shell's file choice is not one the dialog offered");
                    (2, HashMap::new())
                }
            },
            PortalAnswer::Canceled => (1, HashMap::new()),
            PortalAnswer::Access
            | PortalAnswer::AppChooser { .. }
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
            | PortalAnswer::Refused => (2, HashMap::new()),
        }
    }

    /// `uris`, `choices` and `current_filter` for what the shell chose.
    fn results(
        &self,
        chosen: FileChooserAnswer,
    ) -> Result<HashMap<String, OwnedValue>, &'static str> {
        if !chosen.paths.iter().all(|path| path.starts_with('/')) {
            return Err("a path is not absolute");
        }
        let paths: Vec<String> = match self.dialog.mode {
            FileChooserMode::SaveFiles => chosen
                .paths
                .iter()
                .flat_map(|folder| {
                    self.dialog
                        .files
                        .iter()
                        .map(move |name| format!("{}/{name}", folder.trim_end_matches('/')))
                })
                .collect(),
            FileChooserMode::Open | FileChooserMode::Save => chosen.paths,
        };
        let uris: Vec<String> = paths.iter().map(|path| file_uri(path)).collect();
        let choices: Vec<(String, String)> = chosen.choices.into_iter().collect();
        let mut results = HashMap::from([
            ("uris".to_string(), owned(Value::from(uris))),
            ("choices".to_string(), owned(Value::from(choices))),
        ]);
        if let Some(index) = chosen.current_filter {
            let filter = self
                .filters
                .get(index as usize)
                .ok_or("the filter is not one the dialog offered")?;
            results.insert(
                "current_filter".to_string(),
                owned(Value::from(filter.clone())),
            );
        }
        Ok(results)
    }
}

/// A portal byte-string path or name, without its trailing NUL.
fn byte_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_suffix(b"\0").unwrap_or(bytes)).into_owned()
}

/// `path` as a `file://` URI, percent-encoding all but RFC 3986's unreserved
/// characters and `/`.
fn file_uri(path: &str) -> String {
    let encoded: String = path
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect();
    format!("file://{encoded}")
}

/// `value` owned, for a reply. Fails only for a file descriptor, which no
/// result here holds.
fn owned(value: Value<'_>) -> OwnedValue {
    OwnedValue::try_from(value).expect("no file descriptors in a file chooser's results")
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

    fn filter(name: &str, patterns: &[(u32, &str)]) -> PortalFilter {
        (
            name.into(),
            patterns
                .iter()
                .map(|(kind, pattern)| (*kind, pattern.to_string()))
                .collect(),
        )
    }

    /// A path as the portal sends it: bytes ending in a NUL.
    fn bytes(path: &str) -> Value<'static> {
        Value::from([path.as_bytes(), b"\0"].concat())
    }

    fn images() -> PortalFilter {
        filter("Images", &[(0, "*.[pP][nN][gG]"), (1, "image/jpeg")])
    }

    fn types() -> MimeTypes {
        MimeTypes::parse("50:image/jpeg:*.jpg\n")
    }

    fn opened(sent: Vec<(&str, Value<'static>)>) -> Asked {
        Asked::new(
            FileChooserMode::Open,
            "Open Image".into(),
            options(sent),
            &types(),
            "/home/me",
        )
    }

    fn chosen(paths: &[&str]) -> PortalAnswer {
        PortalAnswer::FileChooser(FileChooserAnswer {
            paths: paths.iter().map(|path| path.to_string()).collect(),
            choices: Default::default(),
            current_filter: None,
        })
    }

    fn uris(results: &HashMap<String, OwnedValue>) -> Vec<String> {
        Vec::<String>::try_from(results["uris"].try_clone().expect("cloned")).expect("as")
    }

    #[test]
    fn an_open_dialog_reads_every_option() {
        let asked = opened(vec![
            ("accept_label", Value::from("Pick")),
            ("multiple", Value::from(true)),
            ("directory", Value::from(false)),
            ("modal", Value::from(true)),
            (
                "filters",
                Value::from(vec![images(), filter("All", &[(0, "*")])]),
            ),
            ("current_filter", Value::from(filter("All", &[(0, "*")]))),
            ("current_folder", bytes("/home/me/Pictures")),
            (
                "choices",
                Value::from(vec![
                    (
                        "encoding".to_string(),
                        "Encoding".to_string(),
                        vec![("utf8".to_string(), "UTF-8".to_string())],
                        "utf8".to_string(),
                    ),
                    (
                        "readonly".to_string(),
                        "Read only".to_string(),
                        Vec::<(String, String)>::new(),
                        "false".to_string(),
                    ),
                ]),
            ),
        ]);

        assert_eq!(
            asked.dialog,
            FileChooserDialog {
                mode: FileChooserMode::Open,
                title: "Open Image".into(),
                accept_label: Some("Pick".into()),
                multiple: true,
                directory: false,
                filters: vec![
                    FileFilter {
                        name: "Images".into(),
                        extensions: vec!["png".into(), "jpg".into()],
                    },
                    FileFilter {
                        name: "All".into(),
                        extensions: vec![],
                    },
                ],
                current_filter: Some(1),
                current_folder: Some("/home/me/Pictures".into()),
                home: "/home/me".into(),
                current_name: None,
                files: vec![],
                choices: vec![
                    FileChoice {
                        id: "encoding".into(),
                        label: "Encoding".into(),
                        options: vec![FileChoiceOption {
                            id: "utf8".into(),
                            label: "UTF-8".into(),
                        }],
                        initial: "utf8".into(),
                    },
                    FileChoice {
                        id: "readonly".into(),
                        label: "Read only".into(),
                        options: vec![],
                        initial: "false".into(),
                    },
                ],
            }
        );
    }

    #[test]
    fn a_filter_the_picker_cannot_match_is_left_out() {
        let asked = opened(vec![(
            "filters",
            Value::from(vec![filter("Makefiles", &[(0, "Makefile")]), images()]),
        )]);

        assert_eq!(
            asked
                .dialog
                .filters
                .iter()
                .map(|kept| kept.name.as_str())
                .collect::<Vec<_>>(),
            ["Images"]
        );
    }

    #[test]
    fn a_current_filter_outside_the_list_is_added_to_it() {
        // The spec applies it unconditionally when the list is empty.
        let asked = opened(vec![("current_filter", Value::from(images()))]);

        assert_eq!(asked.dialog.filters.len(), 1);
        assert_eq!(asked.dialog.current_filter, Some(0));
    }

    #[test]
    fn a_current_file_is_where_a_save_starts_and_what_it_is_called() {
        let asked = Asked::new(
            FileChooserMode::Save,
            "Save".into(),
            options(vec![
                ("current_name", Value::from("ignored.txt")),
                ("current_file", bytes("/home/me/notes.txt")),
            ]),
            &types(),
            "/home/me",
        );

        assert_eq!(
            (asked.dialog.current_folder, asked.dialog.current_name),
            (Some("/home/me".into()), Some("notes.txt".into()))
        );
    }

    #[test]
    fn save_files_lists_the_names_it_saves() {
        let asked = Asked::new(
            FileChooserMode::SaveFiles,
            "Save".into(),
            options(vec![(
                "files",
                Value::from(vec![b"a.txt\0".to_vec(), b"b c.txt\0".to_vec()]),
            )]),
            &types(),
            "/home/me",
        );

        assert_eq!(asked.dialog.files, ["a.txt", "b c.txt"]);
    }

    #[test]
    fn chosen_paths_are_answered_as_file_uris_with_the_choices_and_filter() {
        let asked = opened(vec![("filters", Value::from(vec![images()]))]);

        let (response, results) = asked.respond(PortalAnswer::FileChooser(FileChooserAnswer {
            paths: vec!["/home/me/a b#1.png".into()],
            choices: [("encoding".to_string(), "utf8".to_string())].into(),
            current_filter: Some(0),
        }));

        assert_eq!(response, 0);
        assert_eq!(uris(&results), ["file:///home/me/a%20b%231.png"]);
        assert_eq!(
            Vec::<(String, String)>::try_from(results["choices"].try_clone().expect("cloned"))
                .expect("a(ss)"),
            [("encoding".to_string(), "utf8".to_string())]
        );
        assert_eq!(
            PortalFilter::try_from(results["current_filter"].try_clone().expect("cloned"))
                .expect("(sa(us))"),
            images()
        );
    }

    #[test]
    fn save_files_answers_a_uri_per_name_in_the_chosen_folder() {
        let asked = Asked::new(
            FileChooserMode::SaveFiles,
            "Save".into(),
            options(vec![(
                "files",
                Value::from(vec![b"a.txt\0".to_vec(), b"b.txt\0".to_vec()]),
            )]),
            &types(),
            "/home/me",
        );

        let (_, results) = asked.respond(chosen(&["/tmp/out"]));

        assert_eq!(
            uris(&results),
            ["file:///tmp/out/a.txt", "file:///tmp/out/b.txt"]
        );
    }

    #[test]
    fn an_answer_that_is_not_a_file_choice_chooses_nothing() {
        let asked = opened(vec![]);

        assert_eq!(asked.respond(PortalAnswer::Canceled), (1, HashMap::new()));
        assert_eq!(asked.respond(PortalAnswer::Access), (2, HashMap::new()));
        assert_eq!(asked.respond(PortalAnswer::Refused), (2, HashMap::new()));
    }

    #[test]
    fn a_relative_path_or_unknown_filter_from_the_shell_is_refused() {
        let asked = opened(vec![]);
        let unknown_filter = PortalAnswer::FileChooser(FileChooserAnswer {
            paths: vec!["/home/me/a.png".into()],
            choices: Default::default(),
            current_filter: Some(3),
        });

        assert_eq!(asked.respond(chosen(&["a.png"])).0, 2);
        assert_eq!(asked.respond(unknown_filter).0, 2);
    }
}

//! `org.freedesktop.impl.portal.Print`: the shell's print dialog, and the job
//! sent to CUPS over IPP or saved as a PDF.
//!
//! `PreparePrint` asks and answers with GTK's `settings` and `page-setup` and
//! a token. `Print` sends the document with that token's choice, or asks
//! first without one. No preview: the document arrives after the dialog
//! closes. Save to PDF writes the application's own PDF to the chosen file.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use domicile_host::cups::{Cups, Offered};
use domicile_host::print_settings::{page_setup, settings as gtk_settings, Preset};
use domicile_host::save_to_pdf;
use domicile_protocol::{PortalAnswer, PortalKind, PrintDialog, PrintOptions, Printer};
use tracing::debug;
use zbus::object_server::ObjectServer;
use zbus::zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value};

use super::queue::{ask, Queue};
use super::uri::file_uri;
use crate::reply::reply;

/// The `Print` backend object.
pub struct Print {
    pub queue: Arc<Queue>,
    pub cups: Cups,
    /// The user's home directory, where Save to PDF's picker starts.
    pub home: String,
    pub prepared: Mutex<Prepared>,
}

/// What each `PreparePrint` chose, by token, until `Print` takes it.
#[derive(Default)]
pub struct Prepared {
    last: u32,
    chosen: HashMap<u32, Chosen>,
}

/// Where the document goes, and its options.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Chosen {
    destination: Destination,
    options: PrintOptions,
}

/// A CUPS queue, or a PDF file.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Destination {
    Printer(String),
    File(PathBuf),
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Print")]
impl Print {
    /// Ask, and answer with the choice as GTK settings and page setup, and a
    /// token for `Print`.
    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn prepare_print(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        title: String,
        settings: HashMap<String, OwnedValue>,
        page_setup: HashMap<String, OwnedValue>,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let preset = Preset::read(&strings(&settings), &strings(&page_setup));
        let asked = Asked {
            app_id,
            parent_window,
            title,
            options,
        };
        match self.choose(server, handle, asked, &preset).await {
            Ok(chosen) => {
                let results = HashMap::from([
                    ("settings", dictionary(settings, settings_of(&chosen))),
                    (
                        "page-setup",
                        dictionary(page_setup, page_setup_of(&chosen.options)),
                    ),
                ]);
                let token = self.prepared.lock().unwrap().keep(chosen);
                let results = results
                    .into_iter()
                    .map(|(key, value)| (key.to_string(), value))
                    .chain([("token".to_string(), OwnedValue::from(token))])
                    .collect();
                (0, results)
            }
            Err(response) => (response, HashMap::new()),
        }
    }

    /// Print the PDF or PostScript document in `fd`, as the token's
    /// `PreparePrint` chose, or after asking.
    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn print(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        title: String,
        fd: OwnedFd,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let token = options
            .get("token")
            .and_then(|token| u32::try_from(token).ok());
        let prepared = token.and_then(|token| self.prepared.lock().unwrap().take(token));
        let chosen = match prepared {
            Some(chosen) => Ok(chosen),
            None => {
                let asked = Asked {
                    app_id,
                    parent_window,
                    title: title.clone(),
                    options,
                };
                self.choose(server, handle, asked, &Preset::default()).await
            }
        };
        match chosen {
            Ok(chosen) => {
                let cups = self.cups.clone();
                let printed = off_thread(move || {
                    let mut document = Vec::new();
                    std::fs::File::from(std::os::fd::OwnedFd::from(fd))
                        .read_to_end(&mut document)
                        .map_err(|why| why.to_string())?;
                    match &chosen.destination {
                        Destination::Printer(printer) => cups
                            .print(printer, &chosen.options, &title, &document)
                            .map_err(|why| why.to_string()),
                        Destination::File(path) => save_pdf(path, &document),
                    }
                })
                .await;
                match printed {
                    Ok(()) => (0, HashMap::new()),
                    Err(why) => {
                        tracing::error!(%why, "a print job did not reach CUPS or its file");
                        (2, HashMap::new())
                    }
                }
            }
            Err(response) => (response, HashMap::new()),
        }
    }
}

/// What a call asks of the dialog.
struct Asked {
    app_id: String,
    parent_window: String,
    title: String,
    options: HashMap<String, OwnedValue>,
}

impl Print {
    /// Put the printers CUPS offers and Save to PDF to the shell, starting
    /// from `preset`. `Err` is the portal's response: `1` when the user
    /// dismissed it.
    async fn choose(
        &self,
        server: &ObjectServer,
        handle: OwnedObjectPath,
        mut asked: Asked,
        preset: &Preset,
    ) -> Result<Chosen, u32> {
        let cups = self.cups.clone();
        // No CUPS is a dialog that says there are no printers.
        let offered = off_thread(move || cups.printers())
            .await
            .unwrap_or_else(|why| {
                debug!(%why, "CUPS offers no printers");
                Offered {
                    printers: Vec::new(),
                    default: None,
                }
            });
        let accept_label = asked
            .options
            .remove("accept_label")
            .and_then(|label| String::try_from(label).ok());
        let dialog = dialog(
            asked.title,
            accept_label,
            offered,
            preset,
            self.home.clone(),
        );
        let kind = PortalKind::Print(dialog);
        match ask(
            &self.queue,
            server,
            handle,
            asked.app_id,
            &asked.parent_window,
            kind,
        )
        .await
        {
            PortalAnswer::Print { printer, options } => Ok(Chosen {
                destination: Destination::Printer(printer),
                options,
            }),
            PortalAnswer::SaveToPdf { path, options } => Ok(Chosen {
                destination: Destination::File(path.into()),
                options,
            }),
            PortalAnswer::Canceled => Err(1),
            // The queue takes no other kind's answer; see `PortalKind::accepts`.
            PortalAnswer::Refused
            | PortalAnswer::Access
            | PortalAnswer::AppChooser { .. }
            | PortalAnswer::FileChooser(_)
            | PortalAnswer::RemoteDesktop { .. }
            | PortalAnswer::InputCapture
            | PortalAnswer::DynamicLauncher { .. }
            | PortalAnswer::ScreenCast { .. }
            | PortalAnswer::Screenshot { .. }
            | PortalAnswer::ScreenshotWindow { .. }
            | PortalAnswer::ScreenshotBrowserWindow { .. }
            | PortalAnswer::PickColor { .. }
            | PortalAnswer::Agent { .. }
            | PortalAnswer::Change
            | PortalAnswer::GlobalShortcuts { .. }
            | PortalAnswer::Pressed
            | PortalAnswer::Released
            | PortalAnswer::Stop
            | PortalAnswer::Pause
            | PortalAnswer::Resume
            | PortalAnswer::Discard => Err(2),
        }
    }
}

impl Prepared {
    /// Keep `chosen` for `Print`. Returns its token.
    fn keep(&mut self, chosen: Chosen) -> u32 {
        self.last += 1;
        self.chosen.insert(self.last, chosen);
        self.last
    }

    /// The choice for `token`, once.
    fn take(&mut self, token: u32) -> Option<Chosen> {
        self.chosen.remove(&token)
    }
}

/// The dialog for `offered` and Save to PDF, each starting from `preset`, and
/// from the application's printer, else CUPS's default.
fn dialog(
    title: String,
    accept_label: Option<String>,
    offered: Offered,
    preset: &Preset,
    home: String,
) -> PrintDialog {
    let printers: Vec<Printer> = offered
        .printers
        .into_iter()
        .map(|printer| Printer {
            initial: preset.applied(&printer),
            ..printer
        })
        .collect();
    let printer = preset
        .printer
        .clone()
        .filter(|wanted| printers.iter().any(|printer| &printer.name == wanted))
        .or(offered.default);
    let pdf = save_to_pdf::printer();
    PrintDialog {
        title,
        accept_label,
        printers,
        printer,
        home,
        pdf: Printer {
            initial: preset.applied(&pdf),
            ..pdf
        },
    }
}

/// The string values of `map`. GTK writes every setting as one.
fn strings(map: &HashMap<String, OwnedValue>) -> HashMap<String, String> {
    map.iter()
        .filter_map(|(key, value)| {
            <&str>::try_from(value)
                .ok()
                .map(|text| (key.clone(), text.to_string()))
        })
        .collect()
}

/// GTK's settings for `chosen`. A file is GTK's own "Print to File".
fn settings_of(chosen: &Chosen) -> Vec<(&'static str, Value<'static>)> {
    let settings = match &chosen.destination {
        Destination::Printer(printer) => gtk_settings(printer, &chosen.options),
        Destination::File(path) => gtk_settings("Print to File", &chosen.options)
            .into_iter()
            .chain([
                ("output-uri", file_uri(&path.display().to_string())),
                ("output-file-format", "pdf".to_string()),
            ])
            .collect(),
    };
    settings
        .into_iter()
        .map(|(key, value)| (key, Value::from(value)))
        .collect()
}

/// Write `document` to `path`, if it is a PDF.
fn save_pdf(path: &std::path::Path, document: &[u8]) -> Result<(), String> {
    if document.starts_with(b"%PDF-") {
        std::fs::write(path, document).map_err(|why| format!("{}: {why}", path.display()))
    } else {
        Err(format!("not a PDF for {}", path.display()))
    }
}

/// GTK's page setup for `options`; none when its paper is unknown.
fn page_setup_of(options: &PrintOptions) -> Vec<(&'static str, Value<'static>)> {
    page_setup(options)
        .map(|setup| {
            [
                Some(("Name", Value::from(setup.name))),
                Some(("DisplayName", Value::from(setup.display_name))),
                Some(("Width", Value::from(setup.width_mm))),
                Some(("Height", Value::from(setup.height_mm))),
                setup
                    .orientation
                    .map(|orientation| ("Orientation", Value::from(orientation))),
            ]
            .into_iter()
            .flatten()
            .collect()
        })
        .unwrap_or_default()
}

/// The application's `given` dictionary with `chosen` laid over it, so keys
/// this does not know go back as they came.
fn dictionary(
    mut given: HashMap<String, OwnedValue>,
    chosen: Vec<(&'static str, Value<'static>)>,
) -> OwnedValue {
    for (key, value) in chosen {
        given.insert(
            key.to_string(),
            OwnedValue::try_from(value).expect("a setting holds no file descriptor"),
        );
    }
    OwnedValue::try_from(Value::from(given)).expect("the application's own values are ownable")
}

/// Run `work` on its own thread, so a slow CUPS or document does not hold up
/// the bus.
async fn off_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (replier, reply) = reply();
    thread::spawn(move || replier.send(work()));
    reply.await.expect("the work finished")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc::{channel, Receiver};
    use std::thread;
    use std::time::Duration;

    use domicile_host::cups::Endpoint;
    use domicile_host::ipp::{self, Attribute, Group, Message, Value};
    use domicile_protocol::{PortalAnswer, PortalKind, PortalRequest, PrintDialog};
    use zbus::zvariant::{ObjectPath, Value as Variant};

    use super::super::socket_pair;
    use super::super::OBJECT_PATH;

    const PRINT: &str = "org.freedesktop.impl.portal.Print";

    type Results = HashMap<String, OwnedValue>;

    /// A job CUPS took: its attributes and document.
    type Job = (Group, Vec<u8>);

    /// The backend on a socket pair, with CUPS at `endpoints`.
    struct Served {
        client: zbus::blocking::Connection,
        queue: Arc<Queue>,
        published: Receiver<Vec<PortalRequest>>,
        _server: zbus::blocking::Connection,
    }

    fn served(endpoints: Vec<Endpoint>) -> Served {
        let queue = Arc::new(Queue::default());
        let (publish, published) = channel();
        queue.listen(
            move |items, _| {
                let _ = publish.send(items);
            },
            || true,
            |_| None,
        );
        let serving = Arc::clone(&queue);
        let (server, client) = socket_pair::connected(move |builder| {
            builder
                .serve_at(
                    OBJECT_PATH,
                    Print {
                        queue: serving,
                        cups: Cups::new(endpoints, "me".into()),
                        home: "/home/me".into(),
                        prepared: Mutex::default(),
                    },
                )
                .expect("the interface registered")
        });
        Served {
            client,
            queue,
            published,
            _server: server,
        }
    }

    /// CUPS with one printer, `office`, taking A4 or Letter, Letter by
    /// default. It answers `Print-Job` with `job_status`, and hands each job
    /// over.
    fn fake_cups(job_status: u16) -> (Endpoint, Receiver<Job>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("a directory");
        let socket = dir.path().join("cups.sock");
        let listener = UnixListener::bind(&socket).expect("the socket bound");
        let (take, taken) = channel();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.expect("a connection");
                let (request, data) = request(&mut stream);
                let (status, groups) = match request.code {
                    0x4001 | 0x4002 => (0, vec![office(Vec::new())]),
                    0x000b => (
                        0,
                        vec![office(vec![
                            Attribute::new(
                                "media-supported",
                                vec![
                                    Value::Keyword("iso_a4_210x297mm".into()),
                                    Value::Keyword("na_letter_8.5x11in".into()),
                                ],
                            ),
                            Attribute::new(
                                "media-default",
                                vec![Value::Keyword("na_letter_8.5x11in".into())],
                            ),
                            Attribute::new(
                                "copies-supported",
                                vec![Value::Range { lower: 1, upper: 9 }],
                            ),
                        ])],
                    ),
                    0x0002 => {
                        let job = request.groups(ipp::JOB).next().cloned();
                        let _ = take.send((job.expect("job attributes"), data));
                        (job_status, Vec::new())
                    }
                    other => panic!("an operation CUPS was not asked: {other:#x}"),
                };
                let body = Message {
                    code: status,
                    request_id: request.request_id,
                    groups: std::iter::once(Group {
                        tag: ipp::OPERATION,
                        attributes: Vec::new(),
                    })
                    .chain(groups)
                    .collect(),
                }
                .encoded(&[]);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (Endpoint::Socket(socket), taken, dir)
    }

    fn office(more: Vec<Attribute>) -> Group {
        let mut attributes = vec![Attribute::new(
            "printer-name",
            vec![Value::Name("office".into())],
        )];
        attributes.extend(more);
        Group {
            tag: ipp::PRINTER,
            attributes,
        }
    }

    /// The IPP request in one HTTP request, and the data after it.
    fn request(stream: &mut std::os::unix::net::UnixStream) -> (Message, Vec<u8>) {
        let mut reader = BufReader::new(stream);
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let (message, data) = Message::decoded(&body).expect("an IPP request");
        (message, data.to_vec())
    }

    fn strings(pairs: &[(&str, &str)]) -> Results {
        pairs
            .iter()
            .map(|(key, value)| {
                (
                    key.to_string(),
                    OwnedValue::try_from(Variant::from(*value)).expect("ownable"),
                )
            })
            .collect()
    }

    /// Call `PreparePrint` from another thread.
    fn prepare(served: &Served, settings: Results) -> thread::JoinHandle<(u32, Results)> {
        let client = served.client.clone();
        thread::spawn(move || {
            client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some(PRINT),
                    "PreparePrint",
                    &(
                        ObjectPath::try_from("/r/1").expect("a path"),
                        "org.example.Editor",
                        "",
                        "Report",
                        settings,
                        strings(&[]),
                        strings(&[("accept_label", "Print it")]),
                    ),
                )
                .expect("PreparePrint answered")
                .body()
                .deserialize()
                .expect("its reply")
        })
    }

    /// Call `Print` from another thread with `document` and `options`.
    fn print(
        served: &Served,
        document: &[u8],
        options: Results,
    ) -> thread::JoinHandle<(u32, Results)> {
        let client = served.client.clone();
        let (read, mut write) = std::io::pipe().expect("a pipe");
        write
            .write_all(document)
            .expect("the document fits the pipe");
        drop(write);
        thread::spawn(move || {
            client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some(PRINT),
                    "Print",
                    &(
                        ObjectPath::try_from("/r/2").expect("a path"),
                        "org.example.Editor",
                        "",
                        "Report",
                        zbus::zvariant::Fd::from(&std::os::fd::OwnedFd::from(read)),
                        options,
                    ),
                )
                .expect("Print answered")
                .body()
                .deserialize()
                .expect("its reply")
        })
    }

    #[track_caller]
    fn asked(served: &Served) -> PrintDialog {
        let published = served
            .published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published");
        match published.as_slice() {
            [PortalRequest {
                kind: PortalKind::Print(dialog),
                ..
            }] => dialog.clone(),
            other => panic!("not one print dialog: {other:?}"),
        }
    }

    fn two_copies(dialog: &PrintDialog) -> PortalAnswer {
        PortalAnswer::Print {
            printer: "office".into(),
            options: PrintOptions {
                copies: 2,
                ..dialog.printers[0].initial.clone()
            },
        }
    }

    fn dict(results: &Results, key: &str) -> HashMap<String, OwnedValue> {
        results
            .get(key)
            .expect(key)
            .try_clone()
            .expect("cloned")
            .try_into()
            .expect("a dictionary")
    }

    fn text(dict: &HashMap<String, OwnedValue>, key: &str) -> String {
        dict.get(key)
            .expect(key)
            .try_clone()
            .expect("cloned")
            .try_into()
            .expect("a string")
    }

    #[test]
    fn a_prepared_job_prints_with_its_token_and_no_second_dialog() {
        let (cups, jobs, _dir) = fake_cups(0);
        let served = served(vec![cups]);
        let preparing = prepare(
            &served,
            strings(&[("paper-format", "iso_a4"), ("app-own-key", "kept")]),
        );

        let dialog = asked(&served);
        assert_eq!(dialog.title, "Report");
        assert_eq!(dialog.accept_label.as_deref(), Some("Print it"));
        assert_eq!(dialog.printer.as_deref(), Some("office"));
        assert_eq!(
            dialog.printers[0].initial.media.as_deref(),
            Some("iso_a4_210x297mm"),
            "the application's paper"
        );
        served.queue.answer(1, two_copies(&dialog));

        let (response, results) = preparing.join().expect("the call returned");
        assert_eq!(response, 0);
        let settings = dict(&results, "settings");
        assert_eq!(text(&settings, "n-copies"), "2");
        assert_eq!(text(&settings, "printer"), "office");
        assert_eq!(text(&settings, "app-own-key"), "kept");
        assert_eq!(text(&dict(&results, "page-setup"), "Name"), "iso_a4");
        let token = u32::try_from(results.get("token").expect("a token")).expect("a u32");
        assert_eq!(
            served.published.recv_timeout(Duration::from_secs(10)),
            Ok(Vec::new()),
            "the dialog went"
        );

        let printing = print(
            &served,
            b"%PDF-1.7",
            HashMap::from([("token".to_string(), OwnedValue::from(token))]),
        );

        assert_eq!(
            printing.join().expect("the call returned"),
            (0, Results::new())
        );
        let (job, document) = jobs.recv().expect("CUPS took the job");
        assert_eq!(document, b"%PDF-1.7");
        assert_eq!(job.values("copies"), [Value::Integer(2)]);
        assert!(served.published.try_recv().is_err(), "no second dialog");
    }

    #[test]
    fn a_print_without_a_token_asks_first() {
        let (cups, jobs, _dir) = fake_cups(0);
        let served = served(vec![cups]);
        let printing = print(&served, b"%!PS", Results::new());

        let dialog = asked(&served);
        assert_eq!(
            dialog.printers[0].initial.media.as_deref(),
            Some("na_letter_8.5x11in")
        );
        served.queue.answer(1, two_copies(&dialog));

        assert_eq!(printing.join().expect("the call returned").0, 0);
        assert_eq!(jobs.recv().expect("CUPS took the job").1, b"%!PS");
    }

    #[test]
    fn with_no_cups_the_dialog_offers_only_a_pdf() {
        let dir = tempfile::tempdir().expect("a directory");
        let served = served(vec![Endpoint::Socket(dir.path().join("cups.sock"))]);
        let printing = print(&served, b"%PDF", Results::new());

        let dialog = asked(&served);
        assert_eq!(dialog.printers, []);
        assert_eq!(dialog.pdf.description.as_deref(), Some("Save to PDF"));
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(printing.join().expect("the call returned").0, 1);
    }

    #[test]
    fn a_prepared_pdf_is_written_to_its_file_and_not_to_cups() {
        let (cups, jobs, _cups_dir) = fake_cups(0);
        let served = served(vec![cups]);
        let dir = tempfile::tempdir().expect("a directory");
        let path = dir.path().join("My Report.pdf");
        let preparing = prepare(&served, strings(&[("paper-format", "iso_a4")]));

        let dialog = asked(&served);
        assert_eq!(dialog.home, "/home/me");
        assert_eq!(
            dialog.pdf.initial.media.as_deref(),
            Some("iso_a4_210x297mm"),
            "the application's paper"
        );
        served.queue.answer(
            1,
            PortalAnswer::SaveToPdf {
                path: path.display().to_string(),
                options: dialog.pdf.initial.clone(),
            },
        );

        let (response, results) = preparing.join().expect("the call returned");
        assert_eq!(response, 0);
        let settings = dict(&results, "settings");
        assert_eq!(text(&settings, "printer"), "Print to File");
        assert_eq!(text(&settings, "output-file-format"), "pdf");
        assert_eq!(
            text(&settings, "output-uri"),
            format!("file://{}/My%20Report.pdf", dir.path().display())
        );
        let token = u32::try_from(results.get("token").expect("a token")).expect("a u32");

        let printing = print(
            &served,
            b"%PDF-1.7",
            HashMap::from([("token".to_string(), OwnedValue::from(token))]),
        );

        assert_eq!(
            printing.join().expect("the call returned"),
            (0, Results::new())
        );
        assert_eq!(std::fs::read(&path).expect("the file"), b"%PDF-1.7");
        assert!(jobs.try_recv().is_err(), "no print job");
    }

    #[test]
    fn a_document_that_is_not_a_pdf_is_not_saved_as_one() {
        let (cups, _jobs, _cups_dir) = fake_cups(0);
        let served = served(vec![cups]);
        let dir = tempfile::tempdir().expect("a directory");
        let path = dir.path().join("Report.pdf");
        let printing = print(&served, b"%!PS", Results::new());
        let dialog = asked(&served);
        served.queue.answer(
            1,
            PortalAnswer::SaveToPdf {
                path: path.display().to_string(),
                options: dialog.pdf.initial,
            },
        );

        assert_eq!(printing.join().expect("the call returned").0, 2);
        assert!(!path.exists());
    }

    #[test]
    fn a_job_cups_refuses_fails() {
        let (cups, _jobs, _dir) = fake_cups(0x0400);
        let served = served(vec![cups]);
        let printing = print(&served, b"%PDF", Results::new());
        let dialog = asked(&served);
        served.queue.answer(1, two_copies(&dialog));

        assert_eq!(printing.join().expect("the call returned").0, 2);
    }

    #[test]
    fn a_dismissed_dialog_is_canceled() {
        let (cups, _jobs, _dir) = fake_cups(0);
        let served = served(vec![cups]);
        let preparing = prepare(&served, Results::new());
        asked(&served);
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(
            preparing.join().expect("the call returned"),
            (1, Results::new())
        );
    }
}

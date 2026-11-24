//! The connections `domicile subscribe` holds open: each hears its topics'
//! answers at once, then again whenever one changes. See
//! [`ChromeMessage::Watch`](domicile_protocol::ChromeMessage::Watch).
//!
//! Nothing says when a list changed, so [`Watchers::tell`] asks again after
//! every message the desk sends its chromes, and after the engine lists the
//! input devices, and sends a topic's answer only when it differs from the
//! one that watcher last heard. With no watcher it does nothing.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use domicile_host::ipc::to_line;
use domicile_protocol::{HostMessage, WatchTopic};

/// One watching connection.
struct Watcher {
    writer: Arc<Mutex<UnixStream>>,
    /// Each topic it watches, and the answer it last heard, if any.
    heard: BTreeMap<WatchTopic, Option<HostMessage>>,
}

/// Every watching connection. Shared by the chrome connection threads, which
/// add them, and whatever calls [`Watchers::tell`].
#[derive(Default)]
pub struct Watchers {
    watchers: Mutex<Vec<Watcher>>,
}

impl Watchers {
    /// Start telling the connection on `writer` about `topics`. Hears nothing
    /// until the next [`Watchers::tell`], which hears every topic.
    pub fn watch(&self, writer: Arc<Mutex<UnixStream>>, topics: &[WatchTopic]) {
        let mut watchers = self.watchers.lock().unwrap();
        // A second `watch` on one connection adds to what it watches.
        let watcher = match watchers
            .iter_mut()
            .position(|watcher| Arc::ptr_eq(&watcher.writer, &writer))
        {
            Some(index) => &mut watchers[index],
            None => {
                watchers.push(Watcher {
                    writer,
                    heard: BTreeMap::new(),
                });
                watchers.last_mut().expect("just pushed")
            }
        };
        for topic in topics {
            watcher.heard.entry(*topic).or_insert(None);
        }
    }

    /// Stop telling the connection on `writer` anything, as when it closes.
    pub fn forget(&self, writer: &Arc<Mutex<UnixStream>>) {
        self.watchers
            .lock()
            .unwrap()
            .retain(|watcher| !Arc::ptr_eq(&watcher.writer, writer));
    }

    /// Send each watcher every topic whose answer, from `answer`, differs
    /// from the one it last heard. A watcher whose connection is gone is
    /// dropped.
    ///
    /// `answer` is asked at most once per topic.
    pub fn tell(&self, answer: impl Fn(WatchTopic) -> HostMessage) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.is_empty() {
            return;
        }
        let mut answers: BTreeMap<WatchTopic, HostMessage> = BTreeMap::new();
        watchers.retain_mut(|watcher| {
            let mut stream = watcher.writer.lock().unwrap();
            for (topic, heard) in &mut watcher.heard {
                let now = answers.entry(*topic).or_insert_with(|| answer(*topic));
                if heard.as_ref() == Some(now) {
                    continue;
                }
                if stream
                    .write_all(to_line(now).as_bytes())
                    .and_then(|()| stream.flush())
                    .is_err()
                {
                    return false;
                }
                *heard = Some(now.clone());
            }
            true
        });
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader};
    use std::time::Duration;

    use domicile_protocol::HostMessage;

    use super::*;

    fn connection() -> (Arc<Mutex<UnixStream>>, BufReader<UnixStream>) {
        let (ours, theirs) = UnixStream::pair().expect("a socket pair");
        theirs
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("a timeout");
        (Arc::new(Mutex::new(ours)), BufReader::new(theirs))
    }

    fn lines(reader: &mut BufReader<UnixStream>) -> Vec<String> {
        let mut heard = Vec::new();
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|read| read > 0) {
            heard.push(line.trim().to_string());
            line.clear();
        }
        heard
    }

    fn windows(count: usize) -> HostMessage {
        HostMessage::WindowList {
            windows: Vec::with_capacity(count),
        }
    }

    #[test]
    fn a_watcher_hears_its_topics_at_once_then_only_changes() {
        let watchers = Watchers::default();
        let (writer, mut reader) = connection();
        watchers.watch(writer, &[WatchTopic::Windows, WatchTopic::Inputs]);

        let inputs = || HostMessage::InputList { inputs: Vec::new() };
        let answer = |topic| match topic {
            WatchTopic::Windows => windows(0),
            WatchTopic::Inputs => inputs(),
            other => panic!("{other:?} is not watched"),
        };
        watchers.tell(answer);
        watchers.tell(answer);

        assert_eq!(
            lines(&mut reader),
            vec![to_line(&windows(0)).trim(), to_line(&inputs()).trim()]
        );
    }

    #[test]
    fn a_changed_answer_is_sent_again() {
        let watchers = Watchers::default();
        let (writer, mut reader) = connection();
        watchers.watch(writer, &[WatchTopic::Status]);
        let theme = |theme| HostMessage::Theme { theme };

        watchers.tell(|_| theme(domicile_protocol::Theme::Light));
        watchers.tell(|_| theme(domicile_protocol::Theme::Dark));

        assert_eq!(lines(&mut reader).len(), 2);
    }

    #[test]
    fn a_closed_watcher_is_dropped() {
        let watchers = Watchers::default();
        let (writer, reader) = connection();
        watchers.watch(writer, &[WatchTopic::Windows]);
        drop(reader);

        watchers.tell(|_| windows(0));

        assert!(watchers.watchers.lock().unwrap().is_empty());
    }

    #[test]
    fn a_forgotten_watcher_hears_nothing() {
        let watchers = Watchers::default();
        let (writer, mut reader) = connection();
        watchers.watch(writer.clone(), &[WatchTopic::Windows]);
        watchers.forget(&writer);

        watchers.tell(|_| windows(0));

        assert!(lines(&mut reader).is_empty());
    }
}

//! Agents, such as one connected through `domicile mcp`, asking to see and
//! use the desk, as `SystemRequest::Agent` describes.
//!
//! The shell asks the user with a [`PortalKind::Agent`] dialog: the whole
//! desk, or only some windows. An agent let in is listed as a
//! [`CapturingKind::Agent`], with what it did last, until its caller lets
//! go or the shell stops it. The shell's [`PortalAnswer::Change`] asks the
//! user again.
//!
//! An agent the user let reach the whole desk and asked to remember is let
//! in without asking, until forgotten. Remembered agents are kept in
//! `$XDG_STATE_HOME/domicile/agents.json`.
//!
//! Domicile's own, not a portal's: no application asks over D-Bus. See
//! `docs/AGENTS.md`.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread;
use std::time::Duration;

use domicile_host::system::{AgentChanged, AgentLease, AgentStopped, AgentTold, LetIn};
use domicile_protocol::{
    AgentAction, AgentDialog, AgentReach, AgentSession, AgentWindow, CapturingKind, ConnectedAgent,
    KnownAgents, ListedWindow, PortalAnswer, PortalKind, RememberedAgent, SystemError,
    SystemErrorKind, AGENT_ACTIONS,
};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use super::queue::{ask_noting, Queue};

/// How long the user has to answer before the ask counts as canceled.
pub const PATIENCE: Duration = Duration::from_secs(60);

/// The app id an agent's dialog and session go under: none, since the agent
/// is not an application the desk knows. The shell names it by its body.
const NO_APP: &str = "";

/// The windows open now, as `list-windows` lists them.
pub type OpenWindows = Arc<dyn Fn() -> Vec<ListedWindow> + Send + Sync>;

/// The time in milliseconds since the Unix epoch.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Where remembered agents live, from `XDG_STATE_HOME` and `HOME`. `None`
/// without either, and then they last as long as the compositor.
pub fn path(state_home: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    state_home
        .or_else(|| home.map(|home| home.join(".local/state")))
        .map(|state| state.join("domicile/agents.json"))
}

/// Whether apps build accessibility trees: AT-SPI's `IsEnabled`, which Qt,
/// Firefox and others wait on before they expose anything. The door turns it
/// on while an agent is in, so the agent can read those apps as text.
pub struct Accessibility {
    pub enabled: Box<dyn Fn() -> bool + Send + Sync>,
    pub enable: Box<dyn Fn(bool) + Send + Sync>,
}

/// Every agent the desk lets in: those in now, and those remembered.
pub struct Door {
    queue: Arc<Queue>,
    clock: Clock,
    patience: Duration,
    remembered: Mutex<Remembered>,
    /// Each agent in now, by its session's id, oldest first.
    connected: Mutex<Vec<(u32, Arc<Mutex<AgentSession>>)>>,
    /// Agents the user stopped since they last answered its dialog: each
    /// asks next time, remembered or not, so a stop holds until they say.
    stopped: Mutex<HashSet<String>>,
    accessibility: Accessibility,
    /// Whether the door turned accessibility on, to turn it off once the
    /// last agent goes. Left alone if the user had it on.
    turned_on: Mutex<bool>,
}

impl Door {
    /// Agents asked about through `queue`, given `patience` to answer, and
    /// remembered at `path`. `clock` times their actions. `accessibility` is
    /// on while any is in.
    pub fn new(
        queue: Arc<Queue>,
        path: Option<PathBuf>,
        clock: Clock,
        patience: Duration,
        accessibility: Accessibility,
    ) -> Arc<Door> {
        Arc::new(Door {
            queue,
            clock,
            patience,
            remembered: Mutex::new(Remembered::load(path)),
            connected: Mutex::new(Vec::new()),
            stopped: Mutex::new(HashSet::new()),
            accessibility,
            turned_on: Mutex::new(false),
        })
    }

    /// Lets `agent` in: at once when it is remembered, else when the user
    /// allows it, offering `windows` but private browser windows. Blocks
    /// until the user answers, or the patience passes.
    pub fn let_in(
        self: &Arc<Self>,
        agent: String,
        windows: OpenWindows,
        told: AgentTold,
    ) -> Result<LetIn, SystemError> {
        let stopped = self.stopped.lock().unwrap().contains(&agent);
        let remembered = !stopped && self.remembered.lock().unwrap().has(&agent);
        let (reach, remember) = if remembered {
            (AgentReach::Desk, true)
        } else {
            let offered = offered(windows());
            let kind = PortalKind::Agent(AgentDialog {
                agent: agent.clone(),
                windows: offered.clone(),
                current: None,
                remembered: false,
            });
            match asked(&self.queue, kind, self.patience) {
                PortalAnswer::Agent { reach, remember } => {
                    let reach = offered_only(reach, &offered)?;
                    self.stopped.lock().unwrap().remove(&agent);
                    (reach, remember)
                }
                PortalAnswer::Canceled => return Err(canceled("the user did not let it in")),
                PortalAnswer::Refused => return Err(canceled(
                    "nobody answered: no shell showed the dialog, or the user left it for a minute",
                )),
                answer => unreachable!("the queue gives an agent's dialog no {answer:?}"),
            }
        };
        if remember {
            self.remembered.lock().unwrap().used(&agent, (self.clock)());
        }
        debug!(%agent, ?reach, remembered, "an agent was let in");
        let session = Arc::new(Mutex::new(AgentSession {
            agent: agent.clone(),
            reach: reach.clone(),
            actions: Vec::new(),
        }));
        let listed = Arc::new(OnceLock::new());
        let control = Controls {
            door: Arc::downgrade(self),
            listed: listed.clone(),
            agent,
            session: session.clone(),
            windows,
            stopped: Mutex::new(Some(told.stopped)),
            changed: Arc::new(told.changed),
            changing: Arc::new(AtomicBool::new(false)),
        };
        let id = self.queue.begin_controlled(
            NO_APP.into(),
            CapturingKind::Agent(session.lock().unwrap().clone()),
            move |answer| control.take(answer),
        );
        listed.set(id).expect("a session is listed once");
        let mut connected = self.connected.lock().unwrap();
        connected.push((id, Arc::clone(&session)));
        if connected.len() == 1 && !(self.accessibility.enabled)() {
            (self.accessibility.enable)(true);
            *self.turned_on.lock().unwrap() = true;
        }
        drop(connected);
        Ok(LetIn {
            reach,
            lease: Box::new(Lease {
                id,
                door: Arc::clone(self),
                session,
            }),
        })
    }

    /// The agents in now, and those remembered.
    pub fn known(&self) -> KnownAgents {
        KnownAgents {
            connected: self
                .connected
                .lock()
                .unwrap()
                .iter()
                .map(|(id, session)| {
                    let session = session.lock().unwrap();
                    ConnectedAgent {
                        session: *id,
                        agent: session.agent.clone(),
                        reach: session.reach.clone(),
                    }
                })
                .collect(),
            remembered: self.remembered.lock().unwrap().agents.clone(),
        }
    }

    /// Ends agent session `session`, as the shell's stop does.
    pub fn stop(&self, session: u32) -> Result<(), SystemError> {
        let known = self
            .connected
            .lock()
            .unwrap()
            .iter()
            .any(|(id, _)| *id == session);
        if !known {
            return Err(SystemError {
                kind: SystemErrorKind::NotFound,
                message: format!("no agent is in as session {session}"),
            });
        }
        // Outside the lock: the stop drops the lease, which takes it off.
        self.queue.answer(session, PortalAnswer::Stop);
        Ok(())
    }

    /// Makes `agent` ask again next time.
    pub fn forget(&self, agent: &str) {
        self.remembered.lock().unwrap().forget(agent);
    }

    /// Asks the user again what agent session `id` may reach, unless they
    /// are being asked already.
    fn change(self: Arc<Self>, id: u32, controls: &Controls) {
        if controls.changing.swap(true, Ordering::SeqCst) {
            return;
        }
        let (agent, session, windows, changed, changing) = (
            controls.agent.clone(),
            controls.session.clone(),
            controls.windows.clone(),
            controls.changed.clone(),
            controls.changing.clone(),
        );
        thread::spawn(move || {
            let offered = offered(windows());
            let current = session.lock().unwrap().reach.clone();
            let remembered = self.remembered.lock().unwrap().has(&agent);
            let kind = PortalKind::Agent(AgentDialog {
                agent: agent.clone(),
                windows: offered.clone(),
                current: Some(current),
                remembered,
            });
            let answer = asked(&self.queue, kind, self.patience);
            changing.store(false, Ordering::SeqCst);
            // Canceled or unanswered, it keeps what it has.
            let PortalAnswer::Agent { reach, remember } = answer else {
                return;
            };
            let reach = match offered_only(reach, &offered) {
                Ok(reach) => reach,
                Err(why) => {
                    warn!(%agent, %why.message, "the shell changed an agent to a window it did not offer");
                    return;
                }
            };
            {
                let mut remembered = self.remembered.lock().unwrap();
                if remember {
                    remembered.used(&agent, (self.clock)());
                } else {
                    remembered.forget(&agent);
                }
            }
            let listed = {
                let mut session = session.lock().unwrap();
                session.reach = reach.clone();
                session.clone()
            };
            // Gone already when the agent left meanwhile.
            if self
                .queue
                .revise_session(id, move |kind| *kind = CapturingKind::Agent(listed))
                .is_ok()
            {
                debug!(%agent, ?reach, "an agent's reach was changed");
                changed(reach);
            }
        });
    }
}

/// What an agent's session takes from the shell.
struct Controls {
    door: Weak<Door>,
    /// The session's id, once listed.
    listed: Arc<OnceLock<u32>>,
    agent: String,
    session: Arc<Mutex<AgentSession>>,
    windows: OpenWindows,
    stopped: Mutex<Option<AgentStopped>>,
    changed: Arc<AgentChanged>,
    /// Whether the user is being asked to change it now.
    changing: Arc<AtomicBool>,
}

impl Controls {
    /// The shell's stop or change.
    fn take(&self, answer: &PortalAnswer) {
        match answer {
            PortalAnswer::Stop => {
                if let Some(door) = self.door.upgrade() {
                    door.stopped.lock().unwrap().insert(self.agent.clone());
                }
                if let Some(stopped) = self.stopped.lock().unwrap().take() {
                    stopped();
                }
            }
            PortalAnswer::Change => {
                if let (Some(door), Some(id)) = (self.door.upgrade(), self.listed.get()) {
                    door.change(*id, self);
                }
            }
            answer => unreachable!("the queue gives an agent's session no {answer:?}"),
        }
    }
}

/// `open` but private browser windows, as a dialog offers them.
fn offered(open: Vec<ListedWindow>) -> Vec<AgentWindow> {
    open.into_iter()
        .filter(|window| !window.private)
        .map(|window| AgentWindow {
            id: window.id,
            kind: window.kind,
            title: window.title,
            app: window.app,
        })
        .collect()
}

/// Puts `kind` to the shell and waits for its answer, withdrawing it after
/// `patience`, which answers [`PortalAnswer::Refused`].
fn asked(queue: &Arc<Queue>, kind: PortalKind, patience: Duration) -> PortalAnswer {
    let (answered, answer) = channel();
    let asking = Arc::clone(queue);
    let (submitted, id) = channel();
    thread::spawn(move || {
        let answer = zbus::block_on(ask_noting(&asking, NO_APP.into(), "", kind, |asked| {
            let _ = submitted.send(asked);
        }));
        let _ = answered.send(answer);
    });
    match answer.recv_timeout(patience) {
        Ok(answer) => answer,
        Err(_) => {
            // Answered meanwhile, the withdrawal is dropped and the answer
            // stands.
            if let Ok(id) = id.try_recv() {
                queue.withdraw(id);
            }
            answer.recv().unwrap_or(PortalAnswer::Refused)
        }
    }
}

/// `reach` with each window the dialog offered as offered, or why it is not
/// one the dialog offered.
fn offered_only(reach: AgentReach, offered: &[AgentWindow]) -> Result<AgentReach, SystemError> {
    match reach {
        AgentReach::Desk => Ok(AgentReach::Desk),
        AgentReach::Windows { windows } => windows
            .into_iter()
            .map(|picked| {
                offered
                    .iter()
                    .find(|window| window.id == picked.id)
                    .cloned()
                    .ok_or_else(|| SystemError {
                        kind: SystemErrorKind::InvalidInput,
                        message: format!("the shell picked {}, which was not offered", picked.id),
                    })
            })
            .collect::<Result<_, _>>()
            .map(|windows| AgentReach::Windows { windows }),
    }
}

fn canceled(why: &str) -> SystemError {
    SystemError {
        kind: SystemErrorKind::Canceled,
        message: why.into(),
    }
}

/// An agent's listing, which ends when dropped.
struct Lease {
    id: u32,
    door: Arc<Door>,
    session: Arc<Mutex<AgentSession>>,
}

impl AgentLease for Lease {
    fn did(&self, said: String) {
        let mut session = self.session.lock().unwrap();
        session.actions.insert(
            0,
            AgentAction {
                said,
                at_ms: (self.door.clock)(),
            },
        );
        session.actions.truncate(AGENT_ACTIONS);
        let listed = session.clone();
        // Gone already when the shell stopped it meanwhile.
        let _ = self.door.queue.revise_session(self.id, move |kind| {
            *kind = CapturingKind::Agent(listed);
        });
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut connected = self.door.connected.lock().unwrap();
        connected.retain(|(id, _)| *id != self.id);
        let mut turned_on = self.door.turned_on.lock().unwrap();
        if connected.is_empty() && *turned_on {
            (self.door.accessibility.enable)(false);
            *turned_on = false;
        }
        drop((connected, turned_on));
        self.door.queue.end(self.id);
    }
}

/// The agents let in without asking, as kept on disk.
struct Remembered {
    path: Option<PathBuf>,
    /// Most recently used first.
    agents: Vec<RememberedAgent>,
}

/// `agents.json`.
#[derive(Default, Serialize, Deserialize)]
struct Kept {
    agents: Vec<RememberedAgent>,
}

impl Remembered {
    /// The agents remembered at `path`. A file that cannot be read is logged
    /// and read as none, so each agent asks again.
    fn load(path: Option<PathBuf>) -> Remembered {
        let agents = path.as_deref().map(read).unwrap_or_default();
        Remembered { path, agents }
    }

    fn has(&self, agent: &str) -> bool {
        self.agents.iter().any(|kept| kept.agent == agent)
    }

    /// Remembers `agent`, as last used at `at_ms`.
    fn used(&mut self, agent: &str, at_ms: u64) {
        self.agents.retain(|kept| kept.agent != agent);
        self.agents.insert(
            0,
            RememberedAgent {
                agent: agent.into(),
                last_used_ms: at_ms,
            },
        );
        self.save();
    }

    fn forget(&mut self, agent: &str) {
        let before = self.agents.len();
        self.agents.retain(|kept| kept.agent != agent);
        if self.agents.len() != before {
            self.save();
        }
    }

    /// Writes them. A failure is logged: they are still remembered while the
    /// compositor runs.
    fn save(&self) {
        if let Some(path) = &self.path {
            if let Err(why) = write(path, &self.agents) {
                tracing::error!(%why, path = %path.display(), "could not save the remembered agents");
            }
        }
    }
}

fn read(path: &Path) -> Vec<RememberedAgent> {
    let parsed = fs::read(path)
        .map_err(|why| why.to_string())
        .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).map_err(|why| why.to_string()));
    match parsed {
        Ok(kept) => kept.agents,
        Err(why) => {
            if path.exists() {
                tracing::error!(%why, path = %path.display(), "remembered agents unreadable; each asks again");
            }
            Vec::new()
        }
    }
}

fn write(path: &Path, agents: &[RememberedAgent]) -> io::Result<()> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }
    let kept = Kept {
        agents: agents.to_vec(),
    };
    fs::write(path, serde_json::to_vec(&kept)?)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{channel, Receiver};

    use domicile_protocol::{Capturing, PortalRequest, WindowKind};

    use super::*;

    fn window(id: &str, private: bool) -> ListedWindow {
        ListedWindow {
            id: id.into(),
            kind: if private {
                WindowKind::Browser
            } else {
                WindowKind::Native
            },
            title: format!("{id}'s title"),
            app: None,
            pid: None,
            size: None,
            focused: false,
            urgent: false,
            url: None,
            private,
            engine_id: None,
            views: Vec::new(),
        }
    }

    fn offered(id: &str) -> AgentWindow {
        AgentWindow {
            id: id.into(),
            kind: WindowKind::Native,
            title: format!("{id}'s title"),
            app: None,
        }
    }

    /// What a queue publishes: its dialogs and its sessions.
    type Published = Receiver<(Vec<PortalRequest>, Vec<Capturing>)>;

    /// A door whose queue a shell listens to, what it publishes, and its
    /// clock's time.
    struct Desk {
        door: Arc<Door>,
        queue: Arc<Queue>,
        published: Published,
        /// Whether apps build accessibility trees, as the door left it.
        accessible: Arc<AtomicBool>,
    }

    /// Accessibility that starts `on`, kept in `accessible`.
    fn accessibility(on: bool, accessible: &Arc<AtomicBool>) -> Accessibility {
        accessible.store(on, Ordering::SeqCst);
        let (reads, writes) = (Arc::clone(accessible), Arc::clone(accessible));
        Accessibility {
            enabled: Box::new(move || reads.load(Ordering::SeqCst)),
            enable: Box::new(move |on| writes.store(on, Ordering::SeqCst)),
        }
    }

    fn desk(path: Option<PathBuf>, patience: Duration) -> Desk {
        desk_accessible(path, patience, false)
    }

    /// [`desk`], whose apps build accessibility trees already if `on`.
    fn desk_accessible(path: Option<PathBuf>, patience: Duration, on: bool) -> Desk {
        let accessible = Arc::new(AtomicBool::new(false));
        let queue = Arc::new(Queue::default());
        let (publish, published) = channel();
        queue.listen(
            move |items, capturing| {
                let _ = publish.send((items, capturing));
            },
            || true,
            |_| None,
        );
        Desk {
            door: Door::new(
                queue.clone(),
                path,
                Arc::new(|| 7),
                patience,
                accessibility(on, &accessible),
            ),
            queue,
            published,
            accessible,
        }
    }

    /// What the caller of a let-in heard: the stop and each change.
    struct Heard {
        stopped: Receiver<()>,
        changed: Receiver<AgentReach>,
    }

    fn told() -> (AgentTold, Heard) {
        let (stop, stopped) = channel();
        let (change, changed) = channel();
        let change = Mutex::new(change);
        (
            AgentTold {
                stopped: Box::new(move || stop.send(()).expect("the test listens")),
                changed: Box::new(move |reach| {
                    let _ = change.lock().unwrap().send(reach);
                }),
            },
            Heard { stopped, changed },
        )
    }

    /// The next dialog `desk` publishes.
    fn next_dialog(desk: &Desk) -> PortalRequest {
        loop {
            let (items, _) = desk.published.recv().expect("the dialog is published");
            if let Some(request) = items.into_iter().next() {
                break request;
            }
        }
    }

    /// The sessions `desk` published last.
    fn sessions(desk: &Desk) -> Vec<Capturing> {
        desk.published
            .try_iter()
            .last()
            .expect("the queue was published")
            .1
    }

    /// Lets `agent` in on a thread with `open` windows, and answers its
    /// dialog with `answer` once it is up.
    fn let_in_answering(
        desk: &Desk,
        open: Vec<ListedWindow>,
        answer: impl FnOnce(&PortalRequest) -> PortalAnswer,
    ) -> (Result<LetIn, SystemError>, Heard) {
        let (told, heard) = told();
        let door = Arc::clone(&desk.door);
        let letting = thread::spawn(move || {
            door.let_in("Claude Code".into(), Arc::new(move || open.clone()), told)
        });
        let request = next_dialog(desk);
        desk.queue.answer(request.id, answer(&request));
        (letting.join().expect("letting in does not panic"), heard)
    }

    fn allow(reach: AgentReach) -> PortalAnswer {
        PortalAnswer::Agent {
            reach,
            remember: false,
        }
    }

    #[test]
    fn the_dialog_offers_every_window_but_private_ones() {
        let desk = desk(None, PATIENCE);
        let (let_in, _) = let_in_answering(
            &desk,
            vec![window("a", false), window("b", true), window("c", false)],
            |request| {
                assert_eq!(
                    request.kind,
                    PortalKind::Agent(AgentDialog {
                        agent: "Claude Code".into(),
                        windows: vec![offered("a"), offered("c")],
                        current: None,
                        remembered: false,
                    })
                );
                PortalAnswer::Canceled
            },
        );
        assert_eq!(
            let_in.err().map(|error| error.kind),
            Some(SystemErrorKind::Canceled)
        );
    }

    #[test]
    fn an_agent_let_in_is_listed_with_what_it_did_until_its_lease_drops() {
        let desk = desk(None, PATIENCE);
        let (let_in, _) = let_in_answering(&desk, vec![window("a", false)], |_| {
            allow(AgentReach::Windows {
                windows: vec![offered("a")],
            })
        });
        let let_in = let_in.expect("the user let it in");
        assert_eq!(
            let_in.reach,
            AgentReach::Windows {
                windows: vec![offered("a")]
            }
        );
        let_in.lease.did("Clicked \"Save\" in Notes".into());
        assert_eq!(
            sessions(&desk)[0].kind,
            CapturingKind::Agent(AgentSession {
                agent: "Claude Code".into(),
                reach: let_in.reach.clone(),
                actions: vec![AgentAction {
                    said: "Clicked \"Save\" in Notes".into(),
                    at_ms: 7,
                }],
            })
        );
        assert_eq!(desk.door.known().connected.len(), 1);
        drop(let_in.lease);
        assert!(sessions(&desk).is_empty());
        assert!(desk.door.known().connected.is_empty());
    }

    #[test]
    fn apps_build_accessibility_trees_while_an_agent_is_in() {
        let desk = desk(None, PATIENCE);
        let (first, _) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        assert!(desk.accessible.load(Ordering::SeqCst));
        let (second, _) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        drop(first.expect("let in").lease);
        assert!(
            desk.accessible.load(Ordering::SeqCst),
            "one agent is in still"
        );
        drop(second.expect("let in").lease);
        assert!(!desk.accessible.load(Ordering::SeqCst));
    }

    #[test]
    fn accessibility_the_user_turned_on_stays_on_after_the_agents() {
        let desk = desk_accessible(None, PATIENCE, true);
        let (let_in, _) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        drop(let_in.expect("let in").lease);
        assert!(desk.accessible.load(Ordering::SeqCst));
    }

    #[test]
    fn an_agent_lists_only_its_last_few_actions() {
        let desk = desk(None, PATIENCE);
        let (let_in, _) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        let let_in = let_in.expect("the user let it in");
        for done in 0..AGENT_ACTIONS + 2 {
            let_in.lease.did(format!("did {done}"));
        }
        let CapturingKind::Agent(session) = &sessions(&desk)[0].kind else {
            panic!("an agent's session is listed");
        };
        assert_eq!(session.actions.len(), AGENT_ACTIONS);
        assert_eq!(
            session.actions[0].said,
            format!("did {}", AGENT_ACTIONS + 1)
        );
    }

    #[test]
    fn the_shell_stopping_an_agent_tells_its_caller() {
        let desk = desk(None, PATIENCE);
        let (let_in, heard) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        let _let_in = let_in.expect("the user let it in");
        let id = sessions(&desk)[0].id;
        desk.queue.answer(id, PortalAnswer::Stop);
        assert_eq!(heard.stopped.try_recv(), Ok(()));
    }

    #[test]
    fn settings_stopping_an_agent_tells_its_caller() {
        let desk = desk(None, PATIENCE);
        let (let_in, heard) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        let _let_in = let_in.expect("the user let it in");
        let session = desk.door.known().connected[0].session;
        desk.door.stop(session).expect("it is in");
        assert_eq!(heard.stopped.try_recv(), Ok(()));
        assert_eq!(
            desk.door.stop(session + 1).err().map(|error| error.kind),
            Some(SystemErrorKind::NotFound)
        );
    }

    #[test]
    fn a_window_the_dialog_did_not_offer_is_refused() {
        let desk = desk(None, PATIENCE);
        let (let_in, _) = let_in_answering(&desk, vec![window("a", false)], |_| {
            allow(AgentReach::Windows {
                windows: vec![offered("z")],
            })
        });
        assert_eq!(
            let_in.err().map(|error| error.kind),
            Some(SystemErrorKind::InvalidInput)
        );
    }

    #[test]
    fn a_dialog_nobody_answers_is_withdrawn_and_canceled() {
        let desk = desk(None, Duration::from_millis(50));
        let (told_it, _) = told();
        let refused = desk
            .door
            .let_in("Claude Code".into(), Arc::new(Vec::new), told_it);
        assert_eq!(
            refused.err().map(|error| error.kind),
            Some(SystemErrorKind::Canceled)
        );
        let (items, _) = desk
            .published
            .try_iter()
            .last()
            .expect("the queue was published");
        assert!(items.is_empty(), "{items:?}");
    }

    #[test]
    fn a_remembered_agent_comes_in_without_asking_until_forgotten() {
        let state = tempfile::tempdir().expect("a temporary directory");
        let path = state.path().join("domicile/agents.json");
        {
            let desk = desk(Some(path.clone()), PATIENCE);
            let (let_in, _) = let_in_answering(&desk, vec![], |_| PortalAnswer::Agent {
                reach: AgentReach::Desk,
                remember: true,
            });
            let_in.expect("the user let it in");
        }
        // A compositor started later reads it back.
        let desk = desk(Some(path.clone()), Duration::from_millis(50));
        assert_eq!(
            desk.door.known().remembered,
            vec![RememberedAgent {
                agent: "Claude Code".into(),
                last_used_ms: 7,
            }]
        );
        let (told_it, _) = told();
        let let_in = desk
            .door
            .let_in("Claude Code".into(), Arc::new(Vec::new), told_it)
            .expect("a remembered agent is let in");
        assert_eq!(let_in.reach, AgentReach::Desk);
        drop(let_in);

        desk.door.forget("Claude Code");

        assert!(desk.door.known().remembered.is_empty());
        let (told_it, _) = told();
        let asked = desk
            .door
            .let_in("Claude Code".into(), Arc::new(Vec::new), told_it);
        assert_eq!(
            asked.err().map(|error| error.kind),
            Some(SystemErrorKind::Canceled),
            "a forgotten agent asks again"
        );
        assert_eq!(
            fs::read_to_string(&path).expect("the file is kept"),
            r#"{"agents":[]}"#
        );
    }

    #[test]
    fn a_stopped_agent_asks_next_time_though_it_is_remembered() {
        let desk = desk(None, PATIENCE);
        let (let_in, heard) = let_in_answering(&desk, vec![], |_| PortalAnswer::Agent {
            reach: AgentReach::Desk,
            remember: true,
        });
        let let_in = let_in.expect("the user let it in");
        let session = desk.door.known().connected[0].session;
        desk.door.stop(session).expect("it is in");
        assert_eq!(heard.stopped.try_recv(), Ok(()));
        drop(let_in);

        // Still remembered, but the stop holds: it asks, and a refusal
        // leaves it asking.
        assert_eq!(desk.door.known().remembered.len(), 1);
        let (refused, _) = let_in_answering(&desk, vec![], |_| PortalAnswer::Canceled);
        assert_eq!(
            refused.err().map(|error| error.kind),
            Some(SystemErrorKind::Canceled)
        );
        let (let_in, _) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        drop(let_in.expect("the user let it in again"));

        // Once they let it in, it is remembered as before.
        let (told_it, _) = told();
        desk.door
            .let_in("Claude Code".into(), Arc::new(Vec::new), told_it)
            .expect("a remembered agent is let in without asking");
    }

    #[test]
    fn an_unreadable_file_remembers_nobody() {
        let state = tempfile::tempdir().expect("a temporary directory");
        let path = state.path().join("agents.json");
        fs::write(&path, "not json").expect("written");
        let desk = desk(Some(path), PATIENCE);
        assert!(desk.door.known().remembered.is_empty());
    }

    #[test]
    fn changing_an_agent_asks_again_and_tells_its_caller() {
        let desk = desk(None, PATIENCE);
        let (let_in, heard) =
            let_in_answering(&desk, vec![window("a", false)], |_| allow(AgentReach::Desk));
        let _let_in = let_in.expect("the user let it in");
        let id = sessions(&desk)[0].id;

        desk.queue.answer(id, PortalAnswer::Change);

        let request = next_dialog(&desk);
        let PortalKind::Agent(dialog) = &request.kind else {
            panic!("an agent's dialog, not {:?}", request.kind);
        };
        assert_eq!(dialog.current, Some(AgentReach::Desk));
        let narrowed = AgentReach::Windows {
            windows: vec![offered("a")],
        };
        desk.queue.answer(request.id, allow(narrowed.clone()));
        assert_eq!(
            heard.changed.recv_timeout(Duration::from_secs(5)),
            Ok(narrowed.clone())
        );
        assert_eq!(desk.door.known().connected[0].reach, narrowed);
    }

    #[test]
    fn canceling_a_change_keeps_what_it_has() {
        let desk = desk(None, PATIENCE);
        let (let_in, heard) = let_in_answering(&desk, vec![], |_| allow(AgentReach::Desk));
        let _let_in = let_in.expect("the user let it in");
        let id = sessions(&desk)[0].id;

        desk.queue.answer(id, PortalAnswer::Change);
        let request = next_dialog(&desk);
        desk.queue.answer(request.id, PortalAnswer::Canceled);

        assert!(heard
            .changed
            .recv_timeout(Duration::from_millis(200))
            .is_err());
        assert_eq!(desk.door.known().connected[0].reach, AgentReach::Desk);
    }

    #[test]
    fn narrowing_a_remembered_agent_forgets_it() {
        let desk = desk(None, PATIENCE);
        let (let_in, heard) =
            let_in_answering(&desk, vec![window("a", false)], |_| PortalAnswer::Agent {
                reach: AgentReach::Desk,
                remember: true,
            });
        let _let_in = let_in.expect("the user let it in");
        let id = sessions(&desk)[0].id;

        desk.queue.answer(id, PortalAnswer::Change);
        let request = next_dialog(&desk);
        let PortalKind::Agent(dialog) = &request.kind else {
            panic!("an agent's dialog");
        };
        assert!(dialog.remembered);
        desk.queue.answer(
            request.id,
            allow(AgentReach::Windows {
                windows: vec![offered("a")],
            }),
        );
        heard
            .changed
            .recv_timeout(Duration::from_secs(5))
            .expect("the change is told");

        assert!(desk.door.known().remembered.is_empty());
    }
}

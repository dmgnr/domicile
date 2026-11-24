//! The PipeWire thread: one producer stream per cast.
//!
//! Owns the PipeWire connection, each stream's negotiation and buffers, and
//! the links to each stream's node. It lends empty buffers to the Wayland
//! thread and queues the ones that come back filled. It never touches pixels.
//!
//! The connection is made on the first start, so a desktop without PipeWire
//! runs. A lost connection ends every stream; the next start reconnects.
//!
//! A cast that hears sound holds a sound node, which the producer links the
//! apps it hears into (see [`super::audio`]).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::os::fd::{AsFd as _, AsRawFd as _, OwnedFd};
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::context::ContextRc;
use pw::core::CoreRc;
use pw::main_loop::MainLoopRc;
use pw::properties::properties;
use pw::registry::RegistryRc;
use pw::spa;
use pw::stream::{StreamFlags, StreamListener, StreamRc, StreamState};
use pw::types::ObjectType;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::allocator::Buffer as _;
use smithay::reexports::calloop::channel::Sender;
use spa::pod::Pod;
use tracing::{debug, info, warn};

use crate::casting::audio::{self, Graph, Heard, Holders};
use crate::casting::cursor::{arrow, within, CursorMode, Plan, Sprite};
use crate::casting::lifecycle::{Ended, Lifecycle, Phase, Step};
use crate::casting::memory::Mapping;
use crate::casting::negotiation::{settle, shm_layout, Offered, Pixel, Settled};
use crate::casting::pacing::Rect;
use crate::casting::params::{
    audio_ports, buffers, enum_formats, fixated, metas, read_format, Memory,
};
use crate::casting::{Event, Listener, StreamId};
use crate::gbm::Gbm;
use crate::uploads::Shape;

/// A buffer of one stream, numbered as PipeWire adds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BufferId(pub u32);

/// What a stream's buffers hold, once negotiated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamFormat {
    pub pixel: Pixel,
    pub size: (u32, u32),
    /// The modifier of a dmabuf stream, `None` for shm.
    pub modifier: Option<u64>,
}

/// Where the Wayland thread writes a buffer's frame.
#[derive(Clone, Debug)]
pub enum Target {
    Shm(Arc<Mapping>),
    Dmabuf(Dmabuf),
}

/// A request from the Wayland thread.
pub enum ToPipewire {
    /// Make a stream offering `offered` at `size`, holding the sound node of
    /// what it `heard`, if anything.
    Start {
        stream: StreamId,
        offered: Vec<Offered>,
        size: (u32, u32),
        cursor: CursorMode,
        heard: Option<Heard>,
        listener: Listener,
    },
    /// The source's frames changed size: negotiate again.
    Resize { stream: StreamId, size: (u32, u32) },
    /// A lent buffer holds a frame. Queue it once `fence` signals.
    Filled {
        stream: StreamId,
        buffer: BufferId,
        damage: Vec<Rect>,
        cursor: Plan,
        /// The pointer's image, for cursor metadata over the source.
        sprite: Option<Arc<Sprite>>,
        fence: Option<OwnedFd>,
    },
    /// A frame came and no buffer was lent: lend any that are free.
    Starved { stream: StreamId },
    /// End the stream.
    End { stream: StreamId, why: Ended },
}

impl ToPipewire {
    /// The stream the request is for.
    pub fn stream(&self) -> StreamId {
        match self {
            Self::Start { stream, .. }
            | Self::Resize { stream, .. }
            | Self::Filled { stream, .. }
            | Self::Starved { stream }
            | Self::End { stream, .. } => *stream,
        }
    }
}

/// News for the Wayland thread.
pub enum ToWayland {
    /// The stream's buffers hold `format`. Frames of another size are dropped.
    Format {
        stream: StreamId,
        format: StreamFormat,
        framerate: u32,
    },
    Added {
        stream: StreamId,
        buffer: BufferId,
        target: Target,
    },
    Removed {
        stream: StreamId,
        buffer: BufferId,
    },
    /// Fill this buffer, then hand it back with [`ToPipewire::Filled`].
    Lent {
        stream: StreamId,
        buffer: BufferId,
    },
    /// The consumer wants its lent buffer filled whether or not anything
    /// changed. A Wayland capture client's `copy` asks this.
    Wanted {
        stream: StreamId,
    },
    /// Start or stop filling.
    Filling {
        stream: StreamId,
        on: bool,
    },
    /// The stream is gone; forget it.
    Ended {
        stream: StreamId,
    },
}

/// The most a fence wait holds the PipeWire thread. A GPU that takes longer
/// is hung, and the frame goes out as it is.
const FENCE_PATIENCE: Duration = Duration::from_millis(100);

/// Starts the PipeWire thread. `node` is the render node dmabufs are
/// allocated on; `None` offers shm only.
pub fn spawn(
    to_wayland: Sender<ToWayland>,
    node: Option<PathBuf>,
) -> pw::channel::Sender<ToPipewire> {
    let (sender, receiver) = pw::channel::channel();
    std::thread::Builder::new()
        .name("pipewire".to_string())
        .spawn(move || run(receiver, to_wayland, node))
        .expect("the PipeWire thread starts");
    sender
}

/// Things every stream's callbacks share.
struct Shared {
    to_wayland: Sender<ToWayland>,
    gbm: Option<Gbm>,
    sprite: Sprite,
    /// What to destroy after the callback that ended it returns.
    reap: pw::channel::Sender<Reap>,
}

/// Something destroyed outside its own callbacks: PipeWire may still use an
/// object, or the listener it is calling, after the callback returns.
enum Reap {
    Stream(StreamId),
    /// The lost connection, after every stream it had.
    Connection,
}

impl Shared {
    fn tell(&self, news: ToWayland) {
        // The Wayland thread outlives this one; a send fails only at exit.
        let _ = self.to_wayland.send(news);
    }
}

/// The connection to the PipeWire daemon.
struct Connection {
    core: CoreRc,
    _core_listener: pw::core::Listener,
    registry: RegistryRc,
    _registry_listener: pw::registry::Listener,
}

/// Everything on the PipeWire thread.
struct Producer {
    context: ContextRc,
    shared: Rc<Shared>,
    connection: RefCell<Option<Connection>>,
    casts: RefCell<HashMap<StreamId, Rc<Cast>>>,
    /// Link global ids to the stream whose node they feed.
    links: RefCell<HashMap<u32, StreamId>>,
    /// The apps' audio streams and ports, and each client's process.
    graph: RefCell<Graph>,
    /// Each client, bound for the process it reports.
    clients: RefCell<HashMap<u32, (pw::client::Client, pw::client::ClientListener)>>,
    /// The sound nodes, by name.
    sounds: RefCell<HashMap<String, Sound>>,
}

fn run(
    requests: pw::channel::Receiver<ToPipewire>,
    to_wayland: Sender<ToWayland>,
    node: Option<PathBuf>,
) {
    pw::init();
    let main_loop = MainLoopRc::new(None).expect("a PipeWire loop needs no daemon");
    let context = ContextRc::new(&main_loop, None).expect("a PipeWire context needs no daemon");
    let gbm = node.and_then(|node| match Gbm::open(crate::gbm::LIBRARY, &node) {
        Ok(gbm) => Some(gbm),
        Err(why) => {
            tracing::error!(%why, "casts offer shm only");
            None
        }
    });
    let (reap, reaped) = pw::channel::channel::<Reap>();
    let producer = Rc::new(Producer {
        context,
        shared: Rc::new(Shared {
            to_wayland,
            gbm,
            sprite: arrow(),
            reap,
        }),
        connection: RefCell::new(None),
        casts: RefCell::new(HashMap::new()),
        links: RefCell::new(HashMap::new()),
        graph: RefCell::new(Graph::default()),
        clients: RefCell::new(HashMap::new()),
        sounds: RefCell::new(HashMap::new()),
    });
    let _requests = requests.attach(main_loop.loop_(), {
        let producer = producer.clone();
        move |request| producer.handle(request)
    });
    let _reaped = reaped.attach(main_loop.loop_(), {
        let producer = producer.clone();
        move |reap| producer.reap(reap)
    });
    let sweep = main_loop.loop_().add_timer({
        let producer = producer.clone();
        move |_| producer.sweep_sounds(Instant::now())
    });
    let second = Some(Duration::from_secs(1));
    if let Err(why) = sweep.update_timer(second, second).into_result() {
        tracing::error!(%why, "idle sound nodes will not be swept");
    }
    main_loop.run();
}

impl Producer {
    fn handle(self: &Rc<Self>, request: ToPipewire) {
        match request {
            ToPipewire::Start {
                stream,
                offered,
                size,
                cursor,
                heard,
                listener,
            } => self.start(stream, offered, size, cursor, heard, listener),
            ToPipewire::Resize { stream, size } => {
                if let Some(cast) = self.cast(stream) {
                    cast.resize(size);
                }
            }
            ToPipewire::Filled {
                stream,
                buffer,
                damage,
                cursor,
                sprite,
                fence,
            } => {
                if let Some(cast) = self.cast(stream) {
                    cast.filled(buffer, damage, cursor, sprite, fence);
                }
            }
            ToPipewire::Starved { stream } => {
                if let Some(cast) = self.cast(stream) {
                    cast.process_soon();
                }
            }
            ToPipewire::End { stream, why } => {
                if let Some(cast) = self.cast(stream) {
                    let steps = cast.state.borrow_mut().lifecycle.end(why);
                    cast.apply(steps);
                }
            }
        }
    }

    /// The live cast `stream`. `None` once it ended: requests may cross the
    /// end in the queues.
    fn cast(&self, stream: StreamId) -> Option<Rc<Cast>> {
        self.casts.borrow().get(&stream).cloned()
    }

    fn start(
        self: &Rc<Self>,
        id: StreamId,
        offered: Vec<Offered>,
        size: (u32, u32),
        cursor: CursorMode,
        heard: Option<Heard>,
        mut listener: Listener,
    ) {
        let sound = heard.as_ref().map(Heard::node_name);
        let started = self
            .core()
            .and_then(|core| Cast::new(id, core, &self.shared, offered, size, cursor, sound));
        match started {
            Ok(cast) => {
                cast.state.borrow_mut().listener = Some(listener);
                self.casts.borrow_mut().insert(id, cast);
                if let Some(heard) = heard {
                    self.hold_sound(id, heard);
                }
            }
            Err(why) => {
                tracing::error!(%why, ?id, "the cast did not start");
                self.shared.tell(ToWayland::Ended { stream: id });
                listener(Event::Ended(Ended::Failed(why)));
            }
        }
    }

    /// The core, connecting first if there is no connection.
    fn core(self: &Rc<Self>) -> Result<CoreRc, String> {
        if let Some(connection) = self.connection.borrow().as_ref() {
            return Ok(connection.core.clone());
        }
        let core = self
            .context
            .connect_rc(None)
            .map_err(|why| format!("cannot connect to PipeWire: {why}"))?;
        let registry = core
            .get_registry_rc()
            .map_err(|why| format!("PipeWire gave no registry: {why}"))?;
        let core_listener = core
            .add_listener_local()
            .error({
                let producer = Rc::downgrade(self);
                move |id, _seq, res, message| {
                    if !lost(id, res) {
                        warn!(id, res, message, "PipeWire refused a request");
                    } else if let Some(producer) = producer.upgrade() {
                        producer.lost(message);
                    }
                }
            })
            .register();
        let registry_listener = registry
            .add_listener_local()
            .global({
                let producer = Rc::downgrade(self);
                move |global| {
                    if let Some(producer) = producer.upgrade() {
                        producer.global(global);
                    }
                }
            })
            .global_remove({
                let producer = Rc::downgrade(self);
                move |id| {
                    if let Some(producer) = producer.upgrade() {
                        producer.global_removed(id);
                    }
                }
            })
            .register();
        debug!("connected to PipeWire for casting");
        *self.connection.borrow_mut() = Some(Connection {
            core: core.clone(),
            _core_listener: core_listener,
            registry,
            _registry_listener: registry_listener,
        });
        Ok(core)
    }

    /// The daemon went away. Every stream ends, and the next start reconnects.
    fn lost(&self, message: &str) {
        tracing::error!(message, "PipeWire connection lost; ending every cast");
        let casts: Vec<_> = self.casts.borrow().values().cloned().collect();
        for cast in casts {
            let steps = cast
                .state
                .borrow_mut()
                .lifecycle
                .failed(message.to_string());
            cast.apply(steps);
        }
        // Queued after the streams, so it is dropped after them.
        self.links.borrow_mut().clear();
        *self.graph.borrow_mut() = Graph::default();
        self.clients.borrow_mut().clear();
        self.sounds.borrow_mut().clear();
        // Fails only once the reaper is gone, at exit.
        let _ = self.shared.reap.send(Reap::Connection);
    }

    /// Something appeared: a link to one of the streams' nodes, or a node,
    /// port or client casts' sound may come from.
    fn global(self: &Rc<Self>, global: &pw::registry::GlobalObject<&spa::utils::dict::DictRef>) {
        let props = |key| global.props.and_then(|props| props.get(key));
        let number = |key| props(key).and_then(|value| value.parse::<u32>().ok());
        match global.type_ {
            ObjectType::Link => self.linked(global),
            ObjectType::Node => {
                if let Some(name) = props(*pw::keys::NODE_NAME) {
                    self.named(global.id, name);
                }
                self.graph.borrow_mut().nodes.insert(
                    global.id,
                    audio::Node {
                        plays: props(*pw::keys::MEDIA_CLASS) == Some("Stream/Output/Audio"),
                        client: number(*pw::keys::CLIENT_ID),
                    },
                );
                self.relink();
            }
            ObjectType::Port => {
                let (Some(node), Some(channel)) =
                    (number(*pw::keys::NODE_ID), props(*pw::keys::AUDIO_CHANNEL))
                else {
                    return;
                };
                self.graph.borrow_mut().ports.insert(
                    global.id,
                    audio::Port {
                        node,
                        output: props(*pw::keys::PORT_DIRECTION) == Some("out"),
                        channel: channel.to_string(),
                    },
                );
                self.relink();
            }
            ObjectType::Client => {
                if let Some(process) = number(*pw::keys::SEC_PID) {
                    self.graph.borrow_mut().clients.insert(global.id, process);
                }
                self.bind_client(global);
                self.relink();
            }
            _ => {}
        }
    }

    /// A link appeared: one to a stream's node is its consumer's.
    fn linked(&self, global: &pw::registry::GlobalObject<&spa::utils::dict::DictRef>) {
        let output = global
            .props
            .and_then(|props| props.get("link.output.node"))
            .and_then(|node| node.parse::<u32>().ok());
        for sound in self.sounds.borrow_mut().values_mut() {
            if output.is_some() && sound.id == output {
                debug!(link = global.id, "a consumer linked to a sound node");
                sound.holders.consumer_linked(global.id);
            }
        }
        let casts = self.casts.borrow();
        let fed = casts
            .values()
            .find(|cast| output.is_some() && cast.state.borrow().node == output);
        if let Some(cast) = fed {
            debug!(link = global.id, stream = ?cast.id, "a consumer linked to a cast");
            self.links.borrow_mut().insert(global.id, cast.id);
            cast.state.borrow_mut().lifecycle.linked();
        }
    }

    fn global_removed(&self, id: u32) {
        {
            let mut graph = self.graph.borrow_mut();
            let gone = graph.nodes.remove(&id).is_some()
                | graph.ports.remove(&id).is_some()
                | graph.clients.remove(&id).is_some();
            drop(graph);
            self.clients.borrow_mut().remove(&id);
            let now = Instant::now();
            for sound in self.sounds.borrow_mut().values_mut() {
                sound.holders.consumer_unlinked(id, now);
            }
            if gone {
                self.relink();
            }
        }
        let Some(stream) = self.links.borrow_mut().remove(&id) else {
            return;
        };
        if let Some(cast) = self.cast(stream) {
            debug!(link = id, ?stream, "a consumer unlinked from a cast");
            let steps = cast.state.borrow_mut().lifecycle.unlinked();
            cast.apply(steps);
        }
    }

    /// Binds client `global` to read the process it reports, which PipeWire's
    /// PulseAudio server sets to its own client's.
    fn bind_client(
        self: &Rc<Self>,
        global: &pw::registry::GlobalObject<&spa::utils::dict::DictRef>,
    ) {
        let bound = self
            .connection
            .borrow()
            .as_ref()
            .map(|connection| connection.registry.bind::<pw::client::Client, _>(global));
        let client = match bound {
            Some(Ok(client)) => client,
            Some(Err(why)) => {
                debug!(%why, client = global.id, "a client could not be bound");
                return;
            }
            None => return,
        };
        let id = global.id;
        let listener = client
            .add_listener_local()
            .info({
                let producer = Rc::downgrade(self);
                move |info| {
                    let reported = info
                        .props()
                        .and_then(|props| props.get(*pw::keys::APP_PROCESS_ID))
                        .and_then(|process| process.parse::<u32>().ok());
                    if let (Some(producer), Some(process)) = (producer.upgrade(), reported) {
                        producer.graph.borrow_mut().clients.insert(id, process);
                        producer.relink();
                    }
                }
            })
            .register();
        self.clients.borrow_mut().insert(id, (client, listener));
    }

    /// Node `id` is named `name`: it may be a sound node.
    fn named(&self, id: u32, name: &str) {
        if let Some(sound) = self.sounds.borrow_mut().get_mut(name) {
            sound.id = Some(id);
        }
    }

    /// Cast `cast` holds the sound node of what it `heard`, made if it is
    /// not there.
    fn hold_sound(self: &Rc<Self>, cast: StreamId, heard: Heard) {
        let name = heard.node_name();
        if let Some(sound) = self.sounds.borrow_mut().get_mut(&name) {
            sound.holders.cast_started(cast);
            return;
        }
        let made = self.core().and_then(|core| {
            core.create_object::<pw::node::Node>(
                "adapter",
                &properties! {
                    "factory.name" => "support.null-audio-sink",
                    *pw::keys::NODE_NAME => name.as_str(),
                    *pw::keys::NODE_DESCRIPTION => "Screen cast sound",
                    *pw::keys::MEDIA_CLASS => "Audio/Source/Virtual",
                    "audio.position" => "[ FL FR ]",
                    *pw::keys::OBJECT_LINGER => "false",
                },
            )
            .map_err(|why| why.to_string())
        });
        match made {
            Ok(node) => {
                let ports = audio_ports();
                node.set_param(spa::param::ParamType::PortConfig, 0, pod_of(&ports));
                debug!(stream = ?cast, %name, "cast sound node made");
                let mut holders = Holders::default();
                holders.cast_started(cast);
                self.sounds.borrow_mut().insert(
                    name,
                    Sound {
                        heard,
                        _node: node,
                        id: None,
                        links: HashMap::new(),
                        holders,
                    },
                );
            }
            Err(why) => tracing::error!(%why, stream = ?cast, "the cast's sound node was not made"),
        }
    }

    /// Drops the sound nodes nothing has held for [`audio::GRACE`].
    fn sweep_sounds(&self, now: Instant) {
        self.sounds.borrow_mut().retain(|name, sound| {
            let keep = !sound.holders.expired(now);
            if !keep {
                debug!(%name, "an idle sound node was dropped");
            }
            keep
        });
    }

    /// Links what each sound node hears into it, and unlinks what it no
    /// longer hears.
    fn relink(&self) {
        let Some(core) = self.connection.borrow().as_ref().map(|c| c.core.clone()) else {
            return;
        };
        let graph = self.graph.borrow();
        for (name, sound) in self.sounds.borrow_mut().iter_mut() {
            let Some(node) = sound.id else {
                continue;
            };
            let wanted = graph.wanted(node, &sound.heard, audio::parent);
            sound.links.retain(|ports, _| wanted.contains(ports));
            for ports in wanted {
                if sound.links.contains_key(&ports) {
                    continue;
                }
                let (output, input) = ports;
                let Some(from) = graph.ports.get(&output).map(|port| port.node) else {
                    continue;
                };
                let link = core.create_object::<pw::link::Link>(
                    "link-factory",
                    &properties! {
                        *pw::keys::LINK_OUTPUT_NODE => from.to_string(),
                        *pw::keys::LINK_OUTPUT_PORT => output.to_string(),
                        *pw::keys::LINK_INPUT_NODE => node.to_string(),
                        *pw::keys::LINK_INPUT_PORT => input.to_string(),
                        *pw::keys::OBJECT_LINGER => "false",
                    },
                );
                match link {
                    Ok(link) => {
                        debug!(%name, output, input, "linked sound into a sound node");
                        sound.links.insert(ports, link);
                    }
                    Err(why) => tracing::error!(%why, %name, "sound could not be linked"),
                }
            }
        }
    }

    /// Destroys an ended stream or a lost connection.
    fn reap(&self, reap: Reap) {
        let stream = match reap {
            Reap::Stream(stream) => stream,
            Reap::Connection => {
                self.connection.borrow_mut().take();
                return;
            }
        };
        let cast = self.casts.borrow_mut().remove(&stream);
        if let Some(cast) = cast {
            self.links.borrow_mut().retain(|_, fed| *fed != stream);
            if let Some(name) = &cast.sound {
                if let Some(sound) = self.sounds.borrow_mut().get_mut(name) {
                    sound.holders.cast_ended(stream, Instant::now());
                }
            }
            cast.listener.borrow_mut().take();
            if let Err(why) = cast.stream.disconnect() {
                debug!(%why, ?stream, "an ended cast did not disconnect cleanly");
            }
        }
    }
}

/// One stream.
struct Cast {
    id: StreamId,
    stream: StreamRc,
    /// The name of the sound node it holds.
    sound: Option<String>,
    shared: Rc<Shared>,
    listener: RefCell<Option<StreamListener<()>>>,
    state: RefCell<State>,
}

/// A buffer PipeWire added, and what keeps its memory alive.
struct Held {
    buffer: *mut pw::sys::pw_buffer,
    _target: Target,
}

/// A sound node, the links into it by (output, input) port, and what keeps
/// it.
struct Sound {
    heard: Heard,
    _node: pw::node::Node,
    /// Its global id, once the registry names it.
    id: Option<u32>,
    links: HashMap<(u32, u32), pw::link::Link>,
    holders: Holders,
}

/// A filled buffer waiting for the next `process`.
struct Ready {
    buffer: BufferId,
    damage: Vec<Rect>,
    cursor: Plan,
    sprite: Option<Arc<Sprite>>,
}

struct State {
    lifecycle: Lifecycle,
    listener: Option<Listener>,
    node: Option<u32>,
    offered: Vec<Offered>,
    size: (u32, u32),
    cursor: CursorMode,
    format: Option<StreamFormat>,
    filling: bool,
    buffers: HashMap<BufferId, Held>,
    lent: HashSet<BufferId>,
    ready: Vec<Ready>,
    next_buffer: u32,
    sequence: u64,
}

impl Cast {
    fn new(
        id: StreamId,
        core: CoreRc,
        shared: &Rc<Shared>,
        offered: Vec<Offered>,
        size: (u32, u32),
        cursor: CursorMode,
        sound: Option<String>,
    ) -> Result<Rc<Cast>, String> {
        let stream = StreamRc::new(
            core,
            "domicile-cast",
            properties! {
                *pw::keys::MEDIA_CLASS => "Video/Source",
                *pw::keys::MEDIA_TYPE => "Video",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::MEDIA_ROLE => "Screen",
                *pw::keys::NODE_NAME => "domicile-cast",
            },
        )
        .map_err(|why| format!("PipeWire made no stream: {why}"))?;
        let cast = Rc::new(Cast {
            id,
            stream,
            sound,
            shared: shared.clone(),
            listener: RefCell::new(None),
            state: RefCell::new(State {
                lifecycle: Lifecycle::default(),
                listener: None,
                node: None,
                offered,
                size,
                cursor,
                format: None,
                filling: false,
                buffers: HashMap::new(),
                lent: HashSet::new(),
                ready: Vec::new(),
                next_buffer: 0,
                sequence: 0,
            }),
        });
        let weak = Rc::downgrade(&cast);
        let on = move |weak: &Weak<Cast>| weak.upgrade();
        let listener = cast
            .stream
            .add_local_listener_with_user_data(())
            .state_changed({
                let weak = weak.clone();
                move |stream, _, _, state| {
                    if let Some(cast) = on(&weak) {
                        cast.state_changed(stream.node_id(), state);
                    }
                }
            })
            .param_changed({
                let weak = weak.clone();
                move |_, _, id, pod| {
                    if let (Some(cast), Some(pod)) = (on(&weak), pod) {
                        if id == spa::param::ParamType::Format.as_raw() {
                            cast.format_changed(pod);
                        }
                    }
                }
            })
            .add_buffer({
                let weak = weak.clone();
                move |_, _, buffer| {
                    if let Some(cast) = on(&weak) {
                        cast.add_buffer(buffer);
                    }
                }
            })
            .remove_buffer({
                let weak = weak.clone();
                move |_, _, buffer| {
                    if let Some(cast) = on(&weak) {
                        cast.remove_buffer(buffer);
                    }
                }
            })
            .process(move |_, _| {
                if let Some(cast) = on(&weak) {
                    cast.process();
                }
            })
            .register()
            .map_err(|why| format!("PipeWire took no stream listener: {why}"))?;
        *cast.listener.borrow_mut() = Some(listener);

        let pods = {
            let state = cast.state.borrow();
            enum_formats(&state.offered, state.size)
        };
        let mut params: Vec<&Pod> = pods.iter().map(|pod| pod_of(pod)).collect();
        cast.stream
            .connect(
                spa::utils::Direction::Output,
                None,
                StreamFlags::DRIVER | StreamFlags::ALLOC_BUFFERS,
                &mut params,
            )
            .map_err(|why| format!("PipeWire would not connect the stream: {why}"))?;
        Ok(cast)
    }

    fn state_changed(&self, node: u32, state: StreamState) {
        debug!(stream = ?self.id, ?state, node, "cast state");
        let steps = {
            let mut own = self.state.borrow_mut();
            match state {
                StreamState::Error(why) => own.lifecycle.failed(why),
                StreamState::Unconnected => own.lifecycle.moved(Phase::Unconnected, node),
                StreamState::Connecting => own.lifecycle.moved(Phase::Connecting, node),
                StreamState::Paused => {
                    own.node = Some(node);
                    own.lifecycle.moved(Phase::Paused, node)
                }
                StreamState::Streaming => own.lifecycle.moved(Phase::Streaming, node),
            }
        };
        self.apply(steps);
    }

    /// Carries out what the lifecycle decided.
    fn apply(&self, steps: Vec<Step>) {
        for step in steps {
            match step {
                Step::Ready { node } => {
                    debug!(stream = ?self.id, node, "cast ready");
                    self.hear(Event::Ready {
                        node,
                        sound: self.sound.clone(),
                    });
                }
                Step::Fill(on) => {
                    self.state.borrow_mut().filling = on;
                    self.shared.tell(ToWayland::Filling {
                        stream: self.id,
                        on,
                    });
                    if on {
                        self.process_soon();
                    }
                }
                Step::End(why) => {
                    info!(stream = ?self.id, ?why, "cast ended");
                    self.shared.tell(ToWayland::Ended { stream: self.id });
                    self.hear(Event::Ended(why));
                    // Fails only once the reaper is gone, at exit.
                    let _ = self.shared.reap.send(Reap::Stream(self.id));
                }
            }
        }
    }

    fn hear(&self, event: Event) {
        let listener = self.state.borrow_mut().listener.take();
        if let Some(mut listener) = listener {
            listener(event);
            self.state.borrow_mut().listener = Some(listener);
        }
    }

    /// The consumer picked a format.
    fn format_changed(&self, pod: &Pod) {
        let format = match read_format(pod) {
            Ok(format) => format,
            Err(why) => {
                let steps = self.state.borrow_mut().lifecycle.failed(why.to_string());
                return self.apply(steps);
            }
        };
        let picked = format.picked;
        let settled = settle(&picked, |pixel, modifier| {
            self.allocate(pixel, picked.size, modifier).is_some()
        });
        debug!(stream = ?self.id, ?settled, "cast format");
        let cursor_bytes = {
            let state = self.state.borrow();
            (state.cursor == CursorMode::Metadata).then(|| self.shared.sprite.pixels.len())
        };
        let pods = match settled {
            Settled::Shm { pixel, size } => {
                self.settled(
                    StreamFormat {
                        pixel,
                        size,
                        modifier: None,
                    },
                    format.framerate,
                );
                [vec![buffers(Memory::Shm { size })], metas(cursor_bytes)].concat()
            }
            Settled::Dmabuf {
                pixel,
                size,
                modifier,
            } => {
                let Some(planes) = self
                    .allocate(pixel, size, modifier)
                    .map(|dmabuf| dmabuf.num_planes() as u32)
                else {
                    let steps = self
                        .state
                        .borrow_mut()
                        .lifecycle
                        .failed("the consumer's modifier does not allocate".to_string());
                    return self.apply(steps);
                };
                self.settled(
                    StreamFormat {
                        pixel,
                        size,
                        modifier: Some(modifier),
                    },
                    format.framerate,
                );
                [
                    vec![buffers(Memory::Dmabuf { planes })],
                    metas(cursor_bytes),
                ]
                .concat()
            }
            Settled::Fixate { pixel, modifier } => {
                let state = self.state.borrow();
                [
                    vec![fixated(pixel, state.size, modifier)],
                    enum_formats(&state.offered, state.size),
                ]
                .concat()
            }
            Settled::DropDmabuf => {
                let mut state = self.state.borrow_mut();
                state
                    .offered
                    .retain(|offered| matches!(offered, Offered::Shm { .. }));
                enum_formats(&state.offered, state.size)
            }
        };
        self.update(&pods);
    }

    fn settled(&self, format: StreamFormat, framerate: u32) {
        self.state.borrow_mut().format = Some(format);
        self.shared.tell(ToWayland::Format {
            stream: self.id,
            format,
            framerate,
        });
    }

    fn update(&self, pods: &[Vec<u8>]) {
        let mut params: Vec<&Pod> = pods.iter().map(|pod| pod_of(pod)).collect();
        if let Err(why) = self.stream.update_params(&mut params) {
            let steps = self
                .state
                .borrow_mut()
                .lifecycle
                .failed(format!("PipeWire refused the stream's parameters: {why}"));
            self.apply(steps);
        }
    }

    fn resize(&self, size: (u32, u32)) {
        let pods = {
            let mut state = self.state.borrow_mut();
            state.size = size;
            enum_formats(&state.offered, size)
        };
        self.update(&pods);
    }

    /// A dmabuf of `size`, or `None` without a GPU or when it will not
    /// allocate.
    fn allocate(&self, pixel: Pixel, size: (u32, u32), modifier: u64) -> Option<Dmabuf> {
        let gbm = self.shared.gbm.as_ref()?;
        gbm.allocate(
            Shape {
                width: size.0,
                height: size.1,
                fourcc: fourcc(pixel),
            },
            &[modifier],
        )
        .ok()
    }

    /// PipeWire made a buffer; give it memory.
    fn add_buffer(&self, buffer: *mut pw::sys::pw_buffer) {
        let Some(format) = self.state.borrow().format else {
            let steps = self
                .state
                .borrow_mut()
                .lifecycle
                .failed("PipeWire added a buffer before a format".to_string());
            return self.apply(steps);
        };
        let target = match format.modifier {
            None => {
                let (stride, length) = shm_layout(format.size);
                Mapping::new(c"domicile-cast", length as usize)
                    .map(|mapping| {
                        // SAFETY: PipeWire's buffer, in its add_buffer
                        // callback, with the one block `buffers` asked for.
                        unsafe { describe_shm(buffer, &mapping, stride) };
                        Target::Shm(Arc::new(mapping))
                    })
                    .map_err(|why| format!("no memory for a cast buffer: {why}"))
            }
            Some(modifier) => self
                .allocate(format.pixel, format.size, modifier)
                .map(|dmabuf| {
                    // SAFETY: as above, with one block per plane.
                    unsafe { describe_dmabuf(buffer, &dmabuf) };
                    Target::Dmabuf(dmabuf)
                })
                .ok_or_else(|| "the GPU would not allocate a cast buffer".to_string()),
        };
        let target = match target {
            Ok(target) => target,
            Err(why) => {
                let steps = self.state.borrow_mut().lifecycle.failed(why);
                return self.apply(steps);
            }
        };
        let id = {
            let mut state = self.state.borrow_mut();
            let id = BufferId(state.next_buffer);
            state.next_buffer += 1;
            state.buffers.insert(
                id,
                Held {
                    buffer,
                    _target: target.clone(),
                },
            );
            id
        };
        // SAFETY: PipeWire's buffer; `user_data` is ours to set.
        unsafe { (*buffer).user_data = id.0 as usize as *mut _ };
        self.shared.tell(ToWayland::Added {
            stream: self.id,
            buffer: id,
            target,
        });
    }

    fn remove_buffer(&self, buffer: *mut pw::sys::pw_buffer) {
        // SAFETY: a buffer `add_buffer` numbered.
        let id = BufferId(unsafe { (*buffer).user_data } as usize as u32);
        {
            let mut state = self.state.borrow_mut();
            state.buffers.remove(&id);
            state.lent.remove(&id);
            state.ready.retain(|ready| ready.buffer != id);
        }
        self.shared.tell(ToWayland::Removed {
            stream: self.id,
            buffer: id,
        });
    }

    /// The Wayland thread filled `buffer`.
    fn filled(
        &self,
        buffer: BufferId,
        damage: Vec<Rect>,
        cursor: Plan,
        sprite: Option<Arc<Sprite>>,
        fence: Option<OwnedFd>,
    ) {
        if !self.state.borrow().lent.contains(&buffer) {
            // Removed while it was being filled, as on a resize.
            return;
        }
        if let Some(fence) = fence {
            wait_for(&fence);
        }
        self.state.borrow_mut().ready.push(Ready {
            buffer,
            damage,
            cursor,
            sprite,
        });
        self.process_soon();
    }

    /// Runs `process` now when this stream drives the graph. Otherwise the
    /// driver runs it on its next cycle.
    fn process_soon(&self) {
        if self.stream.is_driving() {
            if let Err(why) = self.stream.trigger_process() {
                debug!(%why, stream = ?self.id, "a cast would not process");
            }
        }
    }

    /// Queues filled buffers and lends free ones.
    fn process(&self) {
        let mut state = self.state.borrow_mut();
        let ready = std::mem::take(&mut state.ready);
        for Ready {
            buffer,
            damage,
            cursor,
            sprite,
        } in ready
        {
            let Some(held) = state.buffers.get(&buffer) else {
                continue;
            };
            let raw = held.buffer;
            state.lent.remove(&buffer);
            state.sequence += 1;
            // SAFETY: a buffer of this stream, dequeued when lent and not yet
            // queued.
            unsafe {
                let sprite = sprite.as_deref().unwrap_or(&self.shared.sprite);
                write_metas(raw, state.sequence, &damage, cursor, sprite);
                pw::sys::pw_stream_queue_buffer(self.stream.as_raw_ptr(), raw);
            }
        }
        if !state.filling {
            return;
        }
        loop {
            // SAFETY: this stream; a null return means none is free.
            let raw = unsafe { pw::sys::pw_stream_dequeue_buffer(self.stream.as_raw_ptr()) };
            if raw.is_null() {
                break;
            }
            // SAFETY: a buffer `add_buffer` numbered.
            let id = BufferId(unsafe { (*raw).user_data } as usize as u32);
            state.lent.insert(id);
            self.shared.tell(ToWayland::Lent {
                stream: self.id,
                buffer: id,
            });
        }
    }
}

/// The DRM fourcc of `pixel`.
pub fn fourcc(pixel: Pixel) -> u32 {
    match pixel {
        Pixel::Bgrx => u32::from_le_bytes(*b"XR24"),
        Pixel::Bgra => u32::from_le_bytes(*b"AR24"),
    }
}

/// Bytes the serializer made, as a pod.
fn pod_of(bytes: &[u8]) -> &Pod {
    Pod::from_bytes(bytes).expect("the serializer makes whole pods")
}

/// Waits for a GPU fence, at most [`FENCE_PATIENCE`].
fn wait_for(fence: &OwnedFd) {
    let mut poll = libc::pollfd {
        fd: fence.as_fd().as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one live fd.
    let ready = unsafe { libc::poll(&mut poll, 1, FENCE_PATIENCE.as_millis() as i32) };
    if ready != 1 {
        warn!(ready, "a cast frame's GPU fence did not signal in time");
    }
}

/// Points `buffer`'s one block at `mapping`.
///
/// # Safety
///
/// `buffer` is a live PipeWire buffer with one data block.
unsafe fn describe_shm(buffer: *mut pw::sys::pw_buffer, mapping: &Mapping, stride: u32) {
    // SAFETY: the caller's guarantee.
    unsafe {
        let data = &mut *(*(*buffer).buffer).datas;
        data.type_ = spa::sys::SPA_DATA_MemFd;
        data.flags = spa::sys::SPA_DATA_FLAG_READWRITE;
        data.fd = i64::from(mapping.as_fd().as_raw_fd());
        data.mapoffset = 0;
        data.maxsize = mapping.len() as u32;
        data.data = std::ptr::null_mut();
        let chunk = &mut *data.chunk;
        chunk.offset = 0;
        chunk.size = mapping.len() as u32;
        chunk.stride = stride as i32;
        chunk.flags = 0;
    }
}

/// Points `buffer`'s blocks at `dmabuf`'s planes.
///
/// # Safety
///
/// `buffer` is a live PipeWire buffer with a data block per plane.
unsafe fn describe_dmabuf(buffer: *mut pw::sys::pw_buffer, dmabuf: &Dmabuf) {
    let height = dmabuf.height();
    // SAFETY: the caller's guarantee.
    unsafe {
        let spa_buffer = &mut *(*buffer).buffer;
        let datas = std::slice::from_raw_parts_mut(spa_buffer.datas, spa_buffer.n_datas as usize);
        for (data, ((fd, offset), stride)) in datas
            .iter_mut()
            .zip(dmabuf.handles().zip(dmabuf.offsets()).zip(dmabuf.strides()))
        {
            data.type_ = spa::sys::SPA_DATA_DmaBuf;
            data.flags = spa::sys::SPA_DATA_FLAG_READWRITE;
            data.fd = i64::from(fd.as_raw_fd());
            data.mapoffset = offset;
            data.maxsize = stride * height;
            data.data = std::ptr::null_mut();
            let chunk = &mut *data.chunk;
            chunk.offset = offset;
            chunk.size = stride * height;
            chunk.stride = stride as i32;
            chunk.flags = 0;
        }
    }
}

/// The metadata of `kind` on `buffer`, if the consumer took it.
///
/// # Safety
///
/// `buffer` is a live PipeWire buffer.
unsafe fn find_meta(buffer: *mut pw::sys::pw_buffer, kind: u32) -> Option<(*mut u8, usize)> {
    // SAFETY: the caller's guarantee.
    unsafe {
        let spa_buffer = &*(*buffer).buffer;
        std::slice::from_raw_parts(spa_buffer.metas, spa_buffer.n_metas as usize)
            .iter()
            .find(|meta| meta.type_ == kind && !meta.data.is_null())
            .map(|meta| (meta.data.cast::<u8>(), meta.size as usize))
    }
}

/// Writes the header, damage and cursor of a frame.
///
/// # Safety
///
/// `buffer` is a live PipeWire buffer the producer holds.
unsafe fn write_metas(
    buffer: *mut pw::sys::pw_buffer,
    sequence: u64,
    damage: &[Rect],
    cursor: Plan,
    sprite: &Sprite,
) {
    // SAFETY: each meta pointer comes from the buffer, and each write stays
    // inside the size PipeWire gave it.
    unsafe {
        if let Some((data, size)) = find_meta(buffer, spa::sys::SPA_META_Header) {
            if size >= size_of::<spa::sys::spa_meta_header>() {
                let header = &mut *data.cast::<spa::sys::spa_meta_header>();
                header.flags = 0;
                header.offset = 0;
                header.pts = monotonic_nanoseconds();
                header.dts_offset = 0;
                header.seq = sequence;
            }
        }
        if let Some((data, size)) = find_meta(buffer, spa::sys::SPA_META_VideoDamage) {
            let regions = std::slice::from_raw_parts_mut(
                data.cast::<spa::sys::spa_meta_region>(),
                size / size_of::<spa::sys::spa_meta_region>(),
            );
            // A zero-sized region ends the list.
            let ended = damage.iter().copied().chain([(0, 0, 0, 0)]);
            for (region, (x, y, width, height)) in regions.iter_mut().zip(ended) {
                region.region.position.x = x;
                region.region.position.y = y;
                region.region.size.width = width as u32;
                region.region.size.height = height as u32;
            }
        }
        if let (Some((data, size)), Plan::Metadata { at }) =
            (find_meta(buffer, spa::sys::SPA_META_Cursor), cursor)
        {
            write_cursor(data, size, at, sprite);
        }
    }
}

/// Writes `SPA_META_Cursor`, with `sprite`'s image shrunk to fit.
///
/// # Safety
///
/// `data` points at `size` writable bytes of cursor metadata.
unsafe fn write_cursor(data: *mut u8, size: usize, at: Option<(i32, i32)>, sprite: &Sprite) {
    let cursor_size = size_of::<spa::sys::spa_meta_cursor>();
    let bitmap_size = size_of::<spa::sys::spa_meta_bitmap>();
    if size < cursor_size {
        return;
    }
    // SAFETY: the caller's guarantee, and every write is checked against
    // `size`.
    unsafe {
        let cursor = &mut *data.cast::<spa::sys::spa_meta_cursor>();
        let Some((x, y)) = at else {
            // Id 0 says there is no pointer over the source.
            cursor.id = 0;
            return;
        };
        cursor.id = 1;
        cursor.flags = 0;
        cursor.position.x = x;
        cursor.position.y = y;
        let room = size.saturating_sub(cursor_size + bitmap_size) / 4;
        if room == 0 {
            cursor.hotspot.x = sprite.hotspot.0;
            cursor.hotspot.y = sprite.hotspot.1;
            cursor.bitmap_offset = 0;
            return;
        }
        let sprite = &within(sprite, room);
        cursor.hotspot.x = sprite.hotspot.0;
        cursor.hotspot.y = sprite.hotspot.1;
        cursor.bitmap_offset = cursor_size as u32;
        let bitmap = &mut *data.add(cursor_size).cast::<spa::sys::spa_meta_bitmap>();
        bitmap.format = spa::sys::SPA_VIDEO_FORMAT_BGRA;
        bitmap.size.width = sprite.size.0;
        bitmap.size.height = sprite.size.1;
        bitmap.stride = (sprite.size.0 * 4) as i32;
        bitmap.offset = bitmap_size as u32;
        std::ptr::copy_nonoverlapping(
            sprite.pixels.as_ptr(),
            data.add(cursor_size + bitmap_size),
            sprite.pixels.len(),
        );
    }
}

/// `CLOCK_MONOTONIC` in nanoseconds, the clock PipeWire stamps frames with.
fn monotonic_nanoseconds() -> i64 {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: a valid clock and a live timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };
    now.tv_sec * 1_000_000_000 + now.tv_nsec
}

/// Whether a core error of `res` on object `id` is the connection's end. The
/// daemon also reports a request to an object it already removed on the core,
/// as `ENOENT`, as a sound node's links race the apps they link; the
/// connection stays up.
fn lost(id: u32, res: i32) -> bool {
    id == pw::core::PW_ID_CORE && res != -libc::ENOENT
}

#[cfg(test)]
mod tests {
    use pipewire::spa;

    use super::{lost, write_cursor};
    use crate::casting::cursor::Sprite;

    #[test]
    fn a_request_to_a_removed_object_keeps_the_connection() {
        assert!(lost(pipewire::core::PW_ID_CORE, -libc::EPIPE));
        assert!(!lost(pipewire::core::PW_ID_CORE, -libc::ENOENT));
        assert!(!lost(7, -libc::EINVAL), "an object's own error");
    }

    /// A consumer makes room for its own largest cursor, as WebRTC does for
    /// 64x64. A pointer the engine drew larger is shrunk into it, not dropped.
    #[test]
    fn a_pointer_larger_than_the_metadata_is_shrunk_into_it() {
        let cursor_size = size_of::<spa::sys::spa_meta_cursor>();
        let bitmap_size = size_of::<spa::sys::spa_meta_bitmap>();
        let size = cursor_size + bitmap_size + 64 * 64 * 4;
        // u64s, so the metas are aligned as PipeWire aligns them.
        let mut meta = vec![0u64; size.div_ceil(8)];
        let big =
            Sprite::from_bgra((80, 80), (40, 20), 2.0, vec![255; 80 * 80 * 4]).expect("a sprite");

        // SAFETY: `meta` is `size` writable bytes.
        let (cursor, bitmap) = unsafe {
            let data = meta.as_mut_ptr().cast::<u8>();
            write_cursor(data, size, Some((5, 6)), &big);
            (
                &*data.cast::<spa::sys::spa_meta_cursor>(),
                &*data.add(cursor_size).cast::<spa::sys::spa_meta_bitmap>(),
            )
        };

        assert_eq!(cursor.id, 1);
        assert_eq!((cursor.position.x, cursor.position.y), (5, 6));
        assert_eq!(cursor.bitmap_offset as usize, cursor_size);
        assert_eq!((bitmap.size.width, bitmap.size.height), (64, 64));
        assert_eq!((cursor.hotspot.x, cursor.hotspot.y), (32, 16));
    }
}

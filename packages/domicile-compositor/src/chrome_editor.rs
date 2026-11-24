//! The browser's text fields as one editor on the input method relay, on a
//! desk where the browser is not a Wayland client (a tty). See
//! `docs/architecture/TEXT-INPUT.md#pages-and-the-shell`.
//!
//! Smithay relays between an input method and the `text-input-v3` of the
//! surface with the keyboard. The browser has no surface, so the compositor
//! connects a stand-in to its own display: a client with one roleless surface,
//! a text input and a keyboard. While the browser holds the keyboard the
//! stand-in's surface does, and:
//!
//! - the browser's focused field ([`ChromeMessage::TextInput`]) becomes the
//!   stand-in's text input state, so Smithay activates the input method and
//!   tells it the surrounding text, content type and cursor;
//! - what the input method composes reaches the stand-in's text input, and
//!   goes to the browser at each `done` as [`HostMessage::Composition`];
//! - the browser's keys ([`ChromeMessage::KeyForInputMethod`]) go through the
//!   seat to the input method's keyboard grab. What the input method passes
//!   on (through `virtual-keyboard-v1`), and any key while nothing grabs,
//!   reaches the stand-in's keyboard, and goes back as
//!   [`HostMessage::KeyPassed`].
//!
//! Smithay keeps the input method's `zwp_input_method_v2` to itself, so the
//! compositor could not drive it for the browser directly.
//!
//! [`ChromeMessage::TextInput`]: domicile_protocol::ChromeMessage::TextInput
//! [`ChromeMessage::KeyForInputMethod`]: domicile_protocol::ChromeMessage::KeyForInputMethod
//! [`HostMessage::Composition`]: domicile_protocol::HostMessage::Composition
//! [`HostMessage::KeyPassed`]: domicile_protocol::HostMessage::KeyPassed

use std::io;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use domicile_protocol::{HostMessage, Preedit, TextField};
use smithay::reexports::calloop::{generic::Generic, Interest, LoopHandle, Mode, PostAction};
use smithay::reexports::wayland_server::{
    protocol::wl_surface::WlSurface as ServerSurface, Client as ServerClient, DisplayHandle,
};
use smithay::utils::SERIAL_COUNTER;
use smithay::wayland::input_method::InputMethodSeat as _;
use tracing::debug;
use wayland_client::protocol::{wl_compositor, wl_keyboard, wl_registry, wl_seat, wl_surface};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy as _, QueueHandle, WEnum};
use wayland_protocols::wp::text_input::zv3::client::{
    zwp_text_input_manager_v3::ZwpTextInputManagerV3,
    zwp_text_input_v3::{self, ContentHint, ContentPurpose, ZwpTextInputV3},
};

use crate::clients::ClientState;
use crate::{CalloopData, DomicileCompositor};

/// The stand-in client and its connection.
pub struct ChromeEditor {
    connection: Connection,
    queue: EventQueue<StandIn>,
    stand_in: StandIn,
    /// The stand-in, as the display knows it.
    client: ServerClient,
}

/// What the stand-in heard for the browser.
#[derive(Debug, PartialEq)]
pub enum Heard {
    Composition {
        preedit: Option<Preedit>,
        commit: Option<String>,
        delete: Option<[u32; 2]>,
    },
    KeyPassed {
        keycode: u32,
        pressed: bool,
    },
}

#[derive(Default)]
struct StandIn {
    compositor: Option<wl_compositor::WlCompositor>,
    seat: Option<wl_seat::WlSeat>,
    text_inputs: Option<ZwpTextInputManagerV3>,
    surface: Option<wl_surface::WlSurface>,
    text_input: Option<ZwpTextInputV3>,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    /// Whether the stand-in's surface has the text input's focus.
    entered: bool,
    /// Whether the text input was enabled since it entered.
    enabled: bool,
    /// The browser's field, as last told.
    field: TextField,
    /// What the text input heard since its last `done`.
    preedit: Option<Preedit>,
    commit: Option<String>,
    delete: Option<[u32; 2]>,
    heard: Vec<Heard>,
}

impl ChromeEditor {
    /// Connects the stand-in to `display`, and has `handle`'s loop read what
    /// the compositor sends it.
    pub fn connect(
        display: &mut DisplayHandle,
        handle: &LoopHandle<'static, CalloopData>,
    ) -> io::Result<ChromeEditor> {
        let (ours, theirs) = UnixStream::pair()?;
        // The browser's own, so it sees what the browser would.
        let client = display.insert_client(ours, Arc::new(ClientState::chrome()))?;
        let connection = Connection::from_socket(theirs).map_err(io::Error::other)?;
        let queue = connection.new_event_queue();
        connection.display().get_registry(&queue.handle(), ());
        connection.flush().map_err(io::Error::other)?;
        let fd = connection.backend().poll_fd().try_clone_to_owned()?;
        handle
            .insert_source(
                Generic::new(fd, Interest::READ, Mode::Level),
                |_, _, data: &mut CalloopData| {
                    data.state.hear_the_stand_in();
                    Ok(PostAction::Continue)
                },
            )
            .map_err(|err| io::Error::other(err.error))?;
        debug!("the browser's stand-in editor connected");
        Ok(ChromeEditor {
            connection,
            queue,
            stand_in: StandIn::default(),
            client,
        })
    }

    /// Reads what the compositor sent the stand-in, and returns what it heard
    /// for the browser.
    pub fn hear(&mut self) -> Vec<Heard> {
        if let Some(guard) = self.queue.prepare_read() {
            if let Err(err) = guard.read() {
                if !matches!(&err, wayland_client::backend::WaylandError::Io(io) if io.kind() == io::ErrorKind::WouldBlock)
                {
                    tracing::error!(%err, "the browser's stand-in editor lost its connection");
                }
            }
        }
        if let Err(err) = self.queue.dispatch_pending(&mut self.stand_in) {
            tracing::error!(%err, "the browser's stand-in editor could not read its events");
        }
        let handle = self.queue.handle();
        self.stand_in.set_up(&handle);
        self.flush();
        std::mem::take(&mut self.stand_in.heard)
    }

    /// Takes the browser's focused field as the stand-in's text input state.
    pub fn take(&mut self, field: TextField) {
        self.stand_in.field = field;
        self.stand_in.tell_the_text_input();
        self.flush();
    }

    /// Whether the browser's field is the input method's editor: the
    /// stand-in has the keyboard and a field that takes text.
    pub fn edits(&self) -> bool {
        self.stand_in.entered && self.stand_in.field.enabled
    }

    /// The stand-in's surface, once the display has it.
    pub fn surface(&self, display: &DisplayHandle) -> Option<ServerSurface> {
        let surface = self.stand_in.surface.as_ref()?;
        self.client
            .object_from_protocol_id::<ServerSurface>(display, surface.id().protocol_id())
            .ok()
    }

    fn flush(&self) {
        if let Err(err) = self.connection.flush() {
            tracing::error!(%err, "the browser's stand-in editor could not send");
        }
    }
}

impl StandIn {
    /// Makes the surface, text input and keyboard once the globals are bound.
    fn set_up(&mut self, handle: &QueueHandle<StandIn>) {
        if self.surface.is_some() {
            return;
        }
        let (Some(compositor), Some(seat), Some(text_inputs)) =
            (&self.compositor, &self.seat, &self.text_inputs)
        else {
            return;
        };
        self.surface = Some(compositor.create_surface(handle, ()));
        self.text_input = Some(text_inputs.get_text_input(seat, handle, ()));
        self.keyboard = Some(seat.get_keyboard(handle, ()));
    }

    /// Sends the field's state, enabling the text input when a field takes
    /// text and disabling it when none does. Sent only while entered, as the
    /// protocol asks.
    fn tell_the_text_input(&mut self) {
        let Some(text_input) = &self.text_input else {
            return;
        };
        if !self.entered {
            return;
        }
        let field = &self.field;
        if !field.enabled {
            if self.enabled {
                text_input.disable();
                text_input.commit();
                self.enabled = false;
            }
            return;
        }
        if !self.enabled {
            text_input.enable();
            self.enabled = true;
        }
        if let Some(surrounding) = &field.surrounding {
            text_input.set_surrounding_text(
                surrounding.text.clone(),
                i32::try_from(surrounding.cursor).unwrap_or(i32::MAX),
                i32::try_from(surrounding.anchor).unwrap_or(i32::MAX),
            );
        }
        text_input.set_content_type(
            ContentHint::from_bits_truncate(field.hint),
            ContentPurpose::try_from(field.purpose).unwrap_or(ContentPurpose::Normal),
        );
        if let Some([x, y, width, height]) = field.cursor {
            text_input.set_cursor_rectangle(x, y, width, height);
        }
        text_input.commit();
    }
}

impl DomicileCompositor {
    /// The browser's focused field changed. Connects the stand-in on the
    /// first one.
    pub fn take_the_browsers_field(&mut self, field: TextField) {
        if self.chrome_editor.is_none() {
            if !field.enabled {
                return;
            }
            let mut display = self.display_handle.clone();
            match ChromeEditor::connect(&mut display, &self.loop_handle) {
                Ok(editor) => self.chrome_editor = Some(editor),
                Err(err) => {
                    tracing::error!(%err, "the browser's stand-in editor would not connect; pages cannot compose");
                    return;
                }
            }
        }
        if let Some(editor) = self.chrome_editor.as_mut() {
            editor.take(field);
        }
    }

    /// A browser key for the input method: through the seat to its grab
    /// while it composes, and straight back otherwise.
    pub fn key_for_the_input_method(&mut self, keycode: u32, pressed: bool) {
        if self.composing {
            self.inject_key(keycode, pressed);
        } else {
            self.tell_the_browser(Heard::KeyPassed { keycode, pressed });
        }
    }

    /// Reads the stand-in and tells the browser what it heard.
    pub fn hear_the_stand_in(&mut self) {
        let Some(editor) = self.chrome_editor.as_mut() else {
            return;
        };
        for heard in editor.hear() {
            self.tell_the_browser(heard);
        }
    }

    fn tell_the_browser(&mut self, heard: Heard) {
        let serial = self.next_ime_serial();
        self.hub.broadcast(match heard {
            Heard::Composition {
                preedit,
                commit,
                delete,
            } => HostMessage::Composition {
                serial,
                preedit,
                commit,
                delete,
            },
            Heard::KeyPassed { keycode, pressed } => HostMessage::KeyPassed {
                serial,
                keycode,
                pressed,
            },
        });
    }

    /// Serials for the browser's input method messages. They start from the
    /// clock, so they grow across compositor restarts.
    fn next_ime_serial(&mut self) -> u64 {
        let serial = self.ime_serial.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(1, |since| {
                    u64::try_from(since.as_micros()).unwrap_or(u64::MAX / 2)
                })
        });
        self.ime_serial = Some(serial + 1);
        serial
    }

    /// Gives the stand-in the keyboard whenever the browser holds it, and
    /// tells the browser when its keys start or stop going to the input
    /// method. Runs once per loop iteration.
    pub fn keep_the_browser_composing(&mut self) {
        let Some(editor) = self.chrome_editor.as_ref() else {
            return;
        };
        let keyboard = self.seat.get_keyboard().unwrap();
        // The browser holds the keyboard when no window does: on a tty it has
        // no surface of its own.
        if self.chrome_toplevel.is_none() && keyboard.current_focus().is_none() {
            if let Some(surface) = editor.surface(&self.display_handle) {
                debug!("the browser has the keyboard; its stand-in editor takes it");
                keyboard.set_focus(self, Some(surface), SERIAL_COUNTER.next_serial());
            }
        }
        let composing = self.chrome_editor.as_ref().is_some_and(ChromeEditor::edits)
            && self.seat.input_method().keyboard_grabbed()
            && !self.the_desk_is_locked();
        if composing != self.composing {
            debug!(
                composing,
                "the browser's keys go to the input method first: {composing}"
            );
            self.composing = composing;
            self.hub.broadcast(HostMessage::InputMethod { composing });
        }
    }

    /// Tells a newly connected browser whether its keys go to the input
    /// method first.
    pub fn tell_the_browser_if_composing(&self) {
        if self.composing {
            self.hub
                .broadcast(HostMessage::InputMethod { composing: true });
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for StandIn {
    fn event(
        stand_in: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Self>,
    ) {
        let wl_registry::Event::Global {
            name, interface, ..
        } = event
        else {
            return;
        };
        match interface.as_str() {
            "wl_compositor" => stand_in.compositor = Some(registry.bind(name, 4, handle, ())),
            "wl_seat" if stand_in.seat.is_none() => {
                stand_in.seat = Some(registry.bind(name, 5, handle, ()));
            }
            "zwp_text_input_manager_v3" => {
                stand_in.text_inputs = Some(registry.bind(name, 1, handle, ()));
            }
            _ => {}
        }
    }
}

impl Dispatch<ZwpTextInputV3, ()> for StandIn {
    fn event(
        stand_in: &mut Self,
        _: &ZwpTextInputV3,
        event: zwp_text_input_v3::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwp_text_input_v3::Event::Enter { .. } => {
                stand_in.entered = true;
                stand_in.enabled = false;
                stand_in.tell_the_text_input();
            }
            zwp_text_input_v3::Event::Leave { .. } => {
                if stand_in.enabled {
                    if let Some(text_input) = &stand_in.text_input {
                        text_input.disable();
                        text_input.commit();
                    }
                }
                stand_in.entered = false;
                stand_in.enabled = false;
            }
            zwp_text_input_v3::Event::PreeditString {
                text,
                cursor_begin,
                cursor_end,
            } => {
                stand_in.preedit = text.map(|text| Preedit {
                    text,
                    cursor_begin,
                    cursor_end,
                });
            }
            zwp_text_input_v3::Event::CommitString { text } => stand_in.commit = text,
            zwp_text_input_v3::Event::DeleteSurroundingText {
                before_length,
                after_length,
            } => stand_in.delete = Some([before_length, after_length]),
            zwp_text_input_v3::Event::Done { .. } => {
                let composition = Heard::Composition {
                    preedit: stand_in.preedit.take(),
                    commit: stand_in.commit.take(),
                    delete: stand_in.delete.take(),
                };
                stand_in.heard.push(composition);
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, ()> for StandIn {
    fn event(
        stand_in: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_keyboard::Event::Key { key, state, .. } = event {
            stand_in.heard.push(Heard::KeyPassed {
                keycode: key,
                pressed: matches!(state, WEnum::Value(wl_keyboard::KeyState::Pressed)),
            });
        }
    }
}

wayland_client::delegate_noop!(StandIn: ignore wl_compositor::WlCompositor);
wayland_client::delegate_noop!(StandIn: ignore wl_surface::WlSurface);
wayland_client::delegate_noop!(StandIn: ignore wl_seat::WlSeat);
wayland_client::delegate_noop!(StandIn: ignore ZwpTextInputManagerV3);

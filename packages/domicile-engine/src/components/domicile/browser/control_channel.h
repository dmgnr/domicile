// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_CONTROL_CHANNEL_H_
#define COMPONENTS_DOMICILE_BROWSER_CONTROL_CHANNEL_H_

#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "base/memory/scoped_refptr.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/values.h"
#include "base/timer/timer.h"
#include "components/domicile/browser/browser_profiles.h"
#include "components/domicile/browser/desk_activity.h"
#include "components/domicile/browser/desk_faults.h"
#include "components/domicile/browser/desk_gestures.h"
#include "components/domicile/browser/desk_modifier_taps.h"
#include "components/domicile/browser/desk_pointer.h"
#include "components/domicile/browser/extension_installer.h"
#include "components/domicile/browser/line_framer.h"
#include "components/domicile/browser/shortcut_registry.h"
#include "components/domicile/browser/spellcheck_settings.h"
#include "components/domicile/browser/system_call.h"
#include "components/domicile/mojom/control_channel.mojom.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/io_buffer.h"
#include "net/socket/unix_domain_client_socket_posix.h"
#include "ui/base/cursor/domicile/desk_cursor_image.h"
#include "ui/base/cursor/domicile/desk_cursor_theme.h"
#include "ui/base/ime/domicile/desk_input_method.h"
#include "ui/gfx/geometry/rect_f.h"

namespace domicile {

// How a keymap off this channel reaches the engine that decodes keys with it.
//
// A callback rather than a call, because the two ends are on different
// threads: this channel is read on the IO thread and the keyboard layout
// engine belongs to the UI thread, along with every evdev key dispatched
// through it. The binder that constructs a ControlChannel runs on the UI
// thread, so it is the one that can bind SetProcessKeymap to it -- and this
// target stays free of //content, which is where a task runner would otherwise
// have to come from. See components/domicile/browser/keyboard_layout.h.
using KeymapSink = base::RepeatingCallback<void(const std::string&)>;

// How a `warp_pointer` off this channel reaches the cursor it is about.
//
// A callback for KeymapSink's reason and one more. The reason: this channel is
// read on the IO thread and a cursor belongs to the UI thread, along with the
// window it is moved within -- so the binder, which runs on the UI thread,
// binds this to it. The one more: THE CURSOR IS NOT THE COMPOSITOR'S HERE.
// This message reaches no socket at all; the browser process draws the pointer
// and the browser process moves it, which is why what the page asked for stops
// in a callback rather than in a line of JSON. A page's own coordinates, in
// CSS pixels, so this target stays free of //ui and of the window the point is
// clamped into. See components/domicile/browser/pointer_warp.h.
// `unless_over` is the box the pointer stays put over; see
// `PointerAlreadyOver`.
using PointerWarpSink = base::RepeatingCallback<
    void(double x, double y, const std::optional<gfx::RectF>& unless_over)>;

// How a `confine_pointer` reaches the cursor it is about, for
// PointerWarpSink's reasons: boxes in the page's CSS pixels, none to let go.
// `confined` is answered on this channel's sequence with whether the platform
// can hold the pointer.
using PointerConfineSink = base::RepeatingCallback<void(
    const std::vector<gfx::RectF>& boxes,
    base::OnceCallback<void(bool confined)> confined)>;

// How the desktop's theme reaches the color scheme every page in this process
// is drawn in. A callback for KeymapSink's reason: NativeTheme belongs to the
// UI thread. See components/domicile/browser/color_scheme.h.
using ThemeSink = base::RepeatingCallback<void(mojom::Theme)>;

// How the extensions the desk's config names reach the profile they are
// installed into. A callback for KeymapSink's reason: a Profile and its
// ExtensionService belong to the UI thread, and both are //chrome. See
// components/domicile/browser/extension_installer.h.
using ExtensionsSink = base::RepeatingCallback<void(const ExtensionList&)>;

// How the desk's pointer theme reaches the cursor factory that draws from it,
// or nullopt for Chromium's own art. A callback for KeymapSink's reason: the
// cursor belongs to the UI thread. See
// ui/base/cursor/domicile/desk_cursor_theme.h.
using CursorThemeSink =
    base::RepeatingCallback<void(std::optional<ui::DeskCursorTheme>)>;

// How the sites the desk's config draws dark reach the process that draws
// them. A callback for KeymapSink's reason: WebPreferences are computed on the
// UI thread. See components/domicile/browser/force_dark.h.
using ForceDarkSink =
    base::RepeatingCallback<void(std::vector<std::string>)>;

// How the desk's browser profiles reach the profile the shell is in, with the
// shell frame whose channel heard them. Process-wide rather than a constructor
// argument, as WebViewGuest::SetInspect: //chrome sets it once with
// SetBrowserProfilesSink, before any channel; a test sets one and gives it back
// with a null sink. A callback for KeymapSink's
// reason: a Profile belongs to the UI thread. See
// chrome/browser/domicile/domicile_browser_profiles.h.
using BrowserProfilesSink =
    base::RepeatingCallback<void(const Page&, const BrowserProfiles&)>;
void SetBrowserProfilesSink(BrowserProfilesSink sink);

// How the desk's spell checking reaches the browser's profiles. Process-wide
// as BrowserProfilesSink: //chrome sets it once with SetSpellcheckSink, before
// any channel; a test sets one and gives it back with a null sink. See
// chrome/browser/domicile/domicile_spellcheck.h.
using SpellcheckSink =
    base::RepeatingCallback<void(const SpellcheckSettings&)>;
void SetSpellcheckSink(SpellcheckSink sink);

// The shell's control channel, in the browser process.
//
// Speaks newline-delimited JSON over the compositor's unix control socket --
// the same protocol the deleted WebSocket bridge carried, byte for byte, so
// the compositor did not have to change. What changed is who may speak it: a
// mojo interface bound for the shell's origin, rather than a TCP port every
// process on the machine could reach.
class ControlChannel : public mojom::ControlChannel {
 public:
  // `socket_path` is the compositor's --chrome-socket. `client` is how
  // messages coming the other way reach the page.
  // Owns its own receiver and deletes itself when the page goes away, or when
  // no compositor answers for kReachFor -- at the start or after one hangs up.
  // The page's end is closed then, which is the only way a shell can tell:
  // resetting just the client remote silences the inbound direction and leaves
  // the page holding a channel that looks alive and swallows everything
  // written to it.
  // `page` is the frame the channel was bound for, which is what a chord
  // pressed in one of its `<webview>`s is delivered by -- see ShortcutRegistry.
  ControlChannel(const std::string& socket_path,
                 mojo::PendingReceiver<mojom::ControlChannel> receiver,
                 KeymapSink keymap_sink,
                 PointerWarpSink warp_sink,
                 PointerConfineSink confine_sink,
                 ThemeSink theme_sink,
                 ExtensionsSink extensions_sink,
                 CursorThemeSink cursor_theme_sink,
                 ForceDarkSink force_dark_sink,
                 const Page& page);

  ControlChannel(const ControlChannel&) = delete;
  ControlChannel& operator=(const ControlChannel&) = delete;

  ~ControlChannel() override;

  // mojom::ControlChannel:
  void SetClient(
      mojo::PendingRemote<mojom::ControlChannelClient> client) override;
  void Spawn(const std::vector<std::string>& command) override;
  void SearchFiles(const std::string& query) override;
  void CallSystem(uint32_t id, const std::string& request) override;
  void AnswerPortalRequest(uint32_t id, const std::string& answer) override;
  void CopyClipboardEntry(uint32_t entry) override;
  void RemoveClipboardEntry(uint32_t entry) override;
  void ActivateTrayItem(const std::string& id,
                        mojom::TrayAction action) override;
  void DismissNotifications(const std::vector<uint32_t>& ids) override;
  void InvokeNotificationAction(uint32_t id,
                                const std::string& action) override;
  void ReplyToNotification(uint32_t id, const std::string& text) override;
  void FocusApp(const std::string& app_id) override;
  void FocusChrome() override;
  void SyncFrames() override;
  void WarpPointer(double x,
                   double y,
                   const std::optional<gfx::RectF>& unless_over) override;
  void ConfinePointer(const std::vector<gfx::RectF>& boxes,
                      ConfinePointerCallback confined) override;
  void CloseApp(const std::string& app_id) override;
  void SetAppBounds(const std::string& app_id,
                    double x,
                    double y,
                    double width,
                    double height) override;
  void SetDesktopSize(double width, double height) override;
  void SetDevicePixelRatio(double ratio) override;
  void SetTheme(mojom::Theme theme) override;
  void Unlock(const std::string& passphrase) override;
  void Lock() override;
  void ThemeCaptured(mojom::Theme theme) override;
  void ShellRan(const std::string& serial) override;
  void ShellFailed(const std::string& serial, const std::string& why) override;
  void GrabShortcut(mojom::ShortcutPtr shortcut) override;
  void UngrabShortcut(mojom::ShortcutPtr shortcut) override;
  void GrabGesture(mojom::GestureGrabPtr grab) override;
  void UngrabGesture(mojom::GestureGrabPtr grab) override;
  void GrabModifierTap(mojom::TapModifier modifier,
                       bool while_inhibited,
                       base::TimeDelta longest) override;
  void UngrabModifierTap(mojom::TapModifier modifier) override;
  void KeyboardWindowInhibitsShortcuts(bool inhibits) override;
  void Key(const std::string& app_id, uint32_t keycode, bool pressed) override;
  void PointerMotion(const std::string& app_id,
                     double x,
                     double y,
                     bool moved) override;
  void PointerRelative(const std::string& app_id,
                       double dx,
                       double dy,
                       double dx_unaccel,
                       double dy_unaccel) override;
  void PointerConstrained(const std::string& app_id, bool active) override;
  void PointerLeave(const std::string& app_id) override;
  void PointerButton(const std::string& app_id,
                     uint32_t button,
                     bool pressed) override;
  void PointerPinch(const std::string& app_id, mojom::PinchPtr pinch) override;
  void Touch(const std::string& app_id, mojom::TouchPtr touch) override;
  void PointerAxis(const std::string& app_id,
                   double dx,
                   double dy,
                   int32_t v120_x,
                   int32_t v120_y,
                   mojom::PointerAxisSource source,
                   bool stop_x,
                   bool stop_y) override;

 private:
  // THE SOCKET IS EXPECTED TO BE MISSING AT FIRST, AND THAT IS THE LAUNCH
  // ORDER RATHER THAN A FAULT. The browser has to be running before the
  // compositor can connect to it as a producer, so the shell is loaded -- and
  // this channel opened -- while the compositor is still starting. Giving up on
  // the first ENOENT would hand every shell a dead channel on every launch.
  //
  // Bounded, because a page that will never have a compositor should find out
  // rather than sit there. These are the deleted bridge's numbers, kept so the
  // behavior a shell sees does not change with the transport under it.
  static constexpr base::TimeDelta kReachFor = base::Seconds(30);
  static constexpr base::TimeDelta kRetryEvery = base::Milliseconds(50);

  // The version this speaks in `hello`. Must match the SDK's PROTOCOL_VERSION;
  // a mismatch is what `welcome` exists to catch.
  static constexpr int kProtocolVersion = 1;

  void Connect();
  void OnConnect(int result);
  void OnConnectFailed();
  // The compositor hung up. Ends for the page what that compositor had --
  // every call with `compositor_gone`, every window with `app_closed` -- and
  // dials the next one, for kReachFor like the first. See "A compositor
  // restart" in docs/architecture/ENGINE-FORK.md.
  void OnHungUp();

  // Serialize a dict and queue it. Every outbound member funnels through here,
  // so the framing and the queueing exist once rather than seventeen times.
  void SendMessage(base::DictValue message);
  void Send(const std::string& json_line);
  void FlushQueue();
  void WriteNext();
  void OnWrite(int result);
  // Puts the line being written back at the front of the queue.
  void RequeueTheLineInFlight();

  // The registry's three deliveries, on this channel's own sequence. All are
  // registered wrapped in base::BindPostTask, because a press is matched on the
  // UI thread and `client_` is a mojo remote bound to the IO thread.
  void DeliverShortcut(Chord chord);
  void DeliverRelease(Chord chord);
  void DeliverModifiers(Modifiers modifiers);
  // A phase of a touchpad gesture this page took; see DeskGestures. Posted
  // here for DeliverShortcut's reason: gestures arrive on the input thread.
  void DeliverGesture(const ui::NativeGesture& gesture);
  // A phase of a swipe or hold the shell did not grab, for the compositor to
  // give the native window under the pointer. Dropped while no compositor is
  // connected: its gesture would begin on a window it never heard of.
  void ForwardGesture(const ui::NativeGesture& gesture);
  // A tap of a modifier alone this page grabbed; see DeskModifierTaps.
  // Posted here for DeliverShortcut's reason.
  void DeliverModifierTap(TapModifier modifier, base::TimeDelta held);
  // Somebody used the desk; see DeskActivity. Dropped while no compositor is
  // connected: the next one starts its idle clock fresh.
  void SomebodyIsHere(const std::string& input);
  // The engine caught itself in a bug; see DeskFaults. Held while no
  // compositor is connected, so the person still hears of it.
  void FaultFound(const std::string& what);
  // The pointer moved on the desk; see DeskPointer. Dropped while no
  // compositor is connected, like SomebodyIsHere.
  void DeskPointerMoved(const DeskPointerAt& at);
  // The pointer on screen changed; see ui::DeskCursorImageSource. Dropped
  // while no compositor is connected: the next one is sent the pointer as it
  // is then, after `hello`.
  void DeskCursorChanged(const ui::DeskCursorImage& image);
  // The focused field changed, or a key goes to the input method first; see
  // ui::DeskInputMethod. Sent by the one channel it picked. Dropped while no
  // compositor is connected: with none there is no input method either.
  void SendTextField(const ui::DeskTextField& field);
  void SendKeyForInputMethod(uint32_t evdev_code, bool pressed);

  void ReadLoop();
  void OnRead(int result);
  // One complete line off the socket. Anything unparseable is dropped with a
  // log rather than closing the channel: a message this build does not know
  // about is a compositor newer than it, not a broken stream.
  // `from_compositor` is false for a line this channel made or held, which
  // Track has already seen or must not.
  void DispatchLine(const std::string& line, bool from_compositor);
  // What `line` says of a window or a call, kept for OnHungUp.
  void Track(const base::DictValue& message);

  const std::string socket_path_;
  const KeymapSink keymap_sink_;
  const PointerWarpSink warp_sink_;
  const PointerConfineSink confine_sink_;
  const ThemeSink theme_sink_;
  const ExtensionsSink extensions_sink_;
  const CursorThemeSink cursor_theme_sink_;
  const ForceDarkSink force_dark_sink_;
  // The frame the channel was bound for, which BrowserProfilesSink is told.
  const Page page_;
  mojo::Receiver<mojom::ControlChannel> receiver_;
  mojo::Remote<mojom::ControlChannelClient> client_;

  // This page's registration with the process's shortcut registry, given back
  // in the destructor. The claims it made are not: the desktop's keys stay the
  // desktop's across a reload, and a gap between the two is a chord delivered
  // to whatever window is focused instead.
  ShortcutRegistry::ChannelId channel_;
  // This channel's registration with the process's DeskActivity, given back in
  // the destructor.
  DeskActivity::ListenerId activity_;
  // And with the process's DeskFaults.
  DeskFaults::ListenerId faults_;
  // And with the process's DeskPointer.
  DeskPointer::ListenerId pointer_;
  // And with the process's DeskGestures, which forgets this page's grabs with
  // it: a reloaded shell grabs its gestures again.
  DeskGestures::ChannelId gestures_;
  // And with the process's DeskModifierTaps, likewise.
  DeskModifierTaps::ChannelId taps_;
  // And with the process's ui::DeskCursorImageSource.
  ui::DeskCursorImageSource::ListenerId cursor_;
  // And with the process's ui::DeskInputMethod.
  ui::DeskInputMethod::ChannelId input_method_;

  std::unique_ptr<net::UnixDomainClientSocket> socket_;
  bool connected_ = false;
  // Whether a compositor has ever answered, so the next one is a replacement.
  bool ever_connected_ = false;

  // What OnHungUp ends: the compositor's windows the page has heard of, and
  // the page's system calls.
  std::set<std::string> open_apps_;
  OpenCalls calls_;

  base::TimeTicks give_up_at_;
  base::OneShotTimer retry_timer_;

  // What the page said while no compositor was connected, in order: before the
  // first, or between one hanging up and the next. The deleted bridge queued
  // these too, and dropping them instead would lose exactly the messages a
  // shell sends at startup.
  std::vector<std::string> pending_;
  bool writing_ = false;
  std::string write_buffer_;
  size_t write_offset_ = 0;

  // The page's lines that arrived before its SetClient, in order. Filled only
  // until then, since `client_` stays bound after it.
  std::vector<std::string> held_;

  scoped_refptr<net::IOBuffer> read_buffer_;
  // One per compositor: a line the last one left half-written is not the
  // next one's.
  std::unique_ptr<LineFramer> framer_ = std::make_unique<LineFramer>();

  base::WeakPtrFactory<ControlChannel> weak_factory_{this};
};

// Bind a control channel for a frame, reading the compositor's socket path off
// the command line. Self-owned: it lives as long as the pipe does.
//
// THIS IS NOT THE ACCESS CONTROL. The caller decides who may reach it, and
// that decision -- registering the interface only for a document whose origin
// is domicile:// -- is the whole of the security property. See
// PopulateChromeFrameBinders.
void BindControlChannel(mojo::PendingReceiver<mojom::ControlChannel> receiver,
                        KeymapSink keymap_sink,
                        PointerWarpSink warp_sink,
                        PointerConfineSink confine_sink,
                        ThemeSink theme_sink,
                        ExtensionsSink extensions_sink,
                        CursorThemeSink cursor_theme_sink,
                        ForceDarkSink force_dark_sink,
                        const Page& page);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_CONTROL_CHANNEL_H_

// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/control_channel.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/check.h"
#include "base/containers/flat_map.h"
#include "base/command_line.h"
#include "base/dcheck_is_on.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/notreached.h"
#include "base/task/bind_post_task.h"
#include "base/values.h"
#include "components/domicile/browser/desk_lock.h"
#include "components/domicile/browser/desk_pointer_hiding.h"
#include "components/domicile/browser/input_method_lines.h"
#include "components/domicile/browser/portal_request.h"
#include "components/domicile/browser/shell_swap.h"
#include "components/domicile/browser/system_call.h"
#include "components/domicile/common/cursor_shape.h"
#include "components/domicile/common/display_transform.h"
#include "components/domicile/common/domicile_scheme.h"
#include "components/domicile/common/theme.h"
#include "net/base/net_errors.h"

namespace domicile {
namespace {

// Storage for SetBrowserProfilesSink's callback.
BrowserProfilesSink& BrowserProfilesSlot() {
  static base::NoDestructor<BrowserProfilesSink> sink;
  return *sink;
}

// Storage for SetSpellcheckSink's callback.
SpellcheckSink& SpellcheckSlot() {
  static base::NoDestructor<SpellcheckSink> sink;
  return *sink;
}

// The read buffer. One message is a line of JSON; this is sized for a batch of
// them rather than for the largest one, because the remainder is carried across
// reads anyway.
constexpr int kReadBufferSize = 16 * 1024;

std::string Line(const base::DictValue& message) {
  std::string line;
  base::JSONWriter::Write(message, &line);
  return line;
}

// `desk_cursor`: the pointer on screen, or no `image` while it is hidden.
base::DictValue DeskCursorMessage(const ui::DeskCursorImage& image) {
  base::DictValue message;
  message.Set("type", "desk_cursor");
  if (image.hidden()) {
    return message;
  }
  const auto pair = [](int x, int y) {
    base::ListValue list;
    list.Append(x);
    list.Append(y);
    return list;
  };
  message.Set(
      "image",
      base::DictValue()
          .Set("size", pair(image.size.width(), image.size.height()))
          .Set("hotspot", pair(image.hotspot.x(), image.hotspot.y()))
          .Set("scale", static_cast<double>(image.scale))
          .Set("bgra", base::Base64Encode(image.bgra)));
  return message;
}

ui::NativeGestureKind GestureKindFromMojo(mojom::GestureKind kind) {
  switch (kind) {
    case mojom::GestureKind::kSwipe:
      return ui::NativeGestureKind::kSwipe;
    case mojom::GestureKind::kPinch:
      return ui::NativeGestureKind::kPinch;
    case mojom::GestureKind::kHold:
      return ui::NativeGestureKind::kHold;
    case mojom::GestureKind::kEdge:
      return ui::NativeGestureKind::kEdge;
  }
  NOTREACHED();
}

mojom::GestureKind GestureKindToMojo(ui::NativeGestureKind kind) {
  switch (kind) {
    case ui::NativeGestureKind::kSwipe:
      return mojom::GestureKind::kSwipe;
    case ui::NativeGestureKind::kPinch:
      return mojom::GestureKind::kPinch;
    case ui::NativeGestureKind::kHold:
      return mojom::GestureKind::kHold;
    case ui::NativeGestureKind::kEdge:
      return mojom::GestureKind::kEdge;
  }
  NOTREACHED();
}

std::optional<ui::NativeGestureEdge> GestureEdgeFromMojo(
    std::optional<mojom::GestureEdge> edge) {
  if (!edge) {
    return std::nullopt;
  }
  switch (*edge) {
    case mojom::GestureEdge::kLeft:
      return ui::NativeGestureEdge::kLeft;
    case mojom::GestureEdge::kRight:
      return ui::NativeGestureEdge::kRight;
    case mojom::GestureEdge::kTop:
      return ui::NativeGestureEdge::kTop;
    case mojom::GestureEdge::kBottom:
      return ui::NativeGestureEdge::kBottom;
  }
  NOTREACHED();
}

std::optional<mojom::GestureEdge> GestureEdgeToMojo(
    std::optional<ui::NativeGestureEdge> edge) {
  if (!edge) {
    return std::nullopt;
  }
  switch (*edge) {
    case ui::NativeGestureEdge::kLeft:
      return mojom::GestureEdge::kLeft;
    case ui::NativeGestureEdge::kRight:
      return mojom::GestureEdge::kRight;
    case ui::NativeGestureEdge::kTop:
      return mojom::GestureEdge::kTop;
    case ui::NativeGestureEdge::kBottom:
      return mojom::GestureEdge::kBottom;
  }
  NOTREACHED();
}

mojom::GesturePhase GesturePhaseToMojo(ui::NativeGesturePhase phase) {
  switch (phase) {
    case ui::NativeGesturePhase::kBegin:
      return mojom::GesturePhase::kBegin;
    case ui::NativeGesturePhase::kUpdate:
      return mojom::GesturePhase::kUpdate;
    case ui::NativeGesturePhase::kEnd:
      return mojom::GesturePhase::kEnd;
  }
  NOTREACHED();
}

TapModifier TapModifierFromMojo(mojom::TapModifier modifier) {
  switch (modifier) {
    case mojom::TapModifier::kAlt:
      return TapModifier::kAlt;
    case mojom::TapModifier::kCtrl:
      return TapModifier::kCtrl;
    case mojom::TapModifier::kShift:
      return TapModifier::kShift;
    case mojom::TapModifier::kMeta:
      return TapModifier::kMeta;
  }
}

mojom::TapModifier TapModifierToMojo(TapModifier modifier) {
  switch (modifier) {
    case TapModifier::kAlt:
      return mojom::TapModifier::kAlt;
    case TapModifier::kCtrl:
      return mojom::TapModifier::kCtrl;
    case TapModifier::kShift:
      return mojom::TapModifier::kShift;
    case TapModifier::kMeta:
      return mojom::TapModifier::kMeta;
  }
}

GestureGrab GestureGrabFromMojo(const mojom::GestureGrab& grab) {
  return GestureGrab{GestureKindFromMojo(grab.kind), grab.fingers,
                     GestureEdgeFromMojo(grab.edge)};
}

}  // namespace

ControlChannel::ControlChannel(
    const std::string& socket_path,
    mojo::PendingReceiver<mojom::ControlChannel> receiver,
    KeymapSink keymap_sink,
    PointerWarpSink warp_sink,
    PointerConfineSink confine_sink,
    ThemeSink theme_sink,
    ExtensionsSink extensions_sink,
    CursorThemeSink cursor_theme_sink,
    ForceDarkSink force_dark_sink,
    const Page& page)
    : socket_path_(socket_path),
      keymap_sink_(std::move(keymap_sink)),
      warp_sink_(std::move(warp_sink)),
      confine_sink_(std::move(confine_sink)),
      theme_sink_(std::move(theme_sink)),
      extensions_sink_(std::move(extensions_sink)),
      cursor_theme_sink_(std::move(cursor_theme_sink)),
      force_dark_sink_(std::move(force_dark_sink)),
      page_(page),
      receiver_(this, std::move(receiver)),
      read_buffer_(
          base::MakeRefCounted<net::IOBufferWithSize>(kReadBufferSize)) {
  // The page going away takes this with it; nothing else owns it.
  receiver_.set_disconnect_handler(
      base::BindOnce([](ControlChannel* self) { delete self; },
                     base::Unretained(this)));
  // Both directions of the shortcut leg, in one place. The registry matches a
  // chord wherever the key arrived -- which for a browser window is the UI
  // thread, in the guest's delegate -- so what it is handed is posted back
  // here, where `client_` is bound and where this object may be touched at all.
  channel_ = ShortcutRegistry::Get().AddChannel(
      page,
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeliverShortcut, weak_factory_.GetWeakPtr())),
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeliverRelease, weak_factory_.GetWeakPtr())),
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeliverModifiers, weak_factory_.GetWeakPtr())));
  activity_ = DeskActivity::Get().AddListener(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::SomebodyIsHere, weak_factory_.GetWeakPtr())));
  faults_ = DeskFaults::Get().AddListener(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::FaultFound, weak_factory_.GetWeakPtr())));
  gestures_ = DeskGestures::Get().AddChannel(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeliverGesture, weak_factory_.GetWeakPtr())),
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::ForwardGesture, weak_factory_.GetWeakPtr())));
  taps_ = DeskModifierTaps::Get().AddChannel(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeliverModifierTap, weak_factory_.GetWeakPtr())));
  pointer_ = DeskPointer::Get().AddListener(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeskPointerMoved, weak_factory_.GetWeakPtr())));
  cursor_ = ui::DeskCursorImageSource::Get().AddListener(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::DeskCursorChanged, weak_factory_.GetWeakPtr())));
  // The field is changed and a key typed on the UI thread, where the window's
  // input method is; both are posted here like the registry's deliveries.
  input_method_ = ui::DeskInputMethod::Get().AddChannel(
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::SendTextField, weak_factory_.GetWeakPtr())),
      base::BindPostTaskToCurrentDefault(base::BindRepeating(
          &ControlChannel::SendKeyForInputMethod,
          weak_factory_.GetWeakPtr())));
  give_up_at_ = base::TimeTicks::Now() + kReachFor;
  Connect();
}

ControlChannel::~ControlChannel() {
  ui::DeskInputMethod::Get().RemoveChannel(input_method_);
  ui::DeskCursorImageSource::Get().RemoveListener(cursor_);
  DeskPointer::Get().RemoveListener(pointer_);
  DeskModifierTaps::Get().RemoveChannel(taps_);
  DeskGestures::Get().RemoveChannel(gestures_);
  DeskFaults::Get().RemoveListener(faults_);
  DeskActivity::Get().RemoveListener(activity_);
  ShortcutRegistry::Get().RemoveChannel(channel_);
}

void ControlChannel::Connect() {
  socket_ = std::make_unique<net::UnixDomainClientSocket>(
      socket_path_, /*use_abstract_namespace=*/false);
  const int result = socket_->Connect(base::BindOnce(
      &ControlChannel::OnConnect, weak_factory_.GetWeakPtr()));
  if (result != net::ERR_IO_PENDING) {
    OnConnect(result);
  }
}

void ControlChannel::OnConnect(int result) {
  if (result != net::OK) {
    OnConnectFailed();
    return;
  }

  connected_ = true;
  const bool replacing = ever_connected_;
  ever_connected_ = true;

  // The handshake, which the page used to send and the browser now owns. A
  // compositor that disagrees about the version says so in `welcome`, and that
  // is the check this exists for.
  base::DictValue hello;
  hello.Set("type", "hello");
  hello.Set("protocol_version", kProtocolVersion);
  // A checked build is much slower; the compositor tells the person.
  hello.Set("checked", DCHECK_IS_ON());
  std::vector<std::string> greeting;
  std::string line;
  if (base::JSONWriter::Write(hello, &line)) {
    greeting.push_back(line);
  }
  // Then the pointer as it is, which the compositor otherwise hears only
  // when it next changes.
  if (const std::optional<ui::DeskCursorImage> cursor =
          ui::DeskCursorImageSource::Get().current()) {
    greeting.push_back(Line(DeskCursorMessage(*cursor)));
  }
  pending_.insert(pending_.begin(), greeting.begin(), greeting.end());

  // Before anything the new compositor says, so the page resubscribes against
  // the desk state that follows. A page with no client yet has nothing to
  // resubscribe.
  if (replacing && client_) {
    client_->CompositorReplaced();
  }

  ReadLoop();
  FlushQueue();
}

void ControlChannel::OnHungUp() {
  connected_ = false;
  // The input method went with the compositor. A key held for it is never
  // passed back, so the window's next key is no longer held behind it.
  ui::DeskInputMethod::Get().SetComposing(false);
  if (writing_) {
    RequeueTheLineInFlight();
  }
  socket_.reset();
  framer_ = std::make_unique<LineFramer>();

  // A queued call is ended below, so the next compositor must not answer it
  // too. Everything else the page said still goes: a line about a window the
  // next compositor never had is one it ignores.
  std::erase_if(pending_, [](const std::string& line) {
    return IsSystemRequestLine(line);
  });

  for (const std::string& line : calls_.EndAll()) {
    DispatchLine(line, /*from_compositor=*/false);
  }
  std::set<std::string> apps;
  apps.swap(open_apps_);
  for (const std::string& app_id : apps) {
    base::DictValue closed;
    closed.Set("type", "app_closed");
    closed.Set("app_id", app_id);
    DispatchLine(Line(closed), /*from_compositor=*/false);
  }

  LOG(WARNING) << "domicile: the compositor on " << socket_path_
               << " hung up; waiting " << kReachFor.InSeconds()
               << "s for the next one.";
  give_up_at_ = base::TimeTicks::Now() + kReachFor;
  Connect();
}

void ControlChannel::OnConnectFailed() {
  socket_.reset();
  if (base::TimeTicks::Now() >= give_up_at_) {
    // Say so rather than sit there. A shell whose channel never connected has
    // no desktop behind it, and silence is the failure mode ERRORS.md exists to
    // prevent.
    LOG(ERROR) << "domicile: no compositor on " << socket_path_ << " after "
               << kReachFor.InSeconds()
               << "s. The desktop's control channel will not connect; the "
                  "shell will render but no window will work.";
    client_.reset();
    // Closing the page's end is what makes the failure visible. `this` is
    // destroyed by the disconnect handler, so nothing may touch it after.
    receiver_.reset();
    delete this;
    return;
  }
  retry_timer_.Start(FROM_HERE, kRetryEvery,
                     base::BindOnce(&ControlChannel::Connect,
                                    weak_factory_.GetWeakPtr()));
}

void ControlChannel::SetClient(
    mojo::PendingRemote<mojom::ControlChannelClient> client) {
  client_.Bind(std::move(client));
  // Swapped out rather than read in place, so the vector is freed and nothing
  // is held once the page is bound.
  std::vector<std::string> held;
  held.swap(held_);
  for (const std::string& line : held) {
    DispatchLine(line, /*from_compositor=*/false);
  }
}

void ControlChannel::Spawn(const std::vector<std::string>& command) {
  // An empty argv is refused here as well as in the renderer, because the
  // renderer's check is advice: this process is the one that must not hand an
  // empty command to the compositor.
  if (command.empty()) {
    return;
  }

  base::ListValue argv;
  for (const std::string& argument : command) {
    argv.Append(argument);
  }
  base::DictValue message;
  message.Set("type", "spawn");
  message.Set("command", std::move(argv));

  std::string line;
  if (!base::JSONWriter::Write(message, &line)) {
    return;
  }
  Send(line);
}

void ControlChannel::SendMessage(base::DictValue message) {
  std::string line;
  if (!base::JSONWriter::Write(message, &line)) {
    return;
  }
  Send(line);
}

namespace {

base::DictValue Typed(const char* type) {
  base::DictValue message;
  message.Set("type", type);
  return message;
}

base::DictValue ForApp(const char* type, const std::string& app_id) {
  base::DictValue message = Typed(type);
  message.Set("app_id", app_id);
  return message;
}

base::ListValue Size(double width, double height) {
  base::ListValue size;
  size.Append(width);
  size.Append(height);
  return size;
}

// A number the compositor wrote, whichever way it wrote it.
//
// Not GetIfInt: the compositor's sizes are f64, and serde renders 800.0 with
// the decimal point, which a JSON reader types as a double. Asking for an int
// gets nothing and the size arrives as zero -- which is exactly the "opened
// windows at nothing at all" failure the absent-size handling above exists to
// prevent, arriving through the type instead of through the absence.
double Number(const base::Value& value) {
  if (std::optional<double> number = value.GetIfDouble()) {
    return *number;
  }
  return 0.0;
}

mojom::WindowSandboxPtr SandboxOf(const base::DictValue* sandbox);

// A window's owner, or null for a message with none or a malformed one. The
// uid, gid and inode go through a double because base::Value's whole numbers
// are a signed int, which a uid above 2^31 does not fit.
mojom::WindowOwnerPtr OwnerOf(const base::DictValue* owner) {
  if (!owner) {
    return nullptr;
  }
  const std::optional<int> pid = owner->FindInt("pid");
  const std::optional<double> uid = owner->FindDouble("uid");
  const std::optional<double> gid = owner->FindDouble("gid");
  if (!pid || !uid || !gid) {
    return nullptr;
  }
  std::optional<uint64_t> pidfd_inode;
  if (std::optional<double> inode = owner->FindDouble("pidfd_inode")) {
    pidfd_inode = static_cast<uint64_t>(*inode);
  }
  return mojom::WindowOwner::New(*pid, static_cast<uint32_t>(*uid),
                                 static_cast<uint32_t>(*gid), pidfd_inode,
                                 SandboxOf(owner->FindDict("sandbox")));
}

// A client's own cursor image from `app_cursor`'s `image`, or null for none or
// one missing a part. A PNG is passed on as the compositor encoded it; the
// page's cursor decodes it, as it does any CSS cursor image.
mojom::AppCursorImagePtr CursorImageOf(const base::DictValue* image) {
  if (!image) {
    return nullptr;
  }
  const std::string* png = image->FindString("png");
  const base::ListValue* hotspot = image->FindList("hotspot");
  const std::optional<int> scale = image->FindInt("scale");
  if (!png || !hotspot || hotspot->size() != 2 || !(*hotspot)[0].is_int() ||
      !(*hotspot)[1].is_int() || !scale || *scale < 1) {
    return nullptr;
  }
  return mojom::AppCursorImage::New(*png, (*hotspot)[0].GetInt(),
                                    (*hotspot)[1].GetInt(), *scale);
}

// A message's synced `frame`, 0 when absent. A whole number from base::Value
// is a signed int, which a frame counted at 60 a second fills in a year.
uint32_t FrameOf(const base::DictValue& message) {
  return static_cast<uint32_t>(
      std::max(message.FindInt("frame").value_or(0), 0));
}

// The synced frames a move shows with. An entry with no app or a negative
// frame is dropped: the page keeps the frame it shows.
std::vector<mojom::AppFramePtr> FramesOf(const base::ListValue* frames) {
  std::vector<mojom::AppFramePtr> told;
  if (!frames) {
    return told;
  }
  for (const base::Value& entry : *frames) {
    const base::DictValue* frame = entry.GetIfDict();
    if (!frame) {
      continue;
    }
    const std::string* app_id = frame->FindString("app_id");
    const std::optional<int> number = frame->FindInt("frame");
    if (app_id && number && *number >= 0) {
      told.push_back(
          mojom::AppFrame::New(*app_id, static_cast<uint32_t>(*number)));
    }
  }
  return told;
}

// A string the sandbox engine may leave unset.
std::optional<std::string> Unset(const std::string* value) {
  return value ? std::make_optional(*value) : std::nullopt;
}

// A window's sandbox, or null for an unsandboxed client.
mojom::WindowSandboxPtr SandboxOf(const base::DictValue* sandbox) {
  if (!sandbox) {
    return nullptr;
  }
  return mojom::WindowSandbox::New(Unset(sandbox->FindString("engine")),
                                   Unset(sandbox->FindString("app_id")),
                                   Unset(sandbox->FindString("instance_id")));
}

// Which way up a monitor is, by the name the compositor wrote.
//
// A missing field and a name nothing matches both come out kNormal, and NOT
// because it is the tidy default. A cursor nobody knows is worth dropping the
// message over -- `cursor_shape.h` says why -- but this message is the whole
// desktop, and refusing it over one unreadable field would leave the shell
// with no screens rather than with a monitor the wrong way up. `normal` is
// the arrangement that is right whenever there is nothing to turn, and it is
// what a page produces if it never hears of transforms at all, so it is what
// a page gets when this cannot tell.
mojom::DisplayTransform TransformNamed(const std::string* named) {
  if (!named) {
    return mojom::DisplayTransform::kNormal;
  }
  return DisplayTransformFromWire<mojom::DisplayTransform>(*named).value_or(
      mojom::DisplayTransform::kNormal);
}

// The wire's adaptive sync or HDR state, or `unsupported` for one this
// browser has no name for, which asks nothing of a shell.
std::string SupportNamed(const std::string* named) {
  if (named && (*named == "off" || *named == "on")) {
    return *named;
  }
  return "unsupported";
}

// `key` in `message`, if it is a list of strings and nothing else. One entry
// that is not a string refuses the whole list: a list with an entry quietly
// missing is a desk whose installer uninstalls what that entry named.
std::optional<std::vector<std::string>> Strings(
    const base::DictValue& message,
    std::string_view key) {
  const base::ListValue* list = message.FindList(key);
  if (!list) {
    return std::nullopt;
  }
  std::vector<std::string> strings;
  strings.reserve(list->size());
  for (const base::Value& entry : *list) {
    const std::string* text = entry.GetIfString();
    if (!text) {
      return std::nullopt;
    }
    strings.push_back(*text);
  }
  return strings;
}

}  // namespace

void ControlChannel::FocusApp(const std::string& app_id) {
  SendMessage(ForApp("focus_app", app_id));
}

// Words to match and nothing else: the message asks the compositor what in
// the home matches, and says nothing about where to look.
void ControlChannel::SearchFiles(const std::string& query) {
  base::DictValue message = Typed("search_files");
  message.Set("query", query);
  SendMessage(std::move(message));
}

// Wrapped rather than read: the compositor judges the call. See
// components/domicile/browser/system_call.h.
void ControlChannel::CallSystem(uint32_t id, const std::string& request) {
  std::optional<std::string> line = SystemRequestLine(id, request);
  if (!line) {
    LOG(WARNING) << "domicile: a page's system call " << id
                 << " is not a JSON object with a `call`; it was dropped.";
    return;
  }
  calls_.Called(id);
  Send(*line);
}

// Wrapped rather than read, like CallSystem: the compositor judges the answer.
// See components/domicile/browser/portal_request.h.
void ControlChannel::AnswerPortalRequest(uint32_t id,
                                         const std::string& answer) {
  std::optional<std::string> line = PortalAnswerLine(id, answer);
  if (!line) {
    LOG(WARNING) << "domicile: a page's answer to portal request " << id
                 << " is not a JSON object with a `kind`; it was dropped.";
    return;
  }
  Send(*line);
}

// The one member that names a row of the clipboard, and the whole of what a
// page may do to the seat's selection: it says which of the things already
// copied to put back, and cannot say what was copied.
void ControlChannel::CopyClipboardEntry(uint32_t entry) {
  base::DictValue message = Typed("copy_clipboard_entry");
  message.Set("entry", static_cast<int>(entry));
  SendMessage(std::move(message));
}

// An id, as CopyClipboardEntry's is: a page can forget a copy but not name one
// that was never made.
void ControlChannel::RemoveClipboardEntry(uint32_t entry) {
  base::DictValue message = Typed("remove_clipboard_entry");
  message.Set("entry", static_cast<int>(entry));
  SendMessage(std::move(message));
}

// An icon and a button, and nothing about what the click does: that is the
// application's. The wire names are `domicile_protocol::TrayAction`'s.
void ControlChannel::ActivateTrayItem(const std::string& id,
                                      mojom::TrayAction action) {
  base::DictValue message = Typed("activate_tray_item");
  message.Set("id", id);
  switch (action) {
    case mojom::TrayAction::kPrimary:
      message.Set("action", "primary");
      break;
    case mojom::TrayAction::kSecondary:
      message.Set("action", "secondary");
      break;
    case mojom::TrayAction::kContext:
      message.Set("action", "context");
      break;
  }
  SendMessage(std::move(message));
}

// Ids and nothing else, as CopyClipboardEntry's entry is. Written as ints for
// the reason Notification.id is 32 bits: the compositor's ids never come near
// two billion.
void ControlChannel::DismissNotifications(const std::vector<uint32_t>& ids) {
  base::ListValue listed;
  for (uint32_t id : ids) {
    listed.Append(static_cast<int>(id));
  }
  base::DictValue message = Typed("dismiss_notifications");
  message.Set("ids", std::move(listed));
  SendMessage(std::move(message));
}

void ControlChannel::InvokeNotificationAction(uint32_t id,
                                              const std::string& action) {
  base::DictValue message = Typed("invoke_notification_action");
  message.Set("id", static_cast<int>(id));
  message.Set("action", action);
  SendMessage(std::move(message));
}

void ControlChannel::ReplyToNotification(uint32_t id,
                                         const std::string& text) {
  base::DictValue message = Typed("reply_to_notification");
  message.Set("id", static_cast<int>(id));
  message.Set("text", text);
  SendMessage(std::move(message));
}

void ControlChannel::FocusChrome() {
  SendMessage(Typed("focus_chrome"));
}

void ControlChannel::SyncFrames() {
  SendMessage(Typed("sync_frames"));
}

// NOTHING IS SENT, AND THAT IS THE MEMBER RATHER THAN AN OMISSION. The pointer
// a shell is asking about is the one this process draws -- on the platform
// that scans out it is a cursor plane, and the compositor has never heard of
// it. So this goes up to the UI thread and no further, which is the same shape
// `GrabShortcut` has for the same kind of reason.
void ControlChannel::WarpPointer(double x,
                                 double y,
                                 const std::optional<gfx::RectF>& unless_over) {
  warp_sink_.Run(x, y, unless_over);
}

// Nothing is sent, for WarpPointer's reason. The answer comes back from the UI
// thread, and the page's callback must run on this one.
void ControlChannel::ConfinePointer(const std::vector<gfx::RectF>& boxes,
                                    ConfinePointerCallback confined) {
  confine_sink_.Run(boxes,
                    base::BindPostTaskToCurrentDefault(std::move(confined)));
}

// Nothing is sent, for WarpPointer's reason: the compositor does not swap
// shells. What the page says goes to the `load_shell` waiting on it.
void ControlChannel::ShellRan(const std::string& serial) {
  ShellReports::Get().Heard(serial, std::nullopt);
}

void ControlChannel::ShellFailed(const std::string& serial,
                                 const std::string& why) {
  ShellReports::Get().Heard(serial, why);
}

void ControlChannel::CloseApp(const std::string& app_id) {
  SendMessage(ForApp("close_app", app_id));
}

void ControlChannel::SetAppBounds(const std::string& app_id,
                                  double x,
                                  double y,
                                  double width,
                                  double height) {
  base::DictValue message = ForApp("set_app_bounds", app_id);
  message.Set("position", Size(x, y));
  message.Set("size", Size(width, height));
  SendMessage(std::move(message));
}

void ControlChannel::SetDesktopSize(double width, double height) {
  base::DictValue message = Typed("set_desktop_size");
  message.Set("size", Size(width, height));
  SendMessage(std::move(message));
}

void ControlChannel::SetDevicePixelRatio(double ratio) {
  base::DictValue message = Typed("set_device_pixel_ratio");
  message.Set("ratio", ratio);
  SendMessage(std::move(message));
}

// THE ONE MEMBER THAT RELAYS A DECISION rather than a measurement or a
// request. What goes down this socket is the theme the user just picked, and
// what comes back up is `theme` to every chrome -- including this one, which
// is how a page comes to repaint without believing its own click.
//
// Through the wire name for the reason `AppCursor` goes through one on the way
// in: the only mapping in either direction is the X-macro in
// components/domicile/common/theme.h, so the list stays singular and
// scripts/test-themes-agree.sh can read every writing of it.
void ControlChannel::SetTheme(mojom::Theme theme) {
  base::DictValue message = Typed("set_theme");
  message.Set("theme", std::string(ThemeToWire(theme)));
  SendMessage(std::move(message));
}

// THE ONE MEMBER HERE THAT CARRIES A SECRET, and the only thing this method
// does about it is not say it. There is no log line and no error string with the
// passphrase in it, here or anywhere below the socket: the compositor's own
// `Passphrase` refuses to print itself, and its frame log names an unlock
// without its field.
//
// Relayed rather than checked. Nothing in this process knows what opens the
// desk, and it must not: the lock is the compositor refusing to inject input
// into the seat, so the verdict belongs where the seat is. What comes back up is
// `locked` to every chrome.
void ControlChannel::Unlock(const std::string& passphrase) {
  base::DictValue message = Typed("unlock");
  message.Set("passphrase", passphrase);
  SendMessage(std::move(message));
}

// Relayed, like Unlock: the lock is the compositor's, and what comes back up is
// `locked` to every chrome.
void ControlChannel::Lock() {
  SendMessage(Typed("lock"));
}

void ControlChannel::ThemeCaptured(mojom::Theme theme) {
  base::DictValue message = Typed("theme_captured");
  message.Set("theme", std::string(ThemeToWire(theme)));
  SendMessage(std::move(message));
}

void ControlChannel::GrabShortcut(mojom::ShortcutPtr shortcut) {
  // Recorded here, not relayed. A browser window is a `<webview>` whose page
  // is a guest; DOM focus moves into it, and its keys reach neither the
  // shell's document nor -- since the shell is what forwards them -- the
  // compositor. This process is the only layer above a focused guest, so the
  // set lives here and `WebViewGuest::PreHandleKeyboardEvent` matches against
  // it.
  ShortcutRegistry::Get().Grab(
      channel_, Chord{shortcut->keycode, shortcut->alt, shortcut->ctrl,
                      shortcut->shift, shortcut->meta});
}

void ControlChannel::UngrabShortcut(mojom::ShortcutPtr shortcut) {
  ShortcutRegistry::Get().Ungrab(
      channel_, Chord{shortcut->keycode, shortcut->alt, shortcut->ctrl,
                      shortcut->shift, shortcut->meta});
}

void ControlChannel::GrabGesture(mojom::GestureGrabPtr grab) {
  // Recorded here, not relayed, for GrabShortcut's reason: the platform
  // recognizes gestures in this process, and the compositor never sees them.
  DeskGestures::Get().Grab(gestures_, GestureGrabFromMojo(*grab));
}

void ControlChannel::UngrabGesture(mojom::GestureGrabPtr grab) {
  DeskGestures::Get().Ungrab(gestures_, GestureGrabFromMojo(*grab));
}

void ControlChannel::GrabModifierTap(mojom::TapModifier modifier,
                                     bool while_inhibited,
                                     base::TimeDelta longest) {
  // Recorded here, for GrabGesture's reason: aura sees every key in this
  // process, and a modifier alone means nothing to the compositor.
  DeskModifierTaps::Get().Grab(taps_, TapModifierFromMojo(modifier),
                               while_inhibited, longest);
}

void ControlChannel::UngrabModifierTap(mojom::TapModifier modifier) {
  DeskModifierTaps::Get().Ungrab(taps_, TapModifierFromMojo(modifier));
}

void ControlChannel::KeyboardWindowInhibitsShortcuts(bool inhibits) {
  // Recorded here, for GrabGesture's reason.
  DeskGestures::Get().SetInhibited(gestures_, inhibits);
  DeskModifierTaps::Get().SetInhibited(taps_, inhibits);
}

void ControlChannel::Key(const std::string& app_id,
                         uint32_t keycode,
                         bool pressed) {
  base::DictValue message = ForApp("key", app_id);
  message.Set("keycode", static_cast<int>(keycode));
  message.Set("pressed", pressed);
  SendMessage(std::move(message));
}

void ControlChannel::PointerMotion(const std::string& app_id,
                                   double x,
                                   double y,
                                   bool moved) {
  base::DictValue message = ForApp("pointer_motion", app_id);
  message.Set("x", x);
  message.Set("y", y);
  message.Set("moved", moved);
  SendMessage(std::move(message));
}

void ControlChannel::PointerRelative(const std::string& app_id,
                                     double dx,
                                     double dy,
                                     double dx_unaccel,
                                     double dy_unaccel) {
  base::DictValue message = ForApp("pointer_relative", app_id);
  message.Set("dx", dx);
  message.Set("dy", dy);
  message.Set("dx_unaccel", dx_unaccel);
  message.Set("dy_unaccel", dy_unaccel);
  SendMessage(std::move(message));
}

void ControlChannel::PointerConstrained(const std::string& app_id,
                                        bool active) {
  base::DictValue message = ForApp("pointer_constrained", app_id);
  message.Set("active", active);
  SendMessage(std::move(message));
}

void ControlChannel::PointerLeave(const std::string& app_id) {
  SendMessage(ForApp("pointer_leave", app_id));
}

void ControlChannel::PointerButton(const std::string& app_id,
                                   uint32_t button,
                                   bool pressed) {
  base::DictValue message = ForApp("pointer_button", app_id);
  message.Set("button", static_cast<int>(button));
  message.Set("pressed", pressed);
  SendMessage(std::move(message));
}

void ControlChannel::PointerPinch(const std::string& app_id,
                                  mojom::PinchPtr pinch) {
  base::DictValue message = ForApp("pointer_pinch", app_id);
  message.Set("device", static_cast<double>(pinch->device));
  message.Set("time", static_cast<double>(pinch->time));
  switch (pinch->phase) {
    case mojom::PinchPhase::kBegin:
      message.Set("phase", "begin");
      message.Set("fingers", static_cast<double>(pinch->fingers));
      break;
    case mojom::PinchPhase::kUpdate:
      message.Set("phase", "update");
      message.Set("dx", pinch->dx);
      message.Set("dy", pinch->dy);
      message.Set("scale", pinch->scale);
      message.Set("rotation", pinch->rotation);
      break;
    case mojom::PinchPhase::kEnd:
      message.Set("phase", "end");
      message.Set("canceled", pinch->canceled);
      break;
  }
  // base::Value's integer is signed, but the Wayland clock is uint32. Keep
  // whole-valued doubles as integer JSON tokens so Rust can read all 32 bits.
  std::string line;
  CHECK(base::JSONWriter::WriteWithOptions(
      message, base::JSONWriter::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION, &line));
  Send(line);
}

void ControlChannel::Touch(const std::string& app_id, mojom::TouchPtr touch) {
  base::DictValue message = ForApp("touch", app_id);
  message.Set("time", static_cast<double>(touch->time));
  switch (touch->phase) {
    case mojom::TouchPhase::kDown:
    case mojom::TouchPhase::kMotion:
      message.Set("phase",
                  touch->phase == mojom::TouchPhase::kDown ? "down" : "motion");
      message.Set("id", touch->id);
      message.Set("x", touch->x);
      message.Set("y", touch->y);
      break;
    case mojom::TouchPhase::kUp:
      message.Set("phase", "up");
      message.Set("id", touch->id);
      break;
    case mojom::TouchPhase::kCancel:
      message.Set("phase", "cancel");
      break;
  }
  // As for a pinch: the Wayland clock is uint32, which base::Value's int is
  // not, so whole doubles go out as integer tokens.
  std::string line;
  CHECK(base::JSONWriter::WriteWithOptions(
      message, base::JSONWriter::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION, &line));
  Send(line);
}

void ControlChannel::PointerAxis(const std::string& app_id,
                                 double dx,
                                 double dy,
                                 int32_t v120_x,
                                 int32_t v120_y,
                                 mojom::PointerAxisSource source,
                                 bool stop_x,
                                 bool stop_y) {
  base::DictValue message = ForApp("pointer_axis", app_id);
  message.Set("dx", dx);
  message.Set("dy", dy);
  message.Set("v120_x", v120_x);
  message.Set("v120_y", v120_y);
  switch (source) {
    case mojom::PointerAxisSource::kWheel:
      message.Set("source", "wheel");
      break;
    case mojom::PointerAxisSource::kFinger:
      message.Set("source", "finger");
      break;
    case mojom::PointerAxisSource::kWheelTilt:
      message.Set("source", "wheel_tilt");
      break;
    case mojom::PointerAxisSource::kContinuous:
      message.Set("source", "continuous");
      break;
  }
  message.Set("stop_x", stop_x);
  message.Set("stop_y", stop_y);
  SendMessage(std::move(message));
}

void ControlChannel::Send(const std::string& json_line) {
  pending_.push_back(json_line);
  if (connected_) {
    FlushQueue();
  }
}

void ControlChannel::FlushQueue() {
  if (!connected_ || writing_ || pending_.empty()) {
    return;
  }
  WriteNext();
}

void ControlChannel::WriteNext() {
  if (pending_.empty()) {
    writing_ = false;
    return;
  }
  writing_ = true;
  write_buffer_ = pending_.front() + "\n";
  pending_.erase(pending_.begin());
  write_offset_ = 0;
  OnWrite(net::OK);
}

void ControlChannel::OnWrite(int result) {
  if (result < 0) {
    // The compositor is gone, and its hang-up is read next. The line goes to
    // the next one whole -- see OnHungUp.
    LOG(WARNING) << "domicile: control channel write failed: "
                 << net::ErrorToString(result);
    RequeueTheLineInFlight();
    return;
  }
  write_offset_ += static_cast<size_t>(result);
  if (write_offset_ >= write_buffer_.size()) {
    WriteNext();
    return;
  }

  auto remaining = base::MakeRefCounted<net::StringIOBuffer>(
      write_buffer_.substr(write_offset_));
  const int written = socket_->Write(
      remaining.get(), remaining->size(),
      base::BindOnce(&ControlChannel::OnWrite, weak_factory_.GetWeakPtr()),
      MISSING_TRAFFIC_ANNOTATION);
  if (written != net::ERR_IO_PENDING) {
    OnWrite(written);
  }
}

// A line the old compositor never finished reading goes to the next one whole:
// none of it reached that one. Without its newline, which WriteNext adds.
void ControlChannel::RequeueTheLineInFlight() {
  pending_.insert(pending_.begin(),
                  write_buffer_.substr(0, write_buffer_.size() - 1));
  writing_ = false;
}

void ControlChannel::DeliverShortcut(Chord chord) {
  if (client_) {
    client_->ShortcutPressed(mojom::Shortcut::New(
        chord.keycode, chord.alt, chord.ctrl, chord.shift, chord.meta));
  }
}

void ControlChannel::DeliverGesture(const ui::NativeGesture& gesture) {
  if (client_) {
    client_->GesturePerformed(mojom::Gesture::New(
        GestureKindToMojo(gesture.kind), GesturePhaseToMojo(gesture.phase),
        gesture.fingers, gesture.dx, gesture.dy, gesture.scale,
        gesture.rotation, gesture.canceled,
        GestureEdgeToMojo(gesture.edge)));
  }
}

void ControlChannel::DeliverModifierTap(TapModifier modifier,
                                        base::TimeDelta held) {
  if (client_) {
    client_->ModifierTapped(TapModifierToMojo(modifier), held);
  }
}

void ControlChannel::ForwardGesture(const ui::NativeGesture& gesture) {
  if (!connected_) {
    return;
  }
  const bool swipe = gesture.kind == ui::NativeGestureKind::kSwipe;
  CHECK(swipe || gesture.kind == ui::NativeGestureKind::kHold);
  base::DictValue message = Typed(swipe ? "pointer_swipe" : "pointer_hold");
  switch (gesture.phase) {
    case ui::NativeGesturePhase::kBegin:
      message.Set("phase", "begin");
      message.Set("fingers", static_cast<int>(gesture.fingers));
      break;
    case ui::NativeGesturePhase::kUpdate:
      // A hold has no updates to give.
      if (!swipe) {
        return;
      }
      message.Set("phase", "update");
      message.Set("dx", gesture.dx);
      message.Set("dy", gesture.dy);
      break;
    case ui::NativeGesturePhase::kEnd:
      message.Set("phase", "end");
      message.Set("canceled", gesture.canceled);
      break;
  }
  SendMessage(std::move(message));
}

void ControlChannel::DeliverRelease(Chord chord) {
  if (client_) {
    client_->ShortcutReleased(mojom::Shortcut::New(
        chord.keycode, chord.alt, chord.ctrl, chord.shift, chord.meta));
  }
}

void ControlChannel::DeliverModifiers(Modifiers modifiers) {
  if (client_) {
    client_->Modifiers(modifiers.alt, modifiers.ctrl, modifiers.shift,
                       modifiers.meta);
  }
}

void ControlChannel::SomebodyIsHere(const std::string& input) {
  if (connected_) {
    base::DictValue message = Typed("activity");
    message.Set("input", input);
    SendMessage(std::move(message));
  }
}

void ControlChannel::FaultFound(const std::string& what) {
  base::DictValue message = Typed("engine_fault");
  message.Set("what", what);
  SendMessage(std::move(message));
}

void ControlChannel::DeskPointerMoved(const DeskPointerAt& at) {
  if (!connected_) {
    return;
  }
  const auto point = [](const gfx::PointF& xy) {
    base::ListValue list;
    list.Append(static_cast<double>(xy.x()));
    list.Append(static_cast<double>(xy.y()));
    return list;
  };
  base::DictValue message = Typed("desk_pointer");
  if (at.at) {
    message.Set("at", point(*at.at));
  }
  if (!at.windows.empty()) {
    base::ListValue windows;
    for (const PointerOverWindow& over : at.windows) {
      windows.Append(
          base::DictValue().Set("id", over.id).Set("at", point(over.fraction)));
    }
    message.Set("windows", std::move(windows));
  }
  SendMessage(std::move(message));
}

void ControlChannel::DeskCursorChanged(const ui::DeskCursorImage& image) {
  if (connected_) {
    SendMessage(DeskCursorMessage(image));
  }
}

void ControlChannel::SendTextField(const ui::DeskTextField& field) {
  if (connected_) {
    SendMessage(TextInputMessage(field));
  }
}

void ControlChannel::SendKeyForInputMethod(uint32_t evdev_code, bool pressed) {
  if (connected_) {
    SendMessage(KeyForInputMethodMessage(evdev_code, pressed));
  }
}

void ControlChannel::ReadLoop() {
  const int result = socket_->Read(
      read_buffer_.get(), kReadBufferSize,
      base::BindOnce(&ControlChannel::OnRead, weak_factory_.GetWeakPtr()));
  if (result != net::ERR_IO_PENDING) {
    OnRead(result);
  }
}

void ControlChannel::OnRead(int result) {
  if (result <= 0) {
    // Zero is the compositor closing the socket, which on this desktop means
    // it went away. Either way there is nothing more to read from this one.
    OnHungUp();
    return;
  }

  for (const std::string& line : framer_->Take(std::string_view(
           read_buffer_->data(), static_cast<size_t>(result)))) {
    DispatchLine(line, /*from_compositor=*/true);
  }

  ReadLoop();
}

void ControlChannel::Track(const base::DictValue& message) {
  const std::string& type = *message.FindString("type");
  if (type == "app_appeared" || type == "popup_placed" ||
      type == "app_closed") {
    if (const std::string* app_id = message.FindString("app_id")) {
      if (type == "app_closed") {
        open_apps_.erase(*app_id);
      } else {
        open_apps_.insert(*app_id);
      }
    }
    return;
  }
  calls_.Heard(message);
}

void ControlChannel::DispatchLine(const std::string& line,
                                  bool from_compositor) {
  if (line.empty()) {
    return;
  }

  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(line, base::JSON_PARSE_RFC);
  if (!parsed) {
    LOG(ERROR) << "domicile: control channel sent a line that is not a JSON "
                  "object; dropped.";
    return;
  }
  const base::DictValue& message = *parsed;
  const std::string* type = message.FindString("type");
  if (!type) {
    return;
  }
  if (from_compositor) {
    Track(message);
  }

  // THE ONE MESSAGE ON THIS SOCKET THAT IS NOT THE PAGE'S, and the one that is
  // handled before `client_` is looked at for that reason. What the compositor
  // is describing is how this *process* reads a keyboard: without it the
  // browser's own KeyboardLayoutEngine has no keymap at all, and a shell is a
  // page nobody can type into. See
  // components/domicile/browser/keyboard_layout.h, which is where the whole of
  // why lives.
  //
  // Nothing goes on to the page, and nothing should: the compositor already
  // resolves the modifiers against this keymap before it sends them, so a
  // document holding 40 kilobytes of xkb has nothing to do with it.
  if (*type == "keymap") {
    const std::string* keymap = message.FindString("keymap");
    if (keymap) {
      keymap_sink_.Run(*keymap);
    } else {
      // Said, unlike every other arm here, which drops a malformed message and
      // moves on. Those cost one window or one cursor; this one costs the
      // whole keyboard, and it costs it the way this bug arrived in the first
      // place -- with every log on both sides reporting a desktop that is
      // fine.
      LOG(ERROR) << "domicile: the compositor sent a `keymap` message with no "
                    "keymap in it. The layout engine keeps what it had, which "
                    "on this platform is nothing, and printable keys will "
                    "carry no character.";
    }
    return;
  }

  // THE OTHER ONE THAT IS NOT THE PAGE'S, for the keymap's reason: what it
  // configures is this process's profile, which installs the extensions the
  // desk's config names. See components/domicile/browser/extension_installer.h.
  // Logged when malformed, like `keymap`: dropped quietly, the desk would run
  // with whatever extensions it had and nothing would say why.
  if (*type == "extensions") {
    std::optional<std::vector<std::string>> web_store =
        Strings(message, "web_store");
    std::optional<std::vector<std::string>> unpacked =
        Strings(message, "unpacked");
    const base::DictValue* settings_value = message.FindDict("settings");
    std::optional<ExtensionSettingsMap> settings =
        settings_value == nullptr
            ? std::nullopt
            : ParseExtensionSettings(*settings_value);
    // `private` is a private browser profile's switch, not the config's
    // (ExtensionsFor), so a compositor that sends it is out of date.
    if (settings && std::ranges::any_of(*settings, [](const auto& entry) {
          return entry.second.in_private.has_value();
        })) {
      settings.reset();
    }
    if (web_store && unpacked && settings) {
      extensions_sink_.Run(ExtensionList{.web_store = std::move(*web_store),
                                         .unpacked = std::move(*unpacked),
                                         .settings = std::move(*settings)});
    } else {
      LOG(ERROR) << "domicile: the compositor sent an `extensions` message "
                    "whose `web_store` or `unpacked` is not a list of strings, "
                    "or whose `settings` are not extensions' settings (a "
                    "`private` one is a private browser profile's switch "
                    "now). The profile keeps the extensions it had.";
    }
    return;
  }

  // For this process too, like `extensions`: the desk's browser profiles,
  // which the profile this page is in makes into Chrome profiles. See
  // chrome/browser/domicile/domicile_browser_profiles.h. Logged when
  // malformed, for `extensions`' reason: dropped quietly, every page would
  // open in the profiles it had and nothing would say why.
  if (*type == "browser_profiles") {
    std::optional<BrowserProfiles> profiles = ParseBrowserProfiles(message);
    if (!profiles) {
      LOG(ERROR) << "domicile: the compositor sent a `browser_profiles` "
                    "message that does not describe browser profiles, or "
                    "names a default, a private default or a site's profile "
                    "it does not list. Pages keep the profiles they had.";
    } else if (BrowserProfilesSlot().is_null()) {
      // //chrome sets the sink before the shell can bind a channel, so this
      // is an engine built without it, and every page would open in the
      // shell's profile with nothing saying why.
      LOG(ERROR) << "domicile: the compositor sent `browser_profiles` and "
                    "this engine has nowhere to put them. Every page opens in "
                    "the default profile.";
    } else {
      BrowserProfilesSlot().Run(page_, *profiles);
    }
    return;
  }

  // For this process too, like `extensions`: the pages it draws dark. See
  // components/domicile/browser/force_dark.h.
  if (*type == "force_dark") {
    std::optional<std::vector<std::string>> sites = Strings(message, "sites");
    if (sites) {
      force_dark_sink_.Run(std::move(*sites));
    } else {
      LOG(ERROR) << "domicile: the compositor sent a `force_dark` message "
                    "whose `sites` is not a list of strings. Pages keep the "
                    "sites they had.";
    }
    return;
  }

  // For this process too, like `force_dark`: how the browser's profiles check
  // spelling. See chrome/browser/domicile/domicile_spellcheck.h.
  if (*type == "spellcheck") {
    const std::optional<bool> enabled = message.FindBool("enabled");
    std::optional<std::vector<std::string>> languages =
        Strings(message, "languages");
    if (!enabled || !languages) {
      LOG(ERROR) << "domicile: the compositor sent a `spellcheck` message "
                    "whose `enabled` is not true or false, or whose "
                    "`languages` is not a list of strings. Spelling is "
                    "checked as it was.";
    } else if (SpellcheckSlot().is_null()) {
      // //chrome sets the sink before the shell can bind a channel, as
      // `browser_profiles`'.
      LOG(ERROR) << "domicile: the compositor sent `spellcheck` and this "
                    "engine has nowhere to put it. Spelling is checked as it "
                    "was.";
    } else {
      SpellcheckSlot().Run(SpellcheckSettings{
          .enabled = *enabled, .languages = std::move(*languages)});
    }
    return;
  }

  // THE INPUT METHOD'S, for this process like `keymap`: the compositor is
  // the editor of the field focused in it on the desk's input method. Every
  // page's channel hears these, and the desk's input method keeps the first
  // of each serial. See ui/base/ime/domicile/desk_input_method.h. Nothing
  // goes on to the page: what was composed reaches it as typing.
  if (*type == "input_method") {
    if (const std::optional<bool> composing = message.FindBool("composing")) {
      ui::DeskInputMethod::Get().SetComposing(*composing);
    }
    return;
  }
  if (*type == "composition") {
    if (std::optional<HeardComposition> heard = ReadComposition(message)) {
      ui::DeskInputMethod::Get().Compose(heard->serial,
                                         std::move(heard->composition));
    } else {
      LOG(ERROR) << "domicile: the compositor sent a `composition` this "
                    "engine cannot read; the field misses that much typing.";
    }
    return;
  }
  if (*type == "key_passed") {
    if (const std::optional<PassedKey> passed = ReadPassedKey(message)) {
      ui::DeskInputMethod::Get().PassKey(passed->serial, passed->evdev_code,
                                         passed->pressed);
    } else {
      LOG(ERROR) << "domicile: the compositor sent a `key_passed` this "
                    "engine cannot read; that key is lost.";
    }
    return;
  }

  // Everything below is relayed to the page, so it waits for the page to give
  // this channel somewhere. Until then they are held: the compositor answers
  // `hello` with the desk's state, and that answer can arrive before the
  // page's SetClient does. SetClient replays them.
  if (!client_) {
    held_.push_back(line);
    return;
  }

  if (*type == "welcome") {
    const std::optional<int> version = message.FindInt("protocol_version");
    if (version && *version != kProtocolVersion) {
      LOG(ERROR) << "domicile: the compositor speaks protocol version "
                 << *version << " and this engine speaks " << kProtocolVersion
                 << ". They were built from different revisions; the desktop "
                    "will misbehave in ways that look like bugs.";
    }
    return;
  }

  if (*type == "app_titled") {
    const std::string* app_id = message.FindString("app_id");
    if (!app_id) {
      return;
    }
    // A null title is a window saying it has no name, not a malformed message.
    // Requiring the string dropped the whole thing, so a shell went on showing
    // the name a window had stopped using -- and `app_appeared` two branches
    // down already reads the same field the other way, which is the reading
    // that matches the wire.
    const std::string* title = message.FindString("title");
    client_->AppTitled(*app_id, title ? *title : std::string());
    return;
  }

  if (*type == "app_desktop_id") {
    const std::string* app_id = message.FindString("app_id");
    const std::string* desktop_id = message.FindString("desktop_id");
    if (app_id && desktop_id) {
      client_->AppDesktopId(*app_id, *desktop_id);
    }
    return;
  }

  if (*type == "app_inhibits_shortcuts") {
    const std::string* app_id = message.FindString("app_id");
    const std::optional<bool> inhibits = message.FindBool("inhibits");
    if (app_id && inhibits) {
      client_->AppInhibitsShortcuts(*app_id, *inhibits);
    }
    return;
  }

  if (*type == "app_appeared") {
    const std::string* app_id = message.FindString("app_id");
    if (!app_id) {
      return;
    }
    const std::string* title = message.FindString("title");
    // Null when the client set none, like the title.
    const std::string* desktop_id = message.FindString("desktop_id");
    const base::ListValue* size = message.FindList("size");
    const std::optional<bool> dialog = message.FindBool("dialog");
    const std::optional<bool> client_frame = message.FindBool("client_frame");
    const std::string* toplevel_id = message.FindString("toplevel_id");
    if (size && size->size() == 2u && dialog && client_frame && toplevel_id) {
      client_->AppAppeared(*app_id, title ? *title : std::string(),
                           desktop_id ? *desktop_id : std::string(),
                           Number((*size)[0]), Number((*size)[1]), *dialog,
                           *client_frame, OwnerOf(message.FindDict("owner")),
                           *toplevel_id, FrameOf(message));
    }
    return;
  }

  if (*type == "browser_toplevel_ids") {
    const base::DictValue* listed = message.FindDict("toplevel_ids");
    if (!listed) {
      return;
    }
    base::flat_map<std::string, std::string> toplevel_ids;
    for (const auto [window, toplevel_id] : *listed) {
      if (!toplevel_id.is_string()) {
        return;
      }
      toplevel_ids.emplace(window, toplevel_id.GetString());
    }
    client_->BrowserToplevelIds(toplevel_ids);
    return;
  }

  if (*type == "app_min_size" || *type == "app_max_size") {
    const std::string* app_id = message.FindString("app_id");
    const base::ListValue* size = message.FindList("size");
    if (app_id && size && size->size() == 2u) {
      if (*type == "app_min_size") {
        client_->AppMinSize(*app_id, Number((*size)[0]), Number((*size)[1]));
      } else {
        client_->AppMaxSize(*app_id, Number((*size)[0]), Number((*size)[1]));
      }
    }
    return;
  }

  if (*type == "popup_placed") {
    const std::string* app_id = message.FindString("app_id");
    const std::string* parent = message.FindString("parent");
    const base::ListValue* position = message.FindList("position");
    const base::ListValue* size = message.FindList("size");
    const std::optional<bool> grab = message.FindBool("grab");
    if (app_id && parent && position && position->size() == 2u && size &&
        size->size() == 2u && grab) {
      client_->PopupPlaced(*app_id, *parent, Number((*position)[0]),
                           Number((*position)[1]), Number((*size)[0]),
                           Number((*size)[1]), *grab,
                           FramesOf(message.FindList("frames")));
    }
    return;
  }

  if (*type == "app_resized") {
    const std::string* app_id = message.FindString("app_id");
    const base::ListValue* size = message.FindList("size");
    if (app_id && size && size->size() == 2u) {
      client_->AppResized(*app_id, Number((*size)[0]), Number((*size)[1]));
    }
    return;
  }

  if (*type == "app_transient_for") {
    const std::string* app_id = message.FindString("app_id");
    if (!app_id) {
      return;
    }
    // Null is a window that is no dialog, as `title` is one with no name.
    const std::string* transient_for = message.FindString("transient_for");
    client_->AppTransientFor(*app_id,
                             transient_for ? *transient_for : std::string());
    return;
  }

  if (*type == "app_anchored") {
    const std::string* app_id = message.FindString("app_id");
    if (!app_id) {
      return;
    }
    // Null is a window with no anchor, as `transient_for` is one with no
    // parent.
    const std::string* anchor = message.FindString("anchor");
    client_->AppAnchored(*app_id, anchor ? *anchor : std::string());
    return;
  }

  if (*type == "app_urgent") {
    const std::string* app_id = message.FindString("app_id");
    const std::optional<bool> urgent = message.FindBool("urgent");
    if (app_id && urgent) {
      client_->AppUrgent(*app_id, *urgent);
    }
    return;
  }

  if (*type == "app_closed") {
    if (const std::string* app_id = message.FindString("app_id")) {
      client_->AppClosed(*app_id);
    }
    return;
  }

  if (*type == "app_cursor") {
    const std::string* app_id = message.FindString("app_id");
    const std::string* cursor = message.FindString("cursor");
    if (!app_id || !cursor) {
      return;
    }
    // THE CLOSED SET, ASKED ABOUT HERE AND NOWHERE ELSE. This used to copy the
    // string through to the page, where an unknown CSS keyword is a no-op and
    // the symptom is an arrow instead of a hand with nothing said anywhere.
    // See components/domicile/common/cursor_shape.h.
    const std::optional<mojom::CursorShape> shape =
        CursorShapeFromWire<mojom::CursorShape>(*cursor);
    if (!shape) {
      // Dropped with a name, like every other unrecognized message on this
      // channel: a cursor this build does not know is a compositor newer than
      // it rather than a broken stream, and the one thing that must not happen
      // is a shape being invented for it.
      LOG(WARNING) << "domicile: the compositor asked for a cursor named '"
                   << *cursor
                   << "', which is not one of the shapes this engine knows; "
                      "the request was dropped.";
      return;
    }
    client_->AppCursor(*app_id, *shape,
                       CursorImageOf(message.FindDict("image")));
    return;
  }

  if (*type == "app_pointer_constraint") {
    const std::string* app_id = message.FindString("app_id");
    if (!app_id) {
      return;
    }
    // `null` for none; a name this build does not know is dropped, as an
    // unknown cursor is, rather than read as one it does.
    const base::Value* named = message.Find("constraint");
    std::optional<mojom::PointerConstraint> constraint;
    if (named && named->is_string()) {
      if (named->GetString() == "lock") {
        constraint = mojom::PointerConstraint::kLock;
      } else if (named->GetString() == "confine") {
        constraint = mojom::PointerConstraint::kConfine;
      } else {
        LOG(WARNING) << "domicile: the compositor offered a pointer "
                        "constraint named '"
                     << named->GetString()
                     << "', which this engine does not know; dropped.";
        return;
      }
    } else if (named && !named->is_none()) {
      return;
    }
    // `null` for the whole window. A box that is not one is a compositor bug,
    // so the message is dropped rather than read as some other region.
    std::optional<std::vector<gfx::RectF>> region;
    if (const base::ListValue* boxes = message.FindList("region")) {
      region.emplace();
      for (const base::Value& box : *boxes) {
        const base::DictValue* sides = box.GetIfDict();
        const std::optional<int> x = sides ? sides->FindInt("x") : std::nullopt;
        const std::optional<int> y = sides ? sides->FindInt("y") : std::nullopt;
        const std::optional<int> width =
            sides ? sides->FindInt("width") : std::nullopt;
        const std::optional<int> height =
            sides ? sides->FindInt("height") : std::nullopt;
        if (!x || !y || !width || !height || *width < 0 || *height < 0) {
          LOG(ERROR) << "domicile: the compositor sent a pointer region box "
                        "that is not one; dropped.";
          return;
        }
        region->emplace_back(*x, *y, *width, *height);
      }
    }
    client_->AppPointerConstraint(*app_id, constraint, std::move(region));
    return;
  }

  if (*type == "app_presented") {
    if (const std::string* app_id = message.FindString("app_id")) {
      client_->AppPresented(*app_id);
    }
    return;
  }

  if (*type == "app_suspended") {
    const std::string* app_id = message.FindString("app_id");
    const std::optional<bool> suspended = message.FindBool("suspended");
    if (app_id && suspended) {
      client_->AppSuspended(*app_id, *suspended);
    }
    return;
  }

  // `logo` is what Wayland calls the key the web calls Meta.
  if (*type == "modifiers") {
    DeliverModifiers(Modifiers{message.FindBool("alt").value_or(false),
                               message.FindBool("ctrl").value_or(false),
                               message.FindBool("shift").value_or(false),
                               message.FindBool("logo").value_or(false)});
    return;
  }

  if (*type == "displays") {
    const base::ListValue* described = message.FindList("displays");
    if (!described) {
      return;
    }
    std::vector<mojom::DisplayInfoPtr> displays;
    displays.reserve(described->size());
    for (const base::Value& entry : *described) {
      const base::DictValue* display = entry.GetIfDict();
      if (!display) {
        continue;
      }
      const std::string* name = display->FindString("name");
      const base::ListValue* position = display->FindList("position");
      const base::ListValue* size = display->FindList("size");
      if (!name || !position || position->size() != 2u || !size ||
          size->size() != 2u) {
        continue;
      }
      // The mode is OPTIONAL where the rest is required, and the two are
      // required for different reasons. A display with no name or no
      // rectangle is not a display and is dropped; a display with no mode is
      // one from a host that predates the field, and 0x0 is what it gets --
      // harmless, because nothing divides by it.
      const base::ListValue* mode = display->FindList("mode");
      const bool moded = mode && mode->size() == 2u;
      const std::string* transform = display->FindString("transform");
      // Optional like the mode, and for the same reason: zero is unknown.
      const std::optional<double> refresh = display->FindDouble("refresh_mhz");
      // Optional too: a host that predates it has no adaptive sync.
      const std::string* adaptive_sync = display->FindString("adaptive_sync");
      // As is HDR, and a luminance it leaves out is unreported.
      const std::string* hdr = display->FindString("hdr");
      const auto luminance = [display](std::string_view key) {
        const std::optional<double> nits = display->FindDouble(key);
        return nits && *nits > 0 ? static_cast<uint32_t>(*nits) : 0u;
      };
      displays.push_back(mojom::DisplayInfo::New(
          *name, static_cast<int32_t>(Number((*position)[0])),
          static_cast<int32_t>(Number((*position)[1])),
          static_cast<uint32_t>(Number((*size)[0])),
          static_cast<uint32_t>(Number((*size)[1])),
          static_cast<uint32_t>(display->FindInt("scale").value_or(1)),
          moded ? static_cast<uint32_t>(Number((*mode)[0])) : 0u,
          moded ? static_cast<uint32_t>(Number((*mode)[1])) : 0u,
          refresh && *refresh > 0 ? static_cast<uint32_t>(*refresh) : 0u,
          SupportNamed(adaptive_sync), SupportNamed(hdr),
          luminance("peak_luminance"), luminance("sdr_white"),
          TransformNamed(transform)));
    }
    // Sent even when every entry was malformed, because an empty desktop is an
    // answer: a page told nothing and a page told there are no screens are
    // different states, and only the second can be rendered.
    client_->Displays(std::move(displays));
    return;
  }

  if (*type == "found_files") {
    const std::string* query = message.FindString("query");
    const base::ListValue* found = message.FindList("files");
    const std::optional<int> matched = message.FindInt("matched");
    const std::optional<bool> indexing = message.FindBool("indexing");
    // All four or nothing: an answer without its query cannot be told from
    // the answer to a keystroke ago, and one without its count or its flag
    // would be drawn as a claim it did not make.
    if (!query || !found || !matched || *matched < 0 || !indexing) {
      return;
    }
    std::vector<std::string> files;
    files.reserve(found->size());
    for (const base::Value& entry : *found) {
      const std::string* path = entry.GetIfString();
      if (path) {
        files.push_back(*path);
      }
    }
    // Sent even when it is empty, for the reason `displays` above is: a query
    // that matched nothing is an answer, and a launcher that never heard one
    // would wait for a message the compositor has already sent.
    client_->Files(*query, std::move(files), static_cast<uint32_t>(*matched),
                   *indexing);
    return;
  }

  if (*type == "theme") {
    // REFUSED RATHER THAN DEFAULTED, which is the opposite of what `displays`
    // does above and is deliberate. A theme defaulted to dark is not a missing
    // reading -- it is a *decision*, and one that would repaint a desk
    // somebody had just put into light. The desk is already painting in one
    // of the two, which is a better answer than the other one picked by a name
    // nothing here knows.
    const std::string* named = message.FindString("theme");
    if (!named) {
      return;
    }
    const std::optional<mojom::Theme> theme =
        ThemeFromWire<mojom::Theme>(*named);
    if (!theme) {
      return;
    }
    client_->ThemeChanged(*theme);
    return;
  }

  if (*type == "windows_theme") {
    // Refused rather than defaulted, for `theme`'s reason above.
    const std::string* named = message.FindString("theme");
    if (!named) {
      return;
    }
    const std::optional<mojom::Theme> theme =
        ThemeFromWire<mojom::Theme>(*named);
    if (!theme) {
      return;
    }
    // The engine's own color scheme, which is what a site's
    // `prefers-color-scheme` reads. Here rather than on `theme`, because the
    // shell captures the frame its wipe starts from in between: a site
    // turned on `theme` would be in that frame already turned.
    theme_sink_.Run(*theme);
    client_->WindowsThemeChanged(*theme);
    return;
  }

  if (*type == "appearance") {
    // Refused rather than defaulted, for `theme`'s reason above. Only the
    // accent may be absent: that is the config leaving it to the shell.
    const std::optional<bool> high_contrast = message.FindBool("high_contrast");
    const std::optional<bool> reduced_motion =
        message.FindBool("reduced_motion");
    if (!high_contrast || !reduced_motion) {
      return;
    }
    // The pointer's theme stops in this process, which draws the pointer on a
    // tty. Absent is Chromium's own art; a theme without its size is refused.
    std::optional<ui::DeskCursorTheme> cursor_theme;
    if (const base::DictValue* cursor = message.FindDict("cursor")) {
      const std::string* name = cursor->FindString("name");
      const std::optional<int> size = cursor->FindInt("size");
      if (!name || !size || *size < 1) {
        return;
      }
      cursor_theme = ui::DeskCursorTheme{.name = *name, .size = *size};
    }
    // When to hide the pointer stops here too. Absent never hides it.
    // `after_ms` is read as a double: one past INT32_MAX does not fit
    // base::Value's int.
    PointerHidingSettings hiding;
    if (const base::DictValue* cursor_hiding =
            message.FindDict("cursor_hiding")) {
      const std::optional<double> after_ms =
          cursor_hiding->FindDouble("after_ms");
      const std::optional<bool> when_typing =
          cursor_hiding->FindBool("when_typing");
      if ((after_ms && *after_ms < 1) || !when_typing) {
        return;
      }
      hiding = PointerHidingSettings{
          .after = after_ms ? std::make_optional(base::Milliseconds(*after_ms))
                            : std::nullopt,
          .when_typing = *when_typing};
    }
    cursor_theme_sink_.Run(std::move(cursor_theme));
    DeskPointerHiding::Get().Set(hiding);
    const std::string* accent_color = message.FindString("accent_color");
    client_->AppearanceChanged(
        accent_color ? std::make_optional(*accent_color) : std::nullopt,
        *high_contrast, *reduced_motion);
    return;
  }

  if (*type == "clipboard") {
    const base::ListValue* history = message.FindList("entries");
    if (!history) {
      return;
    }
    std::vector<mojom::ClipboardEntryPtr> entries;
    entries.reserve(history->size());
    for (const base::Value& row : *history) {
      const base::DictValue* entry = row.GetIfDict();
      if (!entry) {
        continue;
      }
      // A row with no id is one nothing could ask for again, and a row with no
      // preview is one nothing could draw -- so a malformed one is dropped
      // rather than carried with a zero in it, which would be a row that
      // pastes whatever the compositor happens to hold as entry 0.
      std::optional<int> id = entry->FindInt("id");
      std::optional<bool> image = entry->FindBool("image");
      const std::string* preview = entry->FindString("preview");
      std::optional<bool> current = entry->FindBool("current");
      if (!id || !image || !preview || !current) {
        continue;
      }
      // Absent for a row with no picture, as a tray item's `icon` is.
      const std::string* thumbnail = entry->FindString("thumbnail");
      entries.push_back(mojom::ClipboardEntry::New(
          static_cast<uint32_t>(*id), *image, *preview,
          thumbnail ? *thumbnail : std::string(), *current));
    }
    // Sent even when it is empty, for the reason `displays` and `files` are: a
    // desktop nothing has been copied on is an answer, and a panel that never
    // heard one would wait for a message that has already been sent.
    client_->Clipboard(std::move(entries));
    return;
  }

  if (*type == "tray") {
    const base::ListValue* listed = message.FindList("items");
    if (!listed) {
      return;
    }
    std::vector<mojom::TrayItemPtr> items;
    items.reserve(listed->size());
    for (const base::Value& row : *listed) {
      const base::DictValue* item = row.GetIfDict();
      if (!item) {
        continue;
      }
      // An icon with no id or bus is one no click could reach, and one with no
      // title is one nothing could label: dropped, like a clipboard row
      // missing either half, as is one that does not say whether it is only a
      // menu. The picture and the menu are optional -- the compositor leaves
      // them out for an item with none -- and are carried as empty.
      const std::string* id = item->FindString("id");
      const std::string* title = item->FindString("title");
      const std::string* bus = item->FindString("bus");
      const std::optional<bool> item_is_menu = item->FindBool("item_is_menu");
      if (!id || !title || !bus || !item_is_menu) {
        continue;
      }
      const std::string* icon = item->FindString("icon");
      const std::string* menu = item->FindString("menu");
      items.push_back(mojom::TrayItem::New(
          *id, *title, icon ? *icon : std::string(), *bus,
          menu ? *menu : std::string(), *item_is_menu));
    }
    // Sent even when it is empty, for `clipboard`'s reason: a tray with
    // nothing in it is an answer.
    client_->Tray(std::move(items));
    return;
  }

  if (*type == "notifications") {
    const base::ListValue* listed = message.FindList("items");
    if (!listed) {
      return;
    }
    std::vector<mojom::NotificationPtr> items;
    items.reserve(listed->size());
    for (const base::Value& row : *listed) {
      const base::DictValue* item = row.GetIfDict();
      if (!item) {
        continue;
      }
      // A notification with no id is one nothing could clear, and one missing
      // what it says or when is one nothing could draw: dropped, as a tray
      // icon missing its id or title is. The picture, the timeout and the
      // browser window are optional -- the compositor leaves out a picture it
      // could not draw, a timeout left to the shell, and the window of
      // anything no browser window's page sent -- and are carried as empty,
      // -1 and empty.
      std::optional<int> id = item->FindInt("id");
      const std::string* app_name = item->FindString("app_name");
      const std::string* summary = item->FindString("summary");
      const std::string* body = item->FindString("body");
      const std::string* urgency = item->FindString("urgency");
      const base::ListValue* offered = item->FindList("actions");
      std::optional<bool> clickable = item->FindBool("clickable");
      std::optional<double> time = item->FindDouble("time");
      if (!id || !app_name || !summary || !body || !urgency || !offered ||
          !clickable || !time) {
        continue;
      }
      std::vector<mojom::NotificationActionPtr> actions;
      for (const base::Value& button : *offered) {
        const base::DictValue* action = button.GetIfDict();
        const std::string* key = action ? action->FindString("key") : nullptr;
        const std::string* label =
            action ? action->FindString("label") : nullptr;
        if (key && label) {
          actions.push_back(mojom::NotificationAction::New(*key, *label));
        }
      }
      const std::string* icon = item->FindString("icon");
      // Read as a double: the timeout is a u32 on the wire, and one past two
      // billion milliseconds is a month, which is as good as never.
      std::optional<double> timeout_ms = item->FindDouble("timeout_ms");
      const std::string* browser_window = item->FindString("browser_window");
      items.push_back(mojom::Notification::New(
          static_cast<uint32_t>(*id), *app_name, *summary, *body,
          icon ? *icon : std::string(), *urgency, std::move(actions),
          *clickable,
          timeout_ms ? static_cast<int32_t>(std::min(*timeout_ms, 2.0e9)) : -1,
          *time, browser_window ? *browser_window : std::string()));
    }
    // Sent even when it is empty, for `clipboard`'s reason.
    client_->Notifications(std::move(items));
    return;
  }

  if (*type == "idle") {
    // DROPPED RATHER THAN DEFAULTED, for the reason `theme` above is and
    // more sharply: a missing field here has no reading to fall back on that
    // is not a guess about which way the desk went, and a guess that came out
    // false would clear a shell's lock screen over a desk nobody is at. A
    // message this cannot read is one to say nothing about.
    std::optional<bool> idle = message.FindBool("idle");
    if (!idle) {
      return;
    }
    client_->Idle(*idle);
    return;
  }

  if (*type == "locked") {
    // DROPPED RATHER THAN DEFAULTED, for `idle` above's reason at its sharpest:
    // a missing field here has no reading that is not a guess about whether this
    // desk is listening, and a guess that came out false would clear a shell's
    // lock screen over a desk that has stopped delivering input -- a desktop
    // that looks open, takes a password into a text field nothing will ever see,
    // and is not.
    std::optional<bool> locked = message.FindBool("locked");
    if (!locked) {
      return;
    }
    // Written down before the page hears it, so the home is shut to
    // domicile://home/ no later than the page learns the desk is locked.
    DeskLock::Set(*locked);
    client_->Locked(*locked);
    return;
  }

  // Relayed as it arrived, like `shell_config`: the page parses it.
  if (IsSystemAnswer(*type)) {
    client_->System(line);
    return;
  }

  // Relayed as it arrived: the page parses each request's body.
  if (*type == "portal_requests") {
    client_->PortalRequests(line);
    return;
  }

  if (*type == "shell_config") {
    // RELAYED AS THE LINE IT ARRIVED AS, and read no further than `type`: the
    // renderer half of DomicileHost reads its keys -- see
    // ControlChannelClient::ShellConfig -- and a field picked out here would be
    // a second reader of that shape. The parse above has already refused a
    // line that is not a JSON object.
    client_->ShellConfig(line);
    return;
  }

  if (*type == "focus_changed") {
    // Empty app_id means the chrome itself has focus, which is a state rather
    // than a missing field.
    const std::string* app_id = message.FindString("app_id");
    client_->FocusChanged(app_id ? *app_id : std::string());
    return;
  }

  if (*type == "focus_requested") {
    // Unlike focus_changed, a missing app_id is malformed rather than an
    // answer: nothing but a client asks for the keyboard.
    const std::string* app_id = message.FindString("app_id");
    if (app_id) {
      client_->FocusRequested(*app_id);
    }
    return;
  }

  // What is left is the bands and copy-path protocol -- place_portal,
  // render_band, app_composited and their kin. Deliberately not implemented:
  // docs/architecture/ENGINE-FORK.md lists them under what the fork scraps,
  // because layout positions the layer now and the page has stopped reporting
  // where its own boxes are. Cementing them here would make a dying protocol
  // cost an engine release to remove.
}

void SetBrowserProfilesSink(BrowserProfilesSink sink) {
  CHECK(BrowserProfilesSlot().is_null() || sink.is_null());
  BrowserProfilesSlot() = std::move(sink);
}

void SetSpellcheckSink(SpellcheckSink sink) {
  CHECK(SpellcheckSlot().is_null() || sink.is_null());
  SpellcheckSlot() = std::move(sink);
}

void BindControlChannel(mojo::PendingReceiver<mojom::ControlChannel> receiver,
                        KeymapSink keymap_sink,
                        PointerWarpSink warp_sink,
                        PointerConfineSink confine_sink,
                        ThemeSink theme_sink,
                        ExtensionsSink extensions_sink,
                        CursorThemeSink cursor_theme_sink,
                        ForceDarkSink force_dark_sink,
                        const Page& page) {
  const std::string socket_path =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
          kDomicileControlSocketSwitch);
  if (socket_path.empty()) {
    // No socket means the engine was started without --domicile-control-socket.
    // Dropping the receiver closes the page's end, so a shell finds out rather
    // than talking into a channel that goes nowhere.
    LOG(ERROR) << "domicile: a page asked for the control channel but the "
                  "engine was started without --domicile-control-socket. The "
                  "shell will load and no window will respond.";
    return;
  }
  // Owns itself: it lives until the page drops the pipe or the compositor is
  // declared unreachable.
  new ControlChannel(socket_path, std::move(receiver), std::move(keymap_sink),
                     std::move(warp_sink), std::move(confine_sink),
                     std::move(theme_sink), std::move(extensions_sink),
                     std::move(cursor_theme_sink), std::move(force_dark_sink),
                     page);
}

}  // namespace domicile

// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/control_channel.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/dcheck_is_on.h"
#include "base/files/file_path.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/test/bind.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "base/time/time.h"
#include "components/domicile/browser/desk_faults.h"
#include "components/domicile/browser/desk_pointer_hiding.h"
#include "components/domicile/browser/line_framer.h"
#include "components/domicile/browser/shell_swap.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/io_buffer.h"
#include "net/base/net_errors.h"
#include "net/socket/stream_socket.h"
#include "net/socket/unix_domain_server_socket_posix.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/cursor/domicile/desk_cursor_image.h"
#include "ui/base/cursor/domicile/desk_cursor_theme.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {
namespace {

// The handshake. `checked` says whether this engine is a checked build, which
// the compositor warns about.
constexpr const char* kHello =
    DCHECK_IS_ON()
        ? R"({"checked":true,"protocol_version":1,"type":"hello"})"
        : R"({"checked":false,"protocol_version":1,"type":"hello"})";

// The page's end, recording the two members the test sends and nothing else.
class FakeClient : public mojom::ControlChannelClient {
 public:
  mojo::PendingRemote<mojom::ControlChannelClient> BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  void Idle(bool idle) override {
    heard_.push_back(idle ? "idle true" : "idle false");
  }
  void Locked(bool locked) override {
    heard_.push_back(locked ? "locked true" : "locked false");
    locked_.SetValue();
  }

  void AppTitled(const std::string&, const std::string&) override {}
  void AppDesktopId(const std::string&, const std::string&) override {}
  void AppAppeared(const std::string& app_id,
                   const std::string& title,
                   const std::string& desktop_id,
                   double width,
                   double height,
                   bool dialog,
                   bool client_frame,
                   mojom::WindowOwnerPtr owner,
                   const std::string& toplevel_id,
                   uint32_t frame) override {
    heard_.push_back(base::StringPrintf(
        "appeared %s as %s %s %s %gx%g%s%s%s%s", app_id.c_str(),
        toplevel_id.c_str(), title.c_str(), desktop_id.c_str(), width, height,
        dialog ? " dialog" : "",
        client_frame ? " client_frame" : "", Owned(owner).c_str(),
        frame ? base::StringPrintf(" frame %u", frame).c_str() : ""));
  }

  // The owner as " owner pid/uid/gid/inode", then its sandbox as
  // " sandbox engine/app/instance" with "-" for an unset one, or "" for none.
  static std::string Owned(const mojom::WindowOwnerPtr& owner) {
    if (!owner) {
      return "";
    }
    const std::string inode =
        owner->pidfd_inode ? base::NumberToString(*owner->pidfd_inode)
                           : "none";
    const std::string sandbox =
        owner->sandbox
            ? base::StringPrintf(" sandbox %s/%s/%s",
                                 owner->sandbox->engine.value_or("-").c_str(),
                                 owner->sandbox->app_id.value_or("-").c_str(),
                                 owner->sandbox->instance_id.value_or("-").c_str())
            : "";
    return base::StringPrintf(" owner %d/%u/%u/%s%s", owner->pid, owner->uid,
                              owner->gid, inode.c_str(), sandbox.c_str());
  }
  void AppResized(const std::string&, double, double) override {}
  void AppMinSize(const std::string&, double, double) override {}
  void AppMaxSize(const std::string&, double, double) override {}
  void PopupPlaced(const std::string& app_id,
                   const std::string& parent,
                   double,
                   double,
                   double,
                   double,
                   bool,
                   std::vector<mojom::AppFramePtr> frames) override {
    std::string heard = "placed " + app_id + " over " + parent;
    for (const mojom::AppFramePtr& frame : frames) {
      heard +=
          base::StringPrintf(" %s@%u", frame->app_id.c_str(), frame->frame);
    }
    heard_.push_back(heard);
  }
  void AppClosed(const std::string& app_id) override {
    heard_.push_back("closed " + app_id);
  }
  void AppCursor(const std::string& app_id,
                 mojom::CursorShape,
                 mojom::AppCursorImagePtr image) override {
    heard_.push_back(
        image ? base::StringPrintf("cursor %s image %s at %d,%d x%d",
                                   app_id.c_str(), image->png.c_str(),
                                   image->hotspot_x, image->hotspot_y,
                                   image->scale)
              : "cursor " + app_id);
  }
  void AppPresented(const std::string& app_id) override {
    heard_.push_back("presented " + app_id);
  }
  void AppPointerConstraint(
      const std::string& app_id,
      std::optional<mojom::PointerConstraint> constraint,
      const std::optional<std::vector<gfx::RectF>>& region) override {
    const char* name = "none";
    if (constraint) {
      name =
          *constraint == mojom::PointerConstraint::kLock ? "lock" : "confine";
    }
    std::string heard = "constraint " + app_id + " " + name;
    if (region) {
      heard += " in";
      for (const gfx::RectF& box : *region) {
        heard += " " + box.ToString();
      }
    }
    heard_.push_back(heard);
  }
  void AppSuspended(const std::string& app_id, bool suspended) override {
    heard_.push_back((suspended ? "suspended " : "resumed ") + app_id);
  }
  void AppTransientFor(const std::string& app_id,
                       const std::string& transient_for) override {
    heard_.push_back(base::StringPrintf("transient %s for %s", app_id.c_str(),
                                        transient_for.c_str()));
  }
  void AppAnchored(const std::string& app_id,
                   const std::string& anchor) override {
    heard_.push_back(base::StringPrintf("anchored %s at %s", app_id.c_str(),
                                        anchor.c_str()));
  }
  void AppUrgent(const std::string& app_id, bool urgent) override {
    heard_.push_back(base::StringPrintf("urgent %s %s", app_id.c_str(),
                                        urgent ? "true" : "false"));
  }
  void AppInhibitsShortcuts(const std::string& app_id, bool inhibits) override {
    heard_.push_back(base::StringPrintf("inhibits %s %s", app_id.c_str(),
                                        inhibits ? "true" : "false"));
  }
  void BrowserToplevelIds(
      const base::flat_map<std::string, std::string>& toplevel_ids) override {
    std::string heard = "browser toplevels";
    for (const auto& [window, toplevel_id] : toplevel_ids) {
      heard += " " + window + "=" + toplevel_id;
    }
    heard_.push_back(heard);
  }
  void ShortcutPressed(mojom::ShortcutPtr) override {}
  void ShortcutReleased(mojom::ShortcutPtr) override {}
  void GesturePerformed(mojom::GesturePtr) override {}
  void ModifierTapped(mojom::TapModifier, base::TimeDelta) override {}
  void Modifiers(bool, bool, bool, bool) override {}
  void Displays(std::vector<mojom::DisplayInfoPtr> displays) override {
    for (const auto& display : displays) {
      heard_.push_back(base::StringPrintf(
          "display %s hdr %s peak %u white %u", display->name.c_str(),
          display->hdr.c_str(), display->peak_luminance, display->sdr_white));
    }
  }
  void Files(const std::string&,
             const std::vector<std::string>&,
             uint32_t,
             bool) override {}
  void Clipboard(std::vector<mojom::ClipboardEntryPtr> entries) override {
    for (const auto& entry : entries) {
      heard_.push_back(base::StringPrintf("clipboard %u '%s'%s", entry->id,
                                          entry->preview.c_str(),
                                          entry->current ? " current" : ""));
    }
  }
  void Tray(std::vector<mojom::TrayItemPtr>) override {}
  void Notifications(std::vector<mojom::NotificationPtr> items) override {
    for (const auto& item : items) {
      heard_.push_back(base::StringPrintf("notification %u from window '%s'",
                                          item->id,
                                          item->browser_window.c_str()));
    }
  }
  void ThemeChanged(mojom::Theme) override {}
  void WindowsThemeChanged(mojom::Theme) override {}
  void AppearanceChanged(const std::optional<std::string>&,
                         bool,
                         bool) override {}
  void ShellConfig(const std::string&) override {}
  void FocusChanged(const std::string&) override {}
  void FocusRequested(const std::string&) override {}
  void System(const std::string& message) override {
    heard_.push_back("system " + message);
  }
  void CompositorReplaced() override {
    heard_.push_back("replaced");
    replaced_.SetValue();
  }
  void PortalRequests(const std::string&) override {}

  std::vector<std::string> heard_;
  base::test::TestFuture<void> locked_;
  base::test::TestFuture<void> replaced_;

 private:
  mojo::Receiver<mojom::ControlChannelClient> receiver_{this};
};

// The result of a net call that may finish now or later.
int Settle(int result, base::test::TestFuture<int>& later) {
  return result == net::ERR_IO_PENDING ? later.Get() : result;
}

class ControlChannelTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(dir_.CreateUniqueTempDir());
    const std::string path = dir_.GetPath().Append("control").value();
    ASSERT_EQ(server_.BindAndListen(path, /*backlog=*/1), net::OK);

    // Self-owned, like every channel: dropping `control_` deletes it.
    new ControlChannel(path, control_.BindNewPipeAndPassReceiver(),
                       keymap_.GetRepeatingCallback<const std::string&>(),
                       base::DoNothing(),
                       base::BindLambdaForTesting(
                           [this](const std::vector<gfx::RectF>& boxes,
                                  base::OnceCallback<void(bool)> confined) {
                             confined_to_ = boxes;
                             std::move(confined).Run(true);
                           }),
                       base::DoNothing(), base::DoNothing(),
                       cursor_theme_.GetRepeatingCallback(),
                       force_dark_.GetRepeatingCallback(), Page{});

    base::test::TestFuture<int> accepted;
    ASSERT_EQ(
        Settle(server_.Accept(&compositor_, accepted.GetCallback()), accepted),
        net::OK);
  }

  void TearDown() override {
    control_.reset();
    base::RunLoop().RunUntilIdle();
  }

  // Writes `lines` to the channel as the compositor.
  void Say(const std::string& lines) {
    auto buffer = base::MakeRefCounted<net::StringIOBuffer>(lines);
    base::test::TestFuture<int> written;
    ASSERT_EQ(Settle(compositor_->Write(buffer.get(), buffer->size(),
                                        written.GetCallback(),
                                        MISSING_TRAFFIC_ANNOTATION),
                     written),
              buffer->size());
  }

  // Takes the next compositor's connection, as a compositor started after the
  // last one exited.
  void AcceptTheNextCompositor() {
    base::test::TestFuture<int> accepted;
    ASSERT_EQ(
        Settle(server_.Accept(&compositor_, accepted.GetCallback()), accepted),
        net::OK);
  }

  // The next line the channel wrote, as the compositor reads it.
  std::string Heard() {
    while (lines_.empty()) {
      auto buffer = base::MakeRefCounted<net::IOBufferWithSize>(4096);
      base::test::TestFuture<int> read;
      const int got = Settle(
          compositor_->Read(buffer.get(), buffer->size(), read.GetCallback()),
          read);
      EXPECT_GT(got, 0);
      if (got <= 0) {
        return "";
      }
      for (std::string& line : framer_.Take(
               std::string_view(buffer->data(), static_cast<size_t>(got)))) {
        lines_.push_back(std::move(line));
      }
    }
    std::string line = std::move(lines_.front());
    lines_.erase(lines_.begin());
    return line;
  }

  base::test::SingleThreadTaskEnvironment task_environment_{
      base::test::TaskEnvironment::MainThreadType::IO};
  base::ScopedTempDir dir_;
  net::UnixDomainServerSocket server_{
      base::BindRepeating(
          [](const net::UnixDomainServerSocket::Credentials&) { return true; }),
      /*use_abstract_namespace=*/false};
  std::unique_ptr<net::StreamSocket> compositor_;
  mojo::Remote<mojom::ControlChannel> control_;
  base::test::TestFuture<std::string> keymap_;
  base::test::TestFuture<std::optional<ui::DeskCursorTheme>> cursor_theme_;
  base::test::TestFuture<std::vector<std::string>> force_dark_;
  std::vector<gfx::RectF> confined_to_;
  FakeClient client_;
  LineFramer framer_;
  std::vector<std::string> lines_;
};

// The compositor answers `hello` with the desk's state, and that answer can
// reach the browser before the page's SetClient does.
TEST_F(ControlChannelTest, ALineBeforeThePageBindsReachesItAfterInOrder) {
  // The keymap is the browser's own, so its arrival says the line before it
  // was read while no page was bound.
  Say("{\"type\":\"idle\",\"idle\":true}\n"
      "{\"type\":\"keymap\",\"keymap\":\"xkb\"}\n");
  EXPECT_EQ(keymap_.Take(), "xkb");

  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"idle true", "locked false"}));
}

// A window is announced with its first frame's size and the client's hints,
// which the shell places it by.
TEST_F(ControlChannelTest, AWindowReachesThePageWithItsSizeAndHints) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_appeared\",\"app_id\":\"app-1\",\"toplevel_id\":"
      "\"t1\",\"title\":"
      "\"pinentry\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":true,\"client_frame\":true}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{
                "appeared app-1 as t1 pinentry  400x300 dialog client_frame",
                "locked false"}));
}

// A window names its toplevel id, which a shell hands capture tools: a line
// without one is dropped.
TEST_F(ControlChannelTest, AWindowWithoutItsToplevelIdIsDropped) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_appeared\",\"app_id\":\"app-1\",\"title\":"
      "\"a\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":false,\"client_frame\":false}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_, (std::vector<std::string>{"locked false"}));
}

// Each browser window's toplevel id reaches the page, by window id. A map
// with a value that is not a string is dropped whole.
TEST_F(ControlChannelTest, EachBrowserWindowsToplevelIdReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"browser_toplevel_ids\",\"toplevel_ids\":"
      "{\"3\":\"Xy7p\",\"7\":\"aU2i\"}}\n"
      "{\"type\":\"browser_toplevel_ids\",\"toplevel_ids\":{\"3\":4}}\n"
      "{\"type\":\"browser_toplevel_ids\",\"toplevel_ids\":{}}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"browser toplevels 3=Xy7p 7=aU2i",
                                      "browser toplevels", "locked false"}));
}

// The page hears when a window reaches the screen and when the compositor
// suspends it. A line missing a field is dropped.
TEST_F(ControlChannelTest, AWindowsPresentationAndSuspensionReachThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_presented\",\"app_id\":\"app-1\"}\n"
      "{\"type\":\"app_presented\"}\n"
      "{\"type\":\"app_suspended\",\"app_id\":\"app-1\",\"suspended\":true}\n"
      "{\"type\":\"app_suspended\",\"app_id\":\"app-1\"}\n"
      "{\"type\":\"app_suspended\",\"app_id\":\"app-1\",\"suspended\":false}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"presented app-1", "suspended app-1",
                                      "resumed app-1", "locked false"}));
}

TEST_F(ControlChannelTest, AWindowReachesThePageWithItsOwner) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  // A uid past 2^31 does not fit base::Value's int.
  Say("{\"type\":\"app_appeared\",\"app_id\":\"app-1\",\"toplevel_id\":"
      "\"t1\",\"title\":"
      "\"a\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":false,\"client_frame\":false,\"owner\":{\"pid\":4242,"
      "\"uid\":4294967294,\"gid\":100,\"pidfd_inode\":5021}}\n"
      "{\"type\":\"app_appeared\",\"app_id\":\"app-2\",\"toplevel_id\":"
      "\"t2\",\"title\":"
      "\"b\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":false,\"client_frame\":false,\"owner\":{\"pid\":7,"
      "\"uid\":1000,\"gid\":1000,\"pidfd_inode\":null,\"sandbox\":"
      "{\"engine\":\"org.flatpak\",\"app_id\":null,\"instance_id\":\"3\"}}}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{
                "appeared app-1 as t1 a  400x300 owner 4242/4294967294/100/5021",
                "appeared app-2 as t2 b  400x300 owner 7/1000/1000/none sandbox "
                "org.flatpak/-/3",
                "locked false"}));
}

// A move names the synced frames it shows with, and a window that appeared
// before the page names its own. A malformed frame is dropped, not shown as
// frame 0.
TEST_F(ControlChannelTest, TheFramesAMoveShowsWithReachThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_appeared\",\"app_id\":\"app-2\",\"toplevel_id\":"
      "\"t2\",\"title\":"
      "\"a\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":false,\"client_frame\":false,\"frame\":3}\n"
      "{\"type\":\"popup_placed\",\"app_id\":\"app-3\",\"parent\":"
      "\"app-2\",\"position\":[12.0,48.0],\"size\":[180.0,240.0],"
      "\"grab\":false,\"frames\":[{\"app_id\":\"app-2\",\"frame\":4},"
      "{\"app_id\":\"app-3\",\"frame\":1},{\"app_id\":\"app-9\"},"
      "{\"app_id\":\"app-9\",\"frame\":-1}]}\n"
      "{\"type\":\"popup_placed\",\"app_id\":\"app-3\",\"parent\":"
      "\"app-2\",\"position\":[12.0,48.0],\"size\":[180.0,240.0],"
      "\"grab\":false}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{
                "appeared app-2 as t2 a  400x300 frame 3",
                "placed app-3 over app-2 app-2@4 app-3@1",
                "placed app-3 over app-2", "locked false"}));
}

// A null parent is a dialog no longer, not a malformed line.
TEST_F(ControlChannelTest, AWindowsParentAndUrgencyReachThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_transient_for\",\"app_id\":\"app-4\","
      "\"transient_for\":\"app-2\"}\n"
      "{\"type\":\"app_transient_for\",\"app_id\":\"app-4\","
      "\"transient_for\":null}\n"
      "{\"type\":\"app_urgent\",\"app_id\":\"app-2\",\"urgent\":true}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"transient app-4 for app-2",
                                      "transient app-4 for ",
                                      "urgent app-2 true", "locked false"}));
}

// A notification names the browser window whose page sent it, and one the
// compositor names none for is from none.
TEST_F(ControlChannelTest, ANotificationsBrowserWindowReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"notifications\",\"items\":["
      "{\"id\":3,\"app_name\":\"mail.example.com\",\"summary\":\"Ada\","
      "\"body\":\"Lunch?\",\"urgency\":\"normal\",\"actions\":[],"
      "\"clickable\":true,\"time\":1,\"browser_window\":\"7\"},"
      "{\"id\":4,\"app_name\":\"Slack\",\"summary\":\"Ada\","
      "\"body\":\"Lunch?\",\"urgency\":\"normal\",\"actions\":[],"
      "\"clickable\":true,\"time\":2}]}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"notification 3 from window '7'",
                                      "notification 4 from window ''",
                                      "locked false"}));
}

// A window's page anchor reaches the page, and a null one is no anchor, not
// a malformed line.
TEST_F(ControlChannelTest, AWindowsAnchorReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_anchored\",\"app_id\":\"app-4\","
      "\"anchor\":\"bar\"}\n"
      "{\"type\":\"app_anchored\",\"app_id\":\"app-4\","
      "\"anchor\":null}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"anchored app-4 at bar",
                                      "anchored app-4 at ", "locked false"}));
}

// A cursor a client drew reaches the page with its PNG, hotspot and scale. A
// named one, or an image missing a part, reaches it as the shape alone.
TEST_F(ControlChannelTest, ACursorAClientDrewReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_cursor\",\"app_id\":\"app-1\","
      "\"cursor\":\"default\",\"image\":{\"png\":\"iVBO\","
      "\"hotspot\":[3,4],\"scale\":2}}\n"
      "{\"type\":\"app_cursor\",\"app_id\":\"app-1\","
      "\"cursor\":\"pointer\"}\n"
      "{\"type\":\"app_cursor\",\"app_id\":\"app-1\","
      "\"cursor\":\"default\",\"image\":{\"png\":\"iVBO\"}}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"cursor app-1 image iVBO at 3,4 x2",
                                      "cursor app-1", "cursor app-1",
                                      "locked false"}));
}

// A window taking and giving back a shortcuts inhibitor reaches the page,
// which lets the desktop's chords through to it meanwhile.
TEST_F(ControlChannelTest, AWindowInhibitingShortcutsReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_inhibits_shortcuts\",\"app_id\":\"app-1\","
      "\"inhibits\":true}\n"
      "{\"type\":\"app_inhibits_shortcuts\",\"app_id\":\"app-1\","
      "\"inhibits\":false}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"inhibits app-1 true",
                                      "inhibits app-1 false", "locked false"}));
}

// Each display says whether it is driven in HDR, so a shell can offer HDR
// only where a panel takes it. A state this browser has no name for, or a
// host that predates the fields, is `unsupported`.
TEST_F(ControlChannelTest, EachDisplaysHdrReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"displays\",\"displays\":["
      "{\"name\":\"lit\",\"position\":[0,0],\"size\":[1920,1080],"
      "\"scale\":1,\"hdr\":\"on\",\"peak_luminance\":1000,"
      "\"sdr_white\":203},"
      "{\"name\":\"able\",\"position\":[1920,0],\"size\":[1920,1080],"
      "\"scale\":1,\"hdr\":\"off\",\"peak_luminance\":600,"
      "\"sdr_white\":0},"
      "{\"name\":\"odd\",\"position\":[3840,0],\"size\":[1920,1080],"
      "\"scale\":1,\"hdr\":\"dolby\"},"
      "{\"name\":\"old\",\"position\":[5760,0],\"size\":[1920,1080],"
      "\"scale\":1}]}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{
                "display lit hdr on peak 1000 white 203",
                "display able hdr off peak 600 white 0",
                "display odd hdr unsupported peak 0 white 0",
                "display old hdr unsupported peak 0 white 0", "locked false"}));
}

// The browser process draws the pointer on a tty, so the theme stops there.
TEST_F(ControlChannelTest, TheDesksPointerThemeReachesTheBrowser) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();

  Say("{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false,\"cursor\":{\"name\":\"Amber\",\"size\":64}}"
      "\n");
  EXPECT_EQ(cursor_theme_.Take(),
            (ui::DeskCursorTheme{.name = "Amber", .size = 64}));

  // A theme with no size is refused, not drawn at some size.
  Say("{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false,\"cursor\":{\"name\":\"Amber\"}}\n"
      "{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false,\"cursor\":{\"name\":\"Base\",\"size\":24}}"
      "\n");
  EXPECT_EQ(cursor_theme_.Take(),
            (ui::DeskCursorTheme{.name = "Base", .size = 24}));

  Say("{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false}\n");
  EXPECT_EQ(cursor_theme_.Take(), std::nullopt);
}

// The browser process hides the pointer, so the settings stop there. Settings
// that cannot be read are refused, and none never hide it.
TEST_F(ControlChannelTest, WhenToHideThePointerReachesTheBrowser) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  base::test::TestFuture<PointerHidingSettings> hiding;
  const DeskPointerHiding::ListenerId listener =
      DeskPointerHiding::Get().AddListener(
          hiding.GetRepeatingCallback<const PointerHidingSettings&>());

  Say("{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false,\"cursor_hiding\":{\"after_ms\":0,"
      "\"when_typing\":true}}\n"
      "{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false,\"cursor_hiding\":{\"after_ms\":1000}}\n"
      "{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false,\"cursor_hiding\":{\"after_ms\":1000,"
      "\"when_typing\":true}}\n");
  EXPECT_EQ(hiding.Take(), (PointerHidingSettings{.after = base::Seconds(1),
                                                  .when_typing = true}));
  // Each appearance names its pointer theme too; take it so the next can.
  EXPECT_EQ(cursor_theme_.Take(), std::nullopt);

  Say("{\"type\":\"appearance\",\"high_contrast\":false,"
      "\"reduced_motion\":false}\n");
  EXPECT_EQ(hiding.Take(), PointerHidingSettings());
  EXPECT_EQ(cursor_theme_.Take(), std::nullopt);
  DeskPointerHiding::Get().RemoveListener(listener);
}

// The sites to draw dark are for this process, so they reach it before the
// page has a client. One whose sites are not strings is dropped.
TEST_F(ControlChannelTest, TheSitesToForceDarkReachTheBrowser) {
  Say("{\"type\":\"force_dark\",\"sites\":[1]}\n"
      "{\"type\":\"force_dark\",\"sites\":[\"mail.google.com\"]}\n");

  EXPECT_EQ(force_dark_.Take(),
            (std::vector<std::string>{"mail.google.com"}));
}

// How to check spelling is this process's too. One whose languages are not
// strings is dropped.
TEST_F(ControlChannelTest, SpellCheckingReachesTheBrowser) {
  base::test::TestFuture<SpellcheckSettings> heard;
  SetSpellcheckSink(heard.GetRepeatingCallback<const SpellcheckSettings&>());

  Say("{\"type\":\"spellcheck\",\"enabled\":true,\"languages\":[1]}\n"
      "{\"type\":\"spellcheck\",\"enabled\":false,"
      "\"languages\":[\"de-DE\"]}\n");

  EXPECT_EQ(heard.Take(),
            (SpellcheckSettings{.enabled = false, .languages = {"de-DE"}}));
  SetSpellcheckSink(SpellcheckSink());
}

// The desk's browser profiles are this process's too, and reach it with the
// page whose channel heard them. Ones that name a profile they do not list are
// dropped.
TEST_F(ControlChannelTest, TheBrowserProfilesReachTheBrowserWithThePage) {
  base::test::TestFuture<Page, BrowserProfiles> heard;
  SetBrowserProfilesSink(
      heard.GetRepeatingCallback<const Page&, const BrowserProfiles&>());

  Say("{\"type\":\"browser_profiles\",\"profiles\":[{\"id\":\"default\","
      "\"name\":\"Personal\",\"color\":\"#0d9488\",\"private\":false}],"
      "\"default_profile\":\"work\",\"default_private_profile\":\"work\","
      "\"sites\":{}}\n"
      "{\"type\":\"browser_profiles\",\"profiles\":[{\"id\":\"default\","
      "\"name\":\"Personal\",\"color\":\"#0d9488\",\"private\":false},"
      "{\"id\":\"private\",\"name\":\"Private\",\"color\":\"#a78bfa\","
      "\"private\":true},{\"id\":\"work\",\"name\":\"Work\","
      "\"color\":\"#2563eb\",\"private\":false,"
      "\"extensions\":[\"aeblfdkhhhdcdjpifhhbdiojplfjncoa\"]}],"
      "\"default_profile\":\"default\",\"default_private_profile\":"
      "\"private\",\"sites\":{\"github.com/acme\":\"work\"}}\n");

  const auto [page, profiles] = heard.Take();
  EXPECT_EQ(page, Page{});
  EXPECT_EQ(profiles.default_profile, "default");
  EXPECT_EQ(profiles.default_private_profile, "private");
  ASSERT_NE(profiles.Find("work"), nullptr);
  EXPECT_EQ(profiles.Find("work")->extensions,
            (std::vector<std::string>{"aeblfdkhhhdcdjpifhhbdiojplfjncoa"}));
  EXPECT_EQ(profiles.sites,
            (std::map<std::string, std::string>{{"github.com/acme", "work"}}));
  SetBrowserProfilesSink(BrowserProfilesSink());
}

// A compositor that exits takes its windows and the page's system calls with
// it. The page hears each window close and each call end, then dials the next
// compositor and hears that it changed. See "A compositor restart" in
// docs/architecture/ENGINE-FORK.md.
TEST_F(ControlChannelTest, ACompositorThatHangsUpEndsWhatItHadAndIsReplaced) {
  control_->SetClient(client_.BindRemote());
  control_->CallSystem(3, R"({"call":"watch","path":"/tmp"})");
  control_->CallSystem(4, R"({"call":"stat","path":"/tmp"})");
  control_->CallSystem(5, R"({"call":"stat","path":"/"})");
  // Driving call 3 is not a new call.
  control_->CallSystem(3, R"({"call":"unwatch"})");
  control_.FlushForTesting();
  Say("{\"type\":\"app_appeared\",\"app_id\":\"app-1\",\"toplevel_id\":"
      "\"t1\",\"title\":"
      "\"a\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":false,\"client_frame\":false}\n"
      "{\"type\":\"app_appeared\",\"app_id\":\"app-2\",\"toplevel_id\":"
      "\"t2\",\"title\":"
      "\"b\",\"desktop_id\":null,\"size\":[400.0,300.0],"
      "\"dialog\":false,\"client_frame\":false}\n"
      "{\"type\":\"app_closed\",\"app_id\":\"app-2\"}\n"
      "{\"type\":\"system_reply\",\"id\":3,\"reply\":"
      "{\"kind\":\"started\"}}\n"
      "{\"type\":\"system_reply\",\"id\":5,\"reply\":{\"kind\":"
      "\"stat\",\"file_type\":\"directory\",\"size\":0}}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());
  client_.heard_.clear();

  compositor_.reset();
  AcceptTheNextCompositor();

  EXPECT_EQ(Heard(), kHello);
  EXPECT_TRUE(client_.replaced_.Wait());
  EXPECT_EQ(
      client_.heard_,
      (std::vector<std::string>{
          "system "
          R"({"end":{"error":{"kind":"compositor_gone","message":"the )"
          R"(compositor exited"},"kind":"failed"},"id":3,"type":"system_end"})",
          "system "
          R"({"id":4,"reply":{"error":{"kind":"compositor_gone","message":)"
          R"("the compositor exited"},"kind":"failed"},"type":"system_reply"})",
          "closed app-1", "replaced"}));
}

// What the page says while no compositor is up reaches the next one, after
// its hello.
TEST_F(ControlChannelTest, APageLineWithNoCompositorUpReachesTheNextOne) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);

  compositor_.reset();
  control_->FocusChrome();
  control_.FlushForTesting();
  AcceptTheNextCompositor();

  EXPECT_EQ(Heard(), kHello);
  EXPECT_EQ(Heard(), R"({"type":"focus_chrome"})");
}

// Whether the shell's module ran goes to the `load_shell` waiting on it, and
// never to the compositor.
TEST_F(ControlChannelTest, WhetherTheShellRanReachesTheBrowserOnly) {
  // The process-wide reports keep their listeners for good, so this one's
  // record does too, and they listen once however often this runs.
  static base::NoDestructor<std::vector<ShellOutcome>> heard;
  [[maybe_unused]] static const bool listening = [] {
    ShellReports::Get().Listen(base::BindRepeating(
        [](const std::string& serial, const ShellOutcome& ran) {
          EXPECT_EQ(serial, "7");
          heard->push_back(ran);
        }));
    return true;
  }();
  heard->clear();
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);

  control_->ShellFailed("7", "the shell's Shell threw: TypeError");
  control_->ShellRan("7");
  control_->FocusChrome();
  control_.FlushForTesting();

  EXPECT_EQ(*heard,
            (std::vector<ShellOutcome>{"the shell's Shell threw: TypeError",
                                       std::nullopt}));
  EXPECT_EQ(Heard(), R"({"type":"focus_chrome"})");
}

// The compositor's casts draw the pointer on screen, which only the browser
// has. A compositor that connects later hears it as it is, after `hello`.
TEST_F(ControlChannelTest, ThePointerOnScreenReachesTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);

  ui::DeskCursorImage hand;
  hand.size = gfx::Size(1, 1);
  hand.hotspot = gfx::Point(0, 0);
  hand.scale = 2;
  hand.bgra = {1, 2, 3, 255};
  ui::DeskCursorImageSource::Get().Set(hand);
  EXPECT_EQ(Heard(),
            R"({"image":{"bgra":"AQID/w==","hotspot":[0,0],"scale":2.0,)"
            R"("size":[1,1]},"type":"desk_cursor"})");

  ui::DeskCursorImageSource::Get().Set(ui::DeskCursorImage());
  EXPECT_EQ(Heard(), R"({"type":"desk_cursor"})");

  compositor_.reset();
  AcceptTheNextCompositor();
  EXPECT_EQ(Heard(), kHello);
  EXPECT_EQ(Heard(), R"({"type":"desk_cursor"})");

  ui::DeskCursorImageSource::Get().ResetForTesting();
}

TEST_F(ControlChannelTest, ScrollSourcesAndAxisStopsReachTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  for (const auto& [source, name] :
       {std::pair(mojom::PointerAxisSource::kWheel, "wheel"),
        std::pair(mojom::PointerAxisSource::kFinger, "finger"),
        std::pair(mojom::PointerAxisSource::kContinuous, "continuous"),
        std::pair(mojom::PointerAxisSource::kWheelTilt, "wheel_tilt")}) {
    control_->PointerAxis("app", 0, 4.5, 0, 0, source, true, false);
    control_.FlushForTesting();
    const auto frame =
        base::JSONReader::ReadDict(Heard(), base::JSON_PARSE_RFC);
    ASSERT_TRUE(frame);
    ASSERT_TRUE(frame->FindString("source"));
    EXPECT_EQ(*frame->FindString("source"), name);
    EXPECT_EQ(frame->FindBool("stop_x"), true);
    EXPECT_EQ(frame->FindBool("stop_y"), false);
    EXPECT_EQ(frame->FindDouble("dy"), 4.5);
    EXPECT_EQ(frame->FindInt("v120_y"), 0);
  }
}

// A hand's relative motion reaches the compositor as its deltas, accelerated
// and not.
TEST_F(ControlChannelTest, RelativeMotionReachesTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  control_->PointerRelative("app", 3.5, -2, 1.25, -0.5);
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), R"({"app_id":"app","dx":3.5,"dx_unaccel":1.25,"dy":-2.0,)"
                     R"("dy_unaccel":-0.5,"type":"pointer_relative"})");
}

// A page confining the pointer stops in the browser, which draws the pointer,
// and hears whether the platform holds it.
TEST_F(ControlChannelTest, ConfiningThePointerStopsInTheBrowser) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  base::test::TestFuture<bool> confined;
  control_->ConfinePointer({gfx::RectF(10, 20, 300, 200)},
                           confined.GetCallback());
  EXPECT_TRUE(confined.Get());
  ASSERT_EQ(confined_to_.size(), 1u);
  EXPECT_EQ(confined_to_[0].x(), 10);
  EXPECT_EQ(confined_to_[0].y(), 20);
  EXPECT_EQ(confined_to_[0].width(), 300);
  EXPECT_EQ(confined_to_[0].height(), 200);
}

// A window's ask to lock or confine the pointer reaches the page, `null`
// withdraws it, and a kind this engine does not know is dropped.
TEST_F(ControlChannelTest, APointerConstraintReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_pointer_constraint\",\"app_id\":\"game\","
      "\"constraint\":\"lock\"}\n"
      "{\"type\":\"app_pointer_constraint\",\"app_id\":\"game\","
      "\"constraint\":\"wiggle\"}\n"
      "{\"type\":\"app_pointer_constraint\",\"app_id\":\"game\","
      "\"constraint\":\"confine\"}\n"
      "{\"type\":\"app_pointer_constraint\",\"app_id\":\"game\","
      "\"constraint\":null}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"constraint game lock",
                                      "constraint game confine",
                                      "constraint game none", "locked false"}));
}

// A confinement's region reaches the page as boxes, and a box that is not one
// drops the message.
TEST_F(ControlChannelTest, APointerRegionReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"app_pointer_constraint\",\"app_id\":\"game\","
      "\"constraint\":\"confine\",\"region\":[{\"x\":10,\"y\":20,"
      "\"width\":300,\"height\":200},{\"x\":0,\"y\":220,\"width\":40,"
      "\"height\":10}]}\n"
      "{\"type\":\"app_pointer_constraint\",\"app_id\":\"game\","
      "\"constraint\":\"confine\",\"region\":[{\"x\":10}]}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{
                "constraint game confine in 10,20 300x200 0,220 40x10",
                "locked false"}));
}

// Which clipboard row is current reaches the page, and a row that does not
// say is dropped.
TEST_F(ControlChannelTest, TheCurrentClipboardRowReachesThePage) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  Say("{\"type\":\"clipboard\",\"entries\":["
      "{\"id\":3,\"image\":false,\"preview\":\"now\",\"current\":true},"
      "{\"id\":2,\"image\":false,\"preview\":\"before\",\"current\":false},"
      "{\"id\":1,\"image\":false,\"preview\":\"unsaid\"}]}\n"
      "{\"type\":\"locked\",\"locked\":false}\n");
  EXPECT_TRUE(client_.locked_.Wait());

  EXPECT_EQ(client_.heard_,
            (std::vector<std::string>{"clipboard 3 'now' current",
                                      "clipboard 2 'before'", "locked false"}));
}

// Removing a clipboard row reaches the compositor as its id.
TEST_F(ControlChannelTest, RemovingAClipboardRowReachesTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  control_->RemoveClipboardEntry(7);
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), R"({"entry":7,"type":"remove_clipboard_entry"})");
}

// The page taking and letting go of the pointer reaches the compositor.
TEST_F(ControlChannelTest, ThePageTakingThePointerReachesTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  control_->PointerConstrained("game", true);
  control_.FlushForTesting();
  EXPECT_EQ(Heard(),
            R"({"active":true,"app_id":"game","type":"pointer_constrained"})");
}

TEST_F(ControlChannelTest, TouchesKeepTheirPointsAndUnsignedTimes) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  for (const auto& [phase, name] :
       {std::pair(mojom::TouchPhase::kDown, "down"),
        std::pair(mojom::TouchPhase::kMotion, "motion"),
        std::pair(mojom::TouchPhase::kUp, "up"),
        std::pair(mojom::TouchPhase::kCancel, "cancel")}) {
    control_->Touch("app", mojom::Touch::New(phase, 4, 3000000000u, 12.5, 40));
    control_.FlushForTesting();
    const std::string line = Heard();
    EXPECT_NE(line.find("3000000000"), std::string::npos);
    EXPECT_EQ(line.find("3000000000.0"), std::string::npos);
    const auto frame = base::JSONReader::ReadDict(line, base::JSON_PARSE_RFC);
    ASSERT_TRUE(frame);
    EXPECT_EQ(*frame->FindString("type"), "touch");
    EXPECT_EQ(*frame->FindString("app_id"), "app");
    EXPECT_EQ(*frame->FindString("phase"), name);
    const bool placed = phase == mojom::TouchPhase::kDown ||
                        phase == mojom::TouchPhase::kMotion;
    EXPECT_EQ(frame->FindDouble("x").has_value(), placed);
    if (placed) {
      EXPECT_EQ(frame->FindDouble("x"), 12.5);
      EXPECT_EQ(frame->FindDouble("y"), 40);
    }
    EXPECT_EQ(frame->FindInt("id").has_value(),
              phase != mojom::TouchPhase::kCancel);
  }
}

TEST_F(ControlChannelTest, PinchPhasesKeepUnsignedTimesAndAbsoluteScale) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);
  for (const auto phase :
       {mojom::PinchPhase::kBegin, mojom::PinchPhase::kUpdate,
        mojom::PinchPhase::kEnd}) {
    auto pinch =
        mojom::Pinch::New(phase, 7, 3000000000u, 3, 1.25, -2.5, 1.6, -12, true);
    control_->PointerPinch("app", std::move(pinch));
    control_.FlushForTesting();
    const std::string line = Heard();
    EXPECT_NE(line.find("3000000000"), std::string::npos);
    EXPECT_EQ(line.find("3000000000.0"), std::string::npos);
    const auto frame = base::JSONReader::ReadDict(line, base::JSON_PARSE_RFC);
    ASSERT_TRUE(frame);
    EXPECT_EQ(*frame->FindString("type"), "pointer_pinch");
    EXPECT_EQ(frame->FindInt("device"), 7);
    switch (phase) {
      case mojom::PinchPhase::kBegin:
        EXPECT_EQ(*frame->FindString("phase"), "begin");
        EXPECT_EQ(frame->FindInt("fingers"), 3);
        break;
      case mojom::PinchPhase::kUpdate:
        EXPECT_EQ(*frame->FindString("phase"), "update");
        EXPECT_EQ(frame->FindDouble("scale"), 1.6);
        EXPECT_EQ(frame->FindDouble("rotation"), -12);
        break;
      case mojom::PinchPhase::kEnd:
        EXPECT_EQ(*frame->FindString("phase"), "end");
        EXPECT_EQ(frame->FindBool("canceled"), true);
        break;
    }
  }
}

// A swipe or hold the shell did not grab names no window: the compositor
// gives it to the one under the pointer.
TEST_F(ControlChannelTest, UnboundSwipesAndHoldsReachTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);

  DeskGestures& gestures = DeskGestures::Get();
  const auto swipe = [](ui::NativeGesturePhase phase) {
    return ui::NativeGesture{.kind = ui::NativeGestureKind::kSwipe,
                             .phase = phase,
                             .fingers = 4,
                             .dx = 1.25,
                             .dy = -2.5};
  };
  const auto hold = [](ui::NativeGesturePhase phase) {
    return ui::NativeGesture{.kind = ui::NativeGestureKind::kHold,
                             .phase = phase,
                             .fingers = 3,
                             .canceled = true};
  };
  ASSERT_TRUE(gestures.Takes(swipe(ui::NativeGesturePhase::kBegin)));
  gestures.Take(swipe(ui::NativeGesturePhase::kBegin));
  gestures.Take(swipe(ui::NativeGesturePhase::kUpdate));
  gestures.Take(swipe(ui::NativeGesturePhase::kEnd));
  gestures.Take(hold(ui::NativeGesturePhase::kBegin));
  gestures.Take(hold(ui::NativeGesturePhase::kEnd));

  EXPECT_EQ(Heard(), R"({"fingers":4,"phase":"begin","type":"pointer_swipe"})");
  EXPECT_EQ(Heard(),
            R"({"dx":1.25,"dy":-2.5,"phase":"update","type":"pointer_swipe"})");
  EXPECT_EQ(Heard(),
            R"({"canceled":false,"phase":"end","type":"pointer_swipe"})");
  EXPECT_EQ(Heard(), R"({"fingers":3,"phase":"begin","type":"pointer_hold"})");
  EXPECT_EQ(Heard(),
            R"({"canceled":true,"phase":"end","type":"pointer_hold"})");
}

// A bug the engine caught in itself reaches the compositor, which tells the
// person.
TEST_F(ControlChannelTest, AnEngineFaultReachesTheCompositor) {
  control_->SetClient(client_.BindRemote());
  control_.FlushForTesting();
  EXPECT_EQ(Heard(), kHello);

  DeskFaults::Get().Report("A page stayed in fullscreen.");

  EXPECT_EQ(Heard(),
            R"({"type":"engine_fault","what":"A page stayed in fullscreen."})");
}

}  // namespace
}  // namespace domicile

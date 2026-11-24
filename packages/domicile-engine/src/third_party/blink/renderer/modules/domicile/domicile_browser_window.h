// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_BROWSER_WINDOW_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_BROWSER_WINDOW_H_

#include <cstdint>
#include <optional>

#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

// One of the desk's browser windows, as the browser listed it.
//
// Immutable, like DomicileDisplay: the browser resends the whole list on every
// change, so each window is replaced, never edited.
class MODULES_EXPORT DomicileBrowserWindow final : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  DomicileBrowserWindow(const String& id,
                        const String& url,
                        const String& title,
                        std::optional<int32_t> popup_window,
                        int32_t width,
                        int32_t height,
                        bool is_private,
                        const String& partition,
                        const String& profile,
                        bool is_app,
                        const String& app_id,
                        bool is_captured,
                        const String& toplevel_id,
                        const String& parent,
                        int32_t x,
                        int32_t y,
                        bool is_hidden,
                        const String& menu,
                        bool menu_bar_visible,
                        bool menu_bar_auto_hide,
                        const String& message_box,
                        const String& popup_menu,
                        bool wants_maximized,
                        bool wants_minimized,
                        bool wants_fullscreen);
  ~DomicileBrowserWindow() override;

  const String& id() const { return id_; }
  const String& url() const { return url_; }
  const String& title() const { return title_; }
  std::optional<int32_t> popupWindow() const { return popup_window_; }
  int32_t width() const { return width_; }
  int32_t height() const { return height_; }
  bool isPrivate() const { return is_private_; }
  const String& partition() const { return partition_; }
  const String& profile() const { return profile_; }
  bool isApp() const { return is_app_; }
  const String& appId() const { return app_id_; }
  bool isCaptured() const { return is_captured_; }
  const String& toplevelId() const { return toplevel_id_; }
  // Null for a window, as the empty string the browser sends for none.
  const String& parent() const { return parent_; }
  int32_t x() const { return x_; }
  int32_t y() const { return y_; }
  bool isHidden() const { return is_hidden_; }
  // Null for a window with no menu, as the empty string the browser sends.
  const String& menu() const { return menu_; }
  bool menuBarVisible() const { return menu_bar_visible_; }
  bool menuBarAutoHide() const { return menu_bar_auto_hide_; }
  // Null for none, as the empty string the browser sends.
  const String& messageBox() const { return message_box_; }
  // Null for none, as the empty string the browser sends.
  const String& popupMenu() const { return popup_menu_; }
  bool wantsMaximized() const { return wants_maximized_; }
  bool wantsMinimized() const { return wants_minimized_; }
  bool wantsFullscreen() const { return wants_fullscreen_; }

  void Trace(Visitor*) const override;

 private:
  String id_;
  String url_;
  String title_;
  std::optional<int32_t> popup_window_;
  int32_t width_ = 0;
  int32_t height_ = 0;
  bool is_private_ = false;
  String partition_;
  String profile_;
  bool is_app_ = false;
  String app_id_;
  bool is_captured_ = false;
  String toplevel_id_;
  String parent_;
  int32_t x_ = 0;
  int32_t y_ = 0;
  bool is_hidden_ = false;
  String menu_;
  bool menu_bar_visible_ = true;
  bool menu_bar_auto_hide_ = false;
  String message_box_;
  String popup_menu_;
  bool wants_maximized_ = false;
  bool wants_minimized_ = false;
  bool wants_fullscreen_ = false;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_BROWSER_WINDOW_H_

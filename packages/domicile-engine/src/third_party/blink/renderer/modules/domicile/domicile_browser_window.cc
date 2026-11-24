// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_browser_window.h"

namespace blink {

DomicileBrowserWindow::DomicileBrowserWindow(
    const String& id,
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
    bool wants_fullscreen)
    : id_(id),
      url_(url),
      title_(title),
      popup_window_(popup_window),
      width_(width),
      height_(height),
      is_private_(is_private),
      partition_(partition),
      profile_(profile),
      is_app_(is_app),
      app_id_(app_id),
      is_captured_(is_captured),
      toplevel_id_(toplevel_id),
      parent_(parent),
      x_(x),
      y_(y),
      is_hidden_(is_hidden),
      menu_(menu),
      menu_bar_visible_(menu_bar_visible),
      menu_bar_auto_hide_(menu_bar_auto_hide),
      message_box_(message_box),
      popup_menu_(popup_menu),
      wants_maximized_(wants_maximized),
      wants_minimized_(wants_minimized),
      wants_fullscreen_(wants_fullscreen) {}

DomicileBrowserWindow::~DomicileBrowserWindow() = default;

void DomicileBrowserWindow::Trace(Visitor* visitor) const {
  ScriptWrappable::Trace(visitor);
}

}  // namespace blink

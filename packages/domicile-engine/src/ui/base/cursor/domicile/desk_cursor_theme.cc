// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/base/cursor/domicile/desk_cursor_theme.h"

#include <utility>

#include "base/check.h"
#include "base/logging.h"
#include "base/no_destructor.h"

namespace ui {

// static
DeskCursorThemeSource& DeskCursorThemeSource::Get() {
  static base::NoDestructor<DeskCursorThemeSource> source;
  return *source;
}

DeskCursorThemeSource::DeskCursorThemeSource() = default;

DeskCursorThemeSource::~DeskCursorThemeSource() = default;

const std::optional<DeskCursorTheme>& DeskCursorThemeSource::theme() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return theme_;
}

void DeskCursorThemeSource::Set(std::optional<DeskCursorTheme> theme) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (theme_ == theme) {
    return;
  }
  theme_ = std::move(theme);
  // The line to look for on hardware when the pointer did not change.
  if (theme_) {
    VLOG(1) << "domicile: the desk's pointer theme is \"" << theme_->name
            << "\" at " << theme_->size << " px";
  } else {
    // At ERROR: the engine logs nothing quieter, and every pointer turning
    // into Chromium's art is what a person reports.
    LOG(ERROR) << "domicile: the desk names no pointer theme; the pointer is "
                  "Chromium's own";
  }
  for (Observer& observer : observers_) {
    observer.OnDeskCursorThemeChanged();
  }
}

void DeskCursorThemeSource::AddObserver(Observer* observer) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  observers_.AddObserver(observer);
}

void DeskCursorThemeSource::RemoveObserver(Observer* observer) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  observers_.RemoveObserver(observer);
}

void SetDeskCursorTheme(std::optional<DeskCursorTheme> theme) {
  DeskCursorThemeSource::Get().Set(std::move(theme));
}

}  // namespace ui

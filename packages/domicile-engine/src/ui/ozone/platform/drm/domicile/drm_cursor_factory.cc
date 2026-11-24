// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_cursor_factory.h"

#include <algorithm>
#include <cstdlib>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/numerics/safe_conversions.h"
#include "base/task/thread_pool.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/cursor/mojom/cursor_type.mojom-shared.h"
#include "ui/base/cursor/platform_cursor.h"
#include "ui/gfx/geometry/point.h"

namespace ui {
namespace {

// The theme from the XCursor search path this process was started with.
base::flat_map<mojom::CursorType, XCursorImages> LoadFromDisk(
    const DeskCursorTheme& theme,
    int size) {
  const std::unique_ptr<base::Environment> env = base::Environment::Create();
  return LoadXCursorTheme(
      XCursorSearchPath({.xcursor_path = env->GetVar("XCURSOR_PATH"),
                         .xdg_data_home = env->GetVar("XDG_DATA_HOME"),
                         .xdg_data_dirs = env->GetVar("XDG_DATA_DIRS")},
                        base::GetHomeDir()),
      theme.name, size);
}

}  // namespace

DrmCursorFactory::DrmCursorFactory()
    : DrmCursorFactory(DeskCursorThemeSource::Get(),
                       base::BindRepeating(&LoadFromDisk)) {}

DrmCursorFactory::DrmCursorFactory(DeskCursorThemeSource& source,
                                   ThemeLoader load)
    : source_(source), load_(std::move(load)) {
  observation_.Observe(&source);
}

DrmCursorFactory::~DrmCursorFactory() = default;

scoped_refptr<PlatformCursor> DrmCursorFactory::GetDefaultCursor(
    mojom::CursorType type) {
  return GetDefaultCursor(type, 1.0f);
}

scoped_refptr<PlatformCursor> DrmCursorFactory::GetDefaultCursor(
    mojom::CursorType type,
    float scale) {
  return GetTurnedDefaultCursor(type, scale,
                                [](SkBitmap&, gfx::Point&) {});
}

scoped_refptr<PlatformCursor> DrmCursorFactory::GetTurnedDefaultCursor(
    mojom::CursorType type,
    float scale,
    CursorTurn turn) {
  // `kNone` has no art. `DrmCursor` hides the cursor based on its type, so
  // return the base's typed, bitmapless cursor.
  if (type == mojom::CursorType::kNone) {
    return BitmapCursorFactory::GetDefaultCursor(type);
  }

  // Null makes `CursorLoader` load the cursor from assets. A typed,
  // bitmapless cursor would draw nothing on a CRTC.
  const std::optional<DeskCursorTheme>& theme = source_->theme();
  if (!theme) {
    return nullptr;
  }

  const int size = base::ClampRound(theme->size * scale);
  if (!loaded_.contains(size) && loading_.insert(size).second) {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE,
        {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
         base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
        base::BindOnce(load_, *theme, size),
        base::BindOnce(&DrmCursorFactory::Loaded, weak_factory_.GetWeakPtr(),
                       *theme, size));
    // Expected on every start, so not an error: `Loaded` says at ERROR when
    // the theme turns out to be missing.
    VLOG_IF(1, loaded_.empty())
        << "domicile: the pointer is Chromium's until \"" << theme->name
        << "\" at " << size << " px loads";
  }
  // Until `size` loads, the nearest loaded size stands in: a monitor at a new
  // density draws the theme a little off size rather than Chromium's art.
  const auto cursors = NearestLoaded(size);
  if (cursors == loaded_.end()) {
    return nullptr;
  }

  // `kNull` is "no cursor named": the default pointer. Answering it with
  // nothing loaded Chromium's own arrow instead of the theme's, which showed
  // whenever the pointer came back from hiding over a window naming none.
  const auto cursor = cursors->second.find(
      type == mojom::CursorType::kNull ? mojom::CursorType::kPointer : type);
  if (cursor == cursors->second.end()) {
    // A theme with no cursors at all was said once, when it loaded.
    if (!cursors->second.empty() && said_lacking_.insert(type).second) {
      LOG(ERROR) << "domicile: the pointer theme \"" << theme->name
                 << "\" has no cursor for type " << type
                 << "; it is Chromium's";
    }
    return nullptr;
  }

  // Each frame is turned with its own copy of the theme's hotspot. A theme
  // gives every frame the same one, so they all turn it the same way.
  std::vector<SkBitmap> frames = cursor->second.frames;
  gfx::Point hotspot;
  for (SkBitmap& frame : frames) {
    hotspot = cursor->second.hotspot;
    turn(frame, hotspot);
  }
  const float image_scale = static_cast<float>(cursors->first) / theme->size;
  return frames.size() == 1
             ? CreateImageCursor(type, frames[0], hotspot, image_scale)
             : CreateAnimatedCursor(type, frames, hotspot, image_scale,
                                    cursor->second.frame_delay);
}

bool DrmCursorFactory::ShowsCursorsUnturned() const {
  return true;
}

void DrmCursorFactory::ObserveThemeChanges() {}

void DrmCursorFactory::OnDeskCursorThemeChanged() {
  loaded_.clear();
  loading_.clear();
  said_lacking_.clear();
  weak_factory_.InvalidateWeakPtrs();
  NotifyObserversOnThemeLoaded();
}

DrmCursorFactory::Sizes::const_iterator DrmCursorFactory::NearestLoaded(
    int size) const {
  // A tie goes to the larger size: shrunk art looks better than grown.
  return std::ranges::min_element(
      loaded_, [size](const auto& a, const auto& b) {
        const int to_a = std::abs(a.first - size);
        const int to_b = std::abs(b.first - size);
        return to_a != to_b ? to_a < to_b : a.first > b.first;
      });
}

void DrmCursorFactory::Loaded(
    const DeskCursorTheme& theme,
    int size,
    base::flat_map<mojom::CursorType, XCursorImages> images) {
  loading_.erase(size);
  const base::flat_map<mojom::CursorType, XCursorImages>& cursors =
      loaded_[size] = std::move(images);

  // The lines to look for on hardware when the pointer did not change.
  if (cursors.empty()) {
    LOG(ERROR) << "domicile: no cursor theme \"" << theme.name
               << "\" on the XCursor path (XCURSOR_PATH, or icons under "
                  "XDG_DATA_HOME and XDG_DATA_DIRS); the pointer is "
                  "Chromium's own";
  } else {
    VLOG(1) << "domicile: loaded " << cursors.size() << " cursors from \""
            << theme.name << "\" at " << size << " px";
  }
  NotifyObserversOnThemeLoaded();
}

}  // namespace ui

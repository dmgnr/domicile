// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_CURSOR_FACTORY_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_CURSOR_FACTORY_H_

#include "base/containers/flat_map.h"
#include "base/containers/flat_set.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "ui/base/cursor/cursor_factory.h"
#include "ui/base/cursor/domicile/desk_cursor_theme.h"
#include "ui/base/cursor/domicile/xcursor_theme.h"
#include "ui/base/cursor/mojom/cursor_type.mojom-shared.h"
#include "ui/ozone/common/bitmap_cursor_factory.h"

namespace ui {

class PlatformCursor;

// Cursor factory for a views browser on a tty. Answers each type from the
// desk's XCursor theme (`DeskCursorThemeSource`), and with null where the
// theme has none or is unset, so `wm::CursorLoader` loads Chromium's art.
//
// `wm::CursorLoader` uses any non-null platform cursor and loads assets only
// on null. `BitmapCursorFactory` returns a typed cursor with no bitmap, which
// suits compositors that draw cursors by type. ozone/drm passes that empty
// bitmap to `drmModeSetCursor2` with handle 0, which hides the cursor without
// any error. Ash avoids this by building its loader with
// `use_platform_cursors=false`; `views::DesktopNativeCursorManager` uses the
// default, true.
//
// `kNone` must still be answered: the loader always asks the platform for it,
// and `DrmCursor` hides the cursor on that type. Null would show an arrow.
//
// A theme loads on the thread pool, once per size in pixels, the first time a
// cursor is asked for at that size. Until then the nearest loaded size stands
// in, or the answer is null when none has loaded. When it
// loads, and when the theme changes, the factory tells its observers, which
// drop their cursors and set the one on screen again.
//
// The loader logs one "Failed to load a platform cursor" warning per type it
// draws from its art. That is the expected fallback, not an error.
class DrmCursorFactory : public BitmapCursorFactory,
                         public DeskCursorThemeSource::Observer {
 public:
  // Every cursor of `theme` at `size` pixels. Run on the thread pool.
  using ThemeLoader =
      base::RepeatingCallback<base::flat_map<mojom::CursorType, XCursorImages>(
          const DeskCursorTheme& theme,
          int size)>;

  // Follows the process's theme, read from the XCursor search path.
  DrmCursorFactory();
  DrmCursorFactory(DeskCursorThemeSource& source, ThemeLoader load);

  DrmCursorFactory(const DrmCursorFactory&) = delete;
  DrmCursorFactory& operator=(const DrmCursorFactory&) = delete;

  ~DrmCursorFactory() override;

  // At a scale of 1.
  scoped_refptr<PlatformCursor> GetDefaultCursor(
      mojom::CursorType type) override;

  // The theme's cursor for `type` at the theme's size times `scale`, or null.
  scoped_refptr<PlatformCursor> GetDefaultCursor(mojom::CursorType type,
                                                 float scale) override;

  // As `GetDefaultCursor`, with every frame passed through `turn`.
  scoped_refptr<PlatformCursor> GetTurnedDefaultCursor(
      mojom::CursorType type,
      float scale,
      CursorTurn turn) override;

  // True: a CRTC shows the cursor as it is given, so a page's cursor image is
  // turned for a rotated panel before it gets here.
  bool ShowsCursorsUnturned() const override;

  // No-op: the theme comes from the desk's config, not a toolkit. The base's
  // `NOTIMPLEMENTED()` would log an error on every start.
  void ObserveThemeChanges() override;

  // DeskCursorThemeSource::Observer:
  void OnDeskCursorThemeChanged() override;

 private:
  // A theme's cursors by size in pixels.
  using Sizes =
      base::flat_map<int, base::flat_map<mojom::CursorType, XCursorImages>>;

  // The loaded size nearest `size`, or `loaded_.end()` when none is.
  Sizes::const_iterator NearestLoaded(int size) const;

  void Loaded(const DeskCursorTheme& theme,
              int size,
              base::flat_map<mojom::CursorType, XCursorImages> images);

  const raw_ref<DeskCursorThemeSource> source_;
  const ThemeLoader load_;

  // The theme's cursors by size in pixels.
  Sizes loaded_;
  // Sizes posted to the thread pool and not yet back.
  base::flat_set<int> loading_;
  // Types the theme lacks that were already logged.
  base::flat_set<mojom::CursorType> said_lacking_;

  base::ScopedObservation<DeskCursorThemeSource,
                          DeskCursorThemeSource::Observer>
      observation_{this};
  // Invalidated when the theme changes, which drops loads of the old one.
  base::WeakPtrFactory<DrmCursorFactory> weak_factory_{this};
};

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_CURSOR_FACTORY_H_

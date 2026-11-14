#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/thorium-poc/apply-domicile-ports.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

mkdir -p "$TMP/chromium"
git -C "$TMP/chromium" init -q
git -C "$TMP/chromium" config user.email fixture@example.invalid
git -C "$TMP/chromium" config user.name Fixture
printf 'header\nbase\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ntail\n' > "$TMP/chromium/shared.cc"
git -C "$TMP/chromium" add shared.cc
git -C "$TMP/chromium" commit -qm base

mkdir -p "$TMP/patches"
printf 'header\nthorium\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ntail\n' > "$TMP/chromium/shared.cc"
git -C "$TMP/chromium" add shared.cc
git -C "$TMP/chromium" commit -qm thorium
THORIUM_COMMIT="$(git -C "$TMP/chromium" rev-parse HEAD)"
git -C "$TMP/chromium" reset --hard -q HEAD~1
printf 'header\nbase\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ndomicile\n' > "$TMP/chromium/shared.cc"
git -C "$TMP/chromium" add shared.cc
git -C "$TMP/chromium" commit -qm domicile-port
git -C "$TMP/chromium" format-patch -1 --stdout > "$TMP/patches/0001-domicile.patch"
git -C "$TMP/chromium" reset --hard -q "$THORIUM_COMMIT"
git -C "$TMP/chromium" reset --hard -q HEAD~1

# Match Thorium's canonical `git apply --reject`: source changes are unstaged.
printf 'header\nthorium\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ntail\n' > "$TMP/chromium/shared.cc"

if "$SCRIPT" --root "$TMP/chromium" --series "$TMP/patches" --overrides "$TMP/patches" >"$TMP/apply.log" 2>&1; then
  :
else
  fail "Domicile port did not apply after an unstaged Thorium patch: $(cat "$TMP/apply.log")"
fi
grep -q '^thorium$' "$TMP/chromium/shared.cc" || fail "Thorium change was lost"
grep -q '^domicile$' "$TMP/chromium/shared.cc" || fail "Domicile change was lost"

# A port series replaces matching upstream patches and keeps every other patch.
mkdir -p "$TMP/source-patches" "$TMP/overrides"
mkdir -p "$TMP/series-chromium"
git -C "$TMP/series-chromium" init -q
git -C "$TMP/series-chromium" config user.email fixture@example.invalid
git -C "$TMP/series-chromium" config user.name Fixture
printf 'base\n' > "$TMP/series-chromium/override.txt"
printf 'base\n' > "$TMP/series-chromium/fallback.txt"
git -C "$TMP/series-chromium" add .
git -C "$TMP/series-chromium" commit -qm base
SERIES_BASE="$(git -C "$TMP/series-chromium" rev-parse HEAD)"

printf 'upstream\n' > "$TMP/series-chromium/override.txt"
git -C "$TMP/series-chromium" add override.txt
git -C "$TMP/series-chromium" commit -qm upstream-override
git -C "$TMP/series-chromium" format-patch -1 --stdout > "$TMP/source-patches/0001.patch"
UPSTREAM_OVERRIDE="$(git -C "$TMP/series-chromium" rev-parse HEAD)"
git -C "$TMP/series-chromium" reset --hard -q "$SERIES_BASE"
printf 'ported\n' > "$TMP/series-chromium/override.txt"
git -C "$TMP/series-chromium" add override.txt
git -C "$TMP/series-chromium" commit -qm ported-override
git -C "$TMP/series-chromium" format-patch -1 --stdout > "$TMP/overrides/0001.patch"
git -C "$TMP/series-chromium" reset --hard -q "$SERIES_BASE"

printf 'fallback-applied\n' > "$TMP/series-chromium/fallback.txt"
git -C "$TMP/series-chromium" add fallback.txt
git -C "$TMP/series-chromium" commit -qm upstream-fallback
git -C "$TMP/series-chromium" format-patch -1 --stdout > "$TMP/source-patches/0002.patch"
git -C "$TMP/series-chromium" reset --hard -q "$SERIES_BASE"

if "$SCRIPT" --root "$TMP/series-chromium" --series "$TMP/source-patches" --overrides "$TMP/overrides" >"$TMP/series.log" 2>&1; then
  :
else
  fail "ported series did not apply: $(cat "$TMP/series.log")"
fi
grep -q '^ported$' "$TMP/series-chromium/override.txt" || fail "matching override was not selected"
grep -q '^fallback-applied$' "$TMP/series-chromium/fallback.txt" || fail "unported original patch was skipped"

mkdir -p "$TMP/tab-series" "$TMP/tab-overrides" "$TMP/tab-chromium/chrome/browser/extensions"
git -C "$TMP/tab-chromium" init -q
git -C "$TMP/tab-chromium" config user.email fixture@example.invalid
git -C "$TMP/tab-chromium" config user.name Fixture
cat > "$TMP/tab-chromium/chrome/browser/extensions/extension_tab_util.cc" <<'EOF'
void ExtensionTabUtil::ForEachTab(
    Callback callback) {
  tabs::ForEachTabInterface([&callback](Tab* tab) {
    callback.Run(tab->GetContents());
    return true;
  });
}
EOF
git -C "$TMP/tab-chromium" add .
git -C "$TMP/tab-chromium" commit -qm base
TAB_BASE="$(git -C "$TMP/tab-chromium" rev-parse HEAD)"

python3 - "$TMP/tab-chromium/chrome/browser/extensions/extension_tab_util.cc" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
text = text.replace(
    "    callback.Run(tab->GetContents());\n",
    "#if BUILDFLAG(IS_ANDROID)\n    if (tab->GetContents()) callback.Run(tab->GetContents());\n#else\n    callback.Run(tab->GetContents());\n#endif\n",
)
path.write_text(text)
PY
git -C "$TMP/tab-chromium" add .
git -C "$TMP/tab-chromium" commit -qm thorium-android-tab-nullability
THORIUM_TAB="$(git -C "$TMP/tab-chromium" rev-parse HEAD)"
git -C "$TMP/tab-chromium" reset --hard -q "$TAB_BASE"
python3 - "$TMP/tab-chromium/chrome/browser/extensions/extension_tab_util.cc" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text().replace(
    "  });\n}\n",
    "  });\n  domicile_desk::ForEachTab(callback);\n}\n",
)
path.write_text(text)
PY
git -C "$TMP/tab-chromium" add .
git -C "$TMP/tab-chromium" commit -qm domicile-tab-hook
DOMICILE_TAB="$(git -C "$TMP/tab-chromium" rev-parse HEAD)"
git -C "$TMP/tab-chromium" format-patch -1 --stdout > "$TMP/tab-series/0057-domicile-every-webview-is-a-tab-of-one-window-to-chrome-tabs.patch"
git -C "$TMP/tab-chromium" diff -U1 "$TAB_BASE" "$DOMICILE_TAB" -- chrome/browser/extensions/extension_tab_util.cc > "$TMP/tab-overrides/0057-domicile-every-webview-is-a-tab-of-one-window-to-chrome-tabs.patch"
git -C "$TMP/tab-chromium" reset --hard -q "$THORIUM_TAB"
git -C "$TMP/tab-chromium" reset --hard -q "$TAB_BASE"

python3 - "$TMP/tab-chromium/chrome/browser/extensions/extension_tab_util.cc" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text().replace(
    "    callback.Run(tab->GetContents());\n",
    "#if BUILDFLAG(IS_ANDROID)\n    if (tab->GetContents()) callback.Run(tab->GetContents());\n#else\n    callback.Run(tab->GetContents());\n#endif\n",
)
path.write_text(text)
PY
git -C "$TMP/tab-chromium" add .
git -C "$TMP/tab-chromium" commit -qm thorium-android-tab-nullability
git -C "$TMP/tab-chromium" reset --hard -q "$THORIUM_TAB"

if "$SCRIPT" --root "$TMP/tab-chromium" --series "$TMP/tab-series" --overrides "$TMP/tab-overrides" >"$TMP/tab.log" 2>&1; then
  :
else
  fail "Domicile tab hook did not apply around Thorium's Android tab handling: $(cat "$TMP/tab.log")"
fi
grep -q 'if (tab->GetContents()) callback.Run' "$TMP/tab-chromium/chrome/browser/extensions/extension_tab_util.cc" || fail "Thorium Android nullability handling was lost"
grep -q 'domicile_desk::ForEachTab(callback)' "$TMP/tab-chromium/chrome/browser/extensions/extension_tab_util.cc" || fail "Domicile webview enumeration was lost"

mkdir -p "$TMP/layout-series" "$TMP/layout-overrides" "$TMP/layout-chromium/chrome/browser/ui/views/frame/layout"
git -C "$TMP/layout-chromium" init -q
git -C "$TMP/layout-chromium" config user.email fixture@example.invalid
git -C "$TMP/layout-chromium" config user.name Fixture
cat > "$TMP/layout-chromium/chrome/browser/ui/views/frame/layout/browser_view_app_layout_impl.cc" <<'EOF'
  // Maybe lay out the titlebar.
  if (IsParentedTo(views().web_app_frame_toolbar, views().browser_view)) {
    CalculateTitlebarLayout(layout, params);
  }

  // Lay out the top container if it's in the browser (even if it's empty).
  // This is required for certain things like hit-testing.
  if (IsParentedTo(views().top_container, views().browser_view)) {
    auto& top_container_layout =
        layout.AddChild(views().top_container, gfx::Rect());
    const gfx::Rect top_container_local_bounds = CalculateTopContainerLayout(
        top_container_layout,
        params.InLocalCoordinates(params.visual_client_area),
        /*needs_exclusion=*/false);
    top_container_layout.bounds =
        GetTopContainerBoundsInParent(top_container_local_bounds, params);
    // In cases where the top container is nonzero size, need to move everything
    // else down.
    params.SetTop(std::max(params.visual_client_area.y(),
                           top_container_layout.bounds.bottom()));
  }

  // Lay out infobar container if present.
  if (IsParentedTo(views().infobar_container, views().browser_view)) {
    gfx::Rect infobar_bounds;
    const bool infobar_visible = delegate().IsInfobarVisible();
    if (infobar_visible) {
      infobar_bounds = gfx::Rect(
          params.visual_client_area.x(),
          // Infobar needs to get down out of the way of immersive mode elements
          // in some cases.
          params.visual_client_area.y() + delegate().GetExtraInfobarOffset(),
          params.visual_client_area.width(),
          // This returns zero for empty infobar.
          views().infobar_container->GetPreferredSize().height());
      params.SetTop(infobar_bounds.bottom());
    }
    layout.AddChild(views().infobar_container, infobar_bounds, infobar_visible);
  }

  // Lay out contents container.
  CHECK(IsParentedToAndVisible(views().multi_contents_view,
                               views().browser_view));
  gfx::Rect contents_bounds = params.visual_client_area;
  contents_bounds.set_height(std::max(contents_bounds.height(), 1));
  layout.AddChild(views().multi_contents_view, contents_bounds);

  return layout;
EOF
git -C "$TMP/layout-chromium" add .
git -C "$TMP/layout-chromium" commit -qm chromium-base
LAYOUT_BASE="$(git -C "$TMP/layout-chromium" rev-parse HEAD)"
git -C "$TMP/layout-chromium" apply "$ROOT/packages/domicile-engine/patches/0095-domicile-a-shell-window-lays-out-no-infobar.patch"
git -C "$TMP/layout-chromium" add .
git -C "$TMP/layout-chromium" commit -qm domicile-no-infobar
git -C "$TMP/layout-chromium" format-patch -1 --stdout > "$TMP/layout-series/0095-domicile-a-shell-window-lays-out-no-infobar.patch"
cp "$ROOT/scripts/thorium-poc/patches/0095-domicile-a-shell-window-lays-out-no-infobar.patch" "$TMP/layout-overrides/0095-domicile-a-shell-window-lays-out-no-infobar.patch"
grep -q '^From ' "$TMP/layout-overrides/0095-domicile-a-shell-window-lays-out-no-infobar.patch" || fail "layout override is not a git-am patch"
git -C "$TMP/layout-chromium" reset --hard -q "$LAYOUT_BASE"
python3 - "$TMP/layout-chromium/chrome/browser/ui/views/frame/layout/browser_view_app_layout_impl.cc" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text().replace(
    "  // Lay out contents container.\n",
    "  params.visual_client_area =\n      LayoutDownloadShelf(layout, params.visual_client_area);\n\n"
    "  // Lay out contents container.\n",
)
path.write_text(text)
PY

if "$SCRIPT" --root "$TMP/layout-chromium" --series "$TMP/layout-series" --overrides "$TMP/layout-overrides" >"$TMP/layout.log" 2>&1; then
  :
else
  fail "Domicile no-infobar change did not compose with Thorium's download shelf: $(cat "$TMP/layout.log")"
fi
grep -q 'layout.AddChild(views().infobar_container, gfx::Rect(), false);' "$TMP/layout-chromium/chrome/browser/ui/views/frame/layout/browser_view_app_layout_impl.cc" || fail "Domicile infobar remained visible in app layout"
grep -q 'LayoutDownloadShelf(layout, params.visual_client_area)' "$TMP/layout-chromium/chrome/browser/ui/views/frame/layout/browser_view_app_layout_impl.cc" || fail "Thorium download shelf layout was lost"

echo "Domicile port application tests passed"

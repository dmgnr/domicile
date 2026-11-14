#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
THORIUM_PIN="4c5c218dafd811108b461e73d94e4dab8929ad97"
CHROMIUM_PIN="fb096c0011f9d50f0a264a9376420cdea9c421e3"
THORIUM_URL="https://github.com/Alex313031/thorium.git"
CHROMIUM_URL="https://github.com/chromium/chromium.git"
FIXTURE=false
THORIUM_ROOT=""
CHROMIUM_SRC=""
DOMICILE_PATCHES="$ROOT/scripts/thorium-poc/patches"
CHILD_MANIFEST="$ROOT/scripts/thorium-poc/chromium-156-children.tsv"
PIN=""
REQUIRED_CHILDREN=()
REQUIRED_GRD=()

while (($# > 0)); do
  case "$1" in
    --fixture) FIXTURE=true; shift ;;
    --thorium-root) THORIUM_ROOT="$2"; shift 2 ;;
    --chromium-src) CHROMIUM_SRC="$2"; shift 2 ;;
    --domicile-patches) DOMICILE_PATCHES="$2"; shift 2 ;;
    --child-manifest) CHILD_MANIFEST="$2"; shift 2 ;;
    --pin) PIN="$2"; shift 2 ;;
    --require-child) REQUIRED_CHILDREN+=("$2"); shift 2 ;;
    --require-grd) REQUIRED_GRD+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FIXTURE" != true ]]; then
  WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/domicile-thorium-integration.XXXXXX")"
  THORIUM_ROOT="$WORK/thorium"
  CHROMIUM_SRC="$WORK/chromium"
  git clone --depth 1 --filter=blob:none --no-checkout "$THORIUM_URL" "$THORIUM_ROOT"
  git -C "$THORIUM_ROOT" fetch --depth 1 origin "$THORIUM_PIN"
  git -C "$THORIUM_ROOT" checkout --detach FETCH_HEAD
  actual_thorium="$(git -C "$THORIUM_ROOT" rev-parse HEAD)"
  [[ "$actual_thorium" == "$THORIUM_PIN" ]] || { echo "Thorium pin verification failed: $actual_thorium" >&2; exit 1; }
  git clone --depth 1 --filter=blob:none --no-checkout "$CHROMIUM_URL" "$CHROMIUM_SRC"
  git -C "$CHROMIUM_SRC" fetch --depth 1 origin "$CHROMIUM_PIN"
  git -C "$CHROMIUM_SRC" checkout --detach FETCH_HEAD
  actual_chromium="$(git -C "$CHROMIUM_SRC" rev-parse HEAD)"
  [[ "$actual_chromium" == "$CHROMIUM_PIN" ]] || { echo "Chromium pin verification failed: $actual_chromium" >&2; exit 1; }
  PIN="$THORIUM_PIN"
fi

[[ -n "$THORIUM_ROOT" && -n "$CHROMIUM_SRC" && -n "$PIN" ]] || { echo "source roots and verified pin are required" >&2; exit 2; }
actual="$(git -C "$THORIUM_ROOT" rev-parse HEAD 2>/dev/null || true)"
[[ "$actual" == "$PIN" ]] || { echo "pin verification failed: found $actual, expected $PIN" >&2; exit 1; }
git -C "$CHROMIUM_SRC" rev-parse --git-dir >/dev/null 2>&1 || { echo "Chromium source is not a Git checkout" >&2; exit 1; }
SERIES="$THORIUM_ROOT/patch_scripts/series/series"
[[ -f "$SERIES" ]] || { echo "Thorium ordered patch series is missing: $SERIES" >&2; exit 1; }
for child in "${REQUIRED_CHILDREN[@]}"; do
  [[ -d "$child/.git" || -f "$child/.git" ]] || { echo "required child repository is missing: $child" >&2; exit 1; }
done
for grd in "${REQUIRED_GRD[@]}"; do
  [[ -d "$grd" ]] || { echo "required GRD stage inputs are missing: $grd" >&2; exit 1; }
done
for component in chrome components content third_party ui; do
  [[ -d "$THORIUM_ROOT/src/$component" ]] || { echo "required Thorium overlay is missing: src/$component" >&2; exit 1; }
done
for component in chrome components content third_party ui; do
  cp -a "$THORIUM_ROOT/src/$component/." "$CHROMIUM_SRC/$component/"
done
if [[ "$FIXTURE" != true ]]; then
  "$ROOT/scripts/thorium-poc/fetch-child-sources.sh" --root "$CHROMIUM_SRC" --manifest "$CHILD_MANIFEST"
fi

apply_fixture_series() {
  local series_file="$1" thorium_root="$2"
  local line patch apply_root label condition
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(xargs <<<"$line")"
    [[ -z "$line" ]] && continue
    if [[ "$line" == \[*\]* ]]; then
      condition="${line%%]*}"
      condition="${condition#\[}"
      line="$(xargs <<<"${line#*]}")"
      case "$condition" in
        sse2|raspi|mac|android|woa|cros) continue ;;
        *) echo "unsupported Thorium series condition: [$condition]" >&2; exit 1 ;;
      esac
    fi
    apply_root="."
    patch="$line"
    if [[ "$line" == *:* && "$line" != other/* ]]; then
      apply_root="${line%%:*}"
      patch="${line#*:}"
      apply_root="$(xargs <<<"$apply_root")"
      patch="$(xargs <<<"$patch")"
    fi
    label="$apply_root: $patch"
    [[ -f "$thorium_root/$patch" ]] || { echo "series patch is missing: $label" >&2; exit 1; }
    [[ -d "$CHROMIUM_SRC/$apply_root" ]] || { echo "required child repository is missing for $label ($CHROMIUM_SRC/$apply_root)" >&2; exit 1; }
    git -C "$CHROMIUM_SRC/$apply_root" rev-parse --git-dir >/dev/null 2>&1 || { echo "required apply root is not a Git checkout for $label" >&2; exit 1; }
    git -C "$CHROMIUM_SRC/$apply_root" apply --3way "$thorium_root/$patch" || { echo "Thorium patch failed: $label" >&2; exit 1; }
    echo "Applied Thorium $label"
  done < "$series_file"
}

if [[ "$FIXTURE" == true ]]; then
  apply_fixture_series "$SERIES" "$THORIUM_ROOT"
else
  python3 "$THORIUM_ROOT/patch_scripts/series/apply_series.py" \
    --thorium-root "$THORIUM_ROOT" --source-tree "$CHROMIUM_SRC" --apply
fi
shopt -s nullglob
domicile=()
for patch in "$DOMICILE_PATCHES"/*.patch; do domicile+=("$patch"); done
((${#domicile[@]} > 0)) || { echo "Domicile port patch series is empty" >&2; exit 1; }
for patch in "${domicile[@]}"; do
  git -C "$CHROMIUM_SRC" apply --3way "$patch" || { echo "Domicile/Thorium overlap needs an explicit port: $(basename "$patch")" >&2; exit 1; }
  echo "Applied Domicile $(basename "$patch") after Thorium"
done
if [[ "$FIXTURE" == true ]]; then
  [[ ${#REQUIRED_GRD[@]} -eq 0 ]] || { echo "required GRD stage inputs are missing: ${REQUIRED_GRD[*]}" >&2; exit 1; }
else
  GRD="$THORIUM_ROOT/patch_scripts/grd_rebase"
  for input in sync_grd_strings.py merge_thorium_xtb.py config/file_allowlist.csv config/message_allowlist.csv config/feature_patch_message_ownership.csv; do
    [[ -f "$GRD/$input" ]] || { echo "required GRD stage input is missing: $GRD/$input" >&2; exit 1; }
  done
  python3 "$GRD/sync_grd_strings.py" "$CHROMIUM_SRC" \
    --file-allowlist "$GRD/config/file_allowlist.csv" \
    --message-allowlist "$GRD/config/message_allowlist.csv" \
    --feature-message-ownership "$GRD/config/feature_patch_message_ownership.csv"
  python3 "$GRD/merge_thorium_xtb.py" "$CHROMIUM_SRC"
  echo "Applied Thorium GRD/XTB rebase"
fi
if [[ "$FIXTURE" == true ]]; then
  echo "PASS: Thorium fixture overlay and ordered patch application completed."
  echo "fixture mode: GRD/XTB stage not executed"
else
  echo "PASS: Thorium overlays, ordered patches, Domicile patches, and GRD/XTB completed."
fi

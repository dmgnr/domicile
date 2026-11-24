#!/usr/bin/env bash
# Tests that `packages/distro/nix/home-manager.nix` declares the same config fields that
# `packages/domicile-config/src/` parses.
#
# Drift in each direction costs differently:
#
# - A field Rust parses but the module lacks still passes through the freeform
#   `settings`, but without docs, types or the module's default.
# - A field the module writes but Rust lacks breaks the whole file: every
#   config struct is `deny_unknown_fields`, so domicile rejects the config and
#   starts on defaults.
#
# Needs no Nix, like the cursor shape and display transform checks, so it runs
# where `nix` is unavailable. It compares names only; `nix flake check` catches
# type changes.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODULE="$ROOT/packages/distro/nix/home-manager.nix"
LIB="$ROOT/packages/domicile-config/src/lib.rs"
PROFILE="$ROOT/packages/domicile-config/src/profile.rs"
POINTERS="$ROOT/packages/domicile-config/src/pointers.rs"
INPUT_DEVICES="$ROOT/packages/domicile-config/src/input_devices.rs"

for f in "$MODULE" "$LIB" "$PROFILE" "$POINTERS" "$INPUT_DEVICES"; do
  [ -f "$f" ] || { echo "no $f" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The `pub` fields of one `#[serde]` struct, which are the keys it accepts.
# Sorted, because order does not matter here.
rust_fields() { # file, struct name
  awk -v want="pub struct $2 {" '
    index($0, want) { inside = 1; next }
    inside && /^\}/ { exit }
    inside && match($0, /^    pub [a-z_]+:/) {
      field = substr($0, RSTART + 8, RLENGTH - 9)
      print field
    }' "$1" | sort
}

# The options declared directly inside one block of the module.
#
# The block starts at the line matching the pattern and ends at the first line
# that closes back to its indent, so `input.keyboard` does not run into
# `output`. `indent` is the depth of the block's options: one level for a plain
# attrset, two for a submodule's `options = {`. Deeper options belong to a
# nested submodule.
nix_options() { # opening line pattern, indent of the options
  awk -v open="$1" -v ind="$2" '
    !inside && $0 ~ open {
      inside = 1
      match($0, /^ */)
      close_at = "^" substr($0, 1, RLENGTH) "\\};?$"
      next
    }
    inside && $0 ~ close_at { exit }
    inside && match($0, "^" ind "[a-z_]+ =") {
      print substr($0, RSTART + length(ind), RLENGTH - length(ind) - 2)
    }' "$MODULE" | sort -u
}

FAILED=0

compare() { # what, rust file, rust struct, nix open pattern, nix indent
  rust_fields "$2" "$3" >"$WORK/rust"
  nix_options "$4" "$5" >"$WORK/nix"

  # A pattern that stops matching gives an empty set, and two empty sets
  # compare equal. So both sides must be non-empty.
  for side in rust nix; do
    n="$(wc -l <"$WORK/$side" | tr -d ' ')"
    if [ "$n" -lt 1 ]; then
      printf '  FAIL  %s: read no fields from the %s side, so its pattern no longer matches\n' \
        "$1" "$side"
      FAILED=$((FAILED + 1))
      return
    fi
  done

  missing="$(comm -23 "$WORK/rust" "$WORK/nix" | tr '\n' ' ')"
  extra="$(comm -13 "$WORK/rust" "$WORK/nix" | tr '\n' ' ')"

  if [ -z "$missing" ] && [ -z "$extra" ]; then
    printf '  ok    %s (%s fields)\n' "$1" "$(wc -l <"$WORK/rust" | tr -d ' ')"
    return
  fi

  printf '  FAIL  %s\n' "$1"
  [ -z "$missing" ] || printf '    domicile parses these and the module does not declare them: %s\n' "$missing"
  [ -z "$extra" ] || {
    printf '    THE MODULE WOULD WRITE THESE AND DOMICILE REFUSES THE FILE OVER ANY OF THEM: %s\n' "$extra"
    printf '      (every config struct is `deny_unknown_fields`, so this is the whole desk,\n'
    printf '       not one setting -- see this file`s header)\n'
  }
  FAILED=$((FAILED + 1))
}

# `input.keyboard` and `output` are plain attrsets, so their options are one
# level in. The submodules in the `let` hold theirs in an
# `options = {`, one level deeper.
compare "extensions" "$LIB" ExtensionsConfig '^          extensions = [{]$' '            '
compare "idle" "$LIB" IdleConfig '^          idle = [{]$' '            '
compare "lock" "$LIB" LockConfig '^          lock = [{]$' '            '
compare "spellcheck" "$LIB" SpellcheckConfig '^          spellcheck = [{]$' '            '
compare "lockdown" "$LIB" LockdownConfig '^          lockdown = [{]$' '            '
compare "input.keyboard" "$LIB" KeyboardConfig '^          input[.]keyboard = [{]$' '            '
compare "input.keyboard.repeat" "$LIB" KeyRepeat '^            repeat = [{]$' '              '
compare "input.keyboard.keymaps[]" "$LIB" Keymap '^  keymap = lib[.]types[.]submodule [{]$' '      '
compare "input.touchpad" "$INPUT_DEVICES" TouchpadConfig '^          input[.]touchpad = [{]$' '            '
compare "input.mouse" "$INPUT_DEVICES" MouseConfig '^          input[.]mouse = [{]$' '            '
compare "input.pointers[]" "$POINTERS" PointerConfig '^  pointer = lib[.]types[.]submodule [{]$' '      '
compare "output" "$LIB" OutputConfig '^          output = [{]$' '            '
compare "output.displays[]" "$LIB" DisplayConfig '^  display = lib[.]types[.]submodule [{]$' '      '
compare "output.profiles[]" "$PROFILE" Profile '^  profile = lib[.]types[.]submodule [{]$' '      '
compare "output.profiles[].displays[]" "$PROFILE" DisplayPlacement '^  placement = lib[.]types[.]submodule [{]$' '      '

# The schema has no `compositor` section. A module that declares one would
# write a section `Config` rejects, failing every desk at startup.
if grep -q '^          compositor[.]' "$MODULE"; then
  printf '  FAIL  compositor: the module declares a section the schema dropped\n'
  FAILED=$((FAILED + 1))
else
  printf '  ok    compositor (dropped from both)\n'
fi

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"

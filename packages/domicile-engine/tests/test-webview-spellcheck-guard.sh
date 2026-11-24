#!/usr/bin/env bash
# Tests the verdict of `guard-webview-spellcheck.sh`: which readings pass and
# which component a failure blames.
#
# The checks are ordered: a suggestion only means something once a word was
# misspelled. Key cases:
#
#   - A missing dictionary blames the build's copy or patch 0246.
#   - A menu with no word blames the profile or AsWebViewContextMenu.
#   - A word left unreplaced blames ReplaceMisspelling.
#   - A word still misspelled after adding it blames AddToDictionary.
#   - In the control, a misspelled word in the menu fails.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-spellcheck.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

# From `FAILURE=""` to the column-zero `fi` that ends the decision.
BLOCK="$(awk '/^FAILURE=""$/,/^fi$/' "$GUARD")"
[ -n "$BLOCK" ] || {
  echo "no verdict block in $GUARD — its markers moved. Fix this test with it." >&2
  exit 1
}

FAILED=0
expect() {
  local what="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$what" "$want" "$got"
    FAILED=$((FAILED + 1))
  fi
}

# Runs the block with every reading at its passing value; each case overrides
# one. Prints "pass", "fail" or "neither", then the failure on the next line.
judge() { # $1 NEGATIVE, then NAME=value overrides
  (
    SAW_SHELL=1
    SAW_PAGE=1
    SAW_MISSING=0
    SAW_FIRST=1
    SAW_FIRST_WORD=1
    SAW_SUGGESTED=1
    SAW_REPLACED=1
    SAW_SECOND_WORD=1
    SAW_ADDED=1
    NEGATIVE="$1"
    shift
    for override in "$@"; do
      eval "$override"
    done
    eval "$BLOCK"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
    echo "$FAILURE"
  )
}

verdict() { judge "$@" | head -1; }

blames() { # $1 word, then the args judge takes
  local word="$1"
  shift
  case "$(judge "$@" | tail -n +2)" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

# The control's field is not checked, so its menu carries no word.
control() {
  verdict 1 SAW_FIRST_WORD=0 SAW_SUGGESTED=0 SAW_REPLACED=0 \
    SAW_SECOND_WORD=0 SAW_ADDED=0 "$@"
}

echo "a run that never got as far as checking anything"
expect "a shell that never ran is a failure" "fail" "$(verdict 0 SAW_SHELL=0)"
expect "a shell that never ran blames the harness" "yes" \
  "$(blames "harness" 0 SAW_SHELL=0)"
expect "an empty window names the guest" "yes" \
  "$(blames "the guest" 0 SAW_PAGE=0)"
expect "no menu at all is the control's failure too" "fail" \
  "$(control SAW_FIRST=0)"

echo
echo "the positive run"
expect "suggested, replaced and added is the pass" "pass" "$(verdict 0)"
expect "a missing dictionary blames the build's copy" "yes" \
  "$(blames "domicile_dictionaries" 0 SAW_MISSING=1)"
expect "a menu with no word blames the menu or the profile" "yes" \
  "$(blames "AsWebViewContextMenu" 0 SAW_FIRST_WORD=0)"
expect "a word with no suggestion blames spellingSuggestions" "yes" \
  "$(blames "spellingSuggestions" 0 SAW_SUGGESTED=0)"
expect "a word left as it was blames ReplaceMisspelling" "yes" \
  "$(blames "ReplaceMisspelling" 0 SAW_REPLACED=0)"
expect "a second word not handed over is a failure" "fail" \
  "$(verdict 0 SAW_SECOND_WORD=0)"
expect "a word still misspelled after adding it blames AddToDictionary" "yes" \
  "$(blames "AddToDictionary" 0 SAW_ADDED=0)"

echo
echo "the control run — a field that is not checked"
expect "a menu with no word is the pass" "pass" "$(control)"
expect "a misspelled word in the menu is the control's failure" "fail" \
  "$(control SAW_FIRST_WORD=1)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the spellcheck guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1

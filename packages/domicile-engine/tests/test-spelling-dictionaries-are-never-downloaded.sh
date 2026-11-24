#!/usr/bin/env bash
# Whether the engine checks spelling with the dictionaries beside it, and never
# downloads one.
#
# See patch 0246. Chrome fetches a missing Hunspell dictionary from Google into
# the profile. The engine's ship in `dictionaries/` beside it, and a missing
# one is logged instead.
#
# Reads the series rather than a build, so it runs on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

# The lines the series adds to, or removes from, one file.
changed_in() { # sign (+ or -), file
  awk -v sign="$1" -v want="$2" '
    FNR == 1 { in_file = 0 }
    /^diff --git a\// { in_file = (index($0, want) > 0); next }
    !in_file { next }
    /^(\+\+\+|---) / { next }
    substr($0, 1, 1) == sign { print substr($0, 2) }
  ' "$PATCHES"/*.patch
}

paths="$(changed_in + chrome/common/chrome_paths.cc)"
loaded="$(changed_in + chrome/browser/spellchecker/spellcheck_hunspell_dictionary.cc)"
dropped="$(changed_in - chrome/browser/spellchecker/spellcheck_hunspell_dictionary.cc)"

fails=0
want() { # what, text, line
  if grep -qF -- "$3" <<<"$2"; then return; fi
  echo "    missing ($1): $3"
  fails=$((fails + 1))
}

want "the folder beside the engine" "$paths" 'base::PathService::Get(base::DIR_MODULE, &cur)'
want "the folder beside the engine" "$paths" 'cur = cur.Append(FILE_PATH_LITERAL("dictionaries"));'
want "no download" "$dropped" 'DownloadDictionary(GetDictionaryURL());'
want "a missing dictionary is logged" "$loaded" '"domicile: the engine has no spelling dictionary for "'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the changes that keep spelling dictionaries local are missing"
  exit 1
fi
echo "ok: spelling dictionaries ship beside the engine and are never downloaded"

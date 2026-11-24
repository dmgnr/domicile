#!/usr/bin/env bash
# Tests that a config field `domicile-config` stops parsing, at any depth, is
# listed in `removedSettings` in `packages/distro/nix/home-manager.nix`, or has an
# ancestor that is.
#
# Every config struct is `deny_unknown_fields`, so dropping a field makes every
# config that still sets it a desk that will not start. `removedSettings` turns
# that into a home-manager assertion that says where the setting went.
#
# Fields are named by dotted path from `Config`, with `[]` for a list's
# elements and `*` for a map's values: `output.profiles[].displays[].mode`,
# `extensions.settings.*.private`, as `removedSettings` names them. A field's lone `#[serde(rename = "...")]` names its path. In a struct
# reached from `Config`, anything it cannot read fails rather than hiding the
# fields below it: any other `#[serde(...)]` that renames, flattens or skips, a field that is not `pub`, a type over several lines, a type it cannot
# name (`Box<T>`, `crate::T`).
#
# Compares against the base: `DOMICILE_PR_BASE_SHA` on a pull request
# (`e2e.yml` sets it), else the merge base with `origin/main`, else `HEAD^`.
# Exits 77 when the base cannot be fetched.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODULE="$ROOT/packages/distro/nix/home-manager.nix"
SRC=packages/domicile-config/src
cd "$ROOT"

# Whether `git` has the commit `$1`.
have() { git cat-file -e "$1^{commit}" 2>/dev/null; }

base() {
  if [ -n "${DOMICILE_PR_BASE_SHA:-}" ]; then
    have "$DOMICILE_PR_BASE_SHA" || git fetch -q --depth=1 origin "$DOMICILE_PR_BASE_SHA" 2>/dev/null
    echo "$DOMICILE_PR_BASE_SHA"
    return
  fi
  local merge_base
  merge_base="$(git merge-base HEAD origin/main 2>/dev/null)"
  if [ -n "$merge_base" ] && [ "$merge_base" != "$(git rev-parse HEAD)" ]; then
    echo "$merge_base"
    return
  fi
  have HEAD^ || git fetch -q --depth=2 origin "$(git rev-parse HEAD)" 2>/dev/null
  git rev-parse -q --verify HEAD^ 2>/dev/null
}

BASE="$(base)"
if [ -z "$BASE" ] || ! have "$BASE"; then
  echo "SKIP: no base commit to compare $SRC against"
  exit 77
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The Rust read from stdin, as tab-separated records:
#
# - `S name`: a `pub struct name {`, whose fields follow.
# - `L name`: a `pub enum`, a tuple or unit `pub struct`, or one deserialized
#   from a `String` or `Vec<String>` through `#[serde(try_from = ...)]` or
#   `from`, read as one value.
# - `U name why`: a `pub struct` this check cannot read: generic, deserialized
#   from another type, or under a struct-level `#[serde(...)]` over several
#   lines.
# - `F struct field type`: a `pub` field of an `S`.
# - `! struct what`: something in an `S` this check cannot read: a
#   `#[serde(...)]` other than a lone rename that renames, flattens or skips, a field that is not `pub`,
#   a type over several lines.
fields() {
  awk '
    function refuse(what) { print "!\t" name "\t" what }
    inattr { if (/\]$/) { inattr = 0 }; next }
    /^#\[serde\(/ && !/\]$/ { pending = "a #[serde(...)] over several lines"; inattr = 1; next }
    /^#\[serde\(.*from = / { whole = $0; next }
    /^#\[serde\(/ && /rename|alias|untagged|tag|flatten|transparent/ { pending = $0; next }
    match($0, /^pub struct [A-Za-z0-9_]+ \{/) {
      split($0, words, " ")
      if (whole ~ /from = "(String|Vec<String>)"/) { print "L\t" words[3] }
      else if (whole != "") { print "U\t" words[3] "\t" whole }
      else if (pending != "") { print "U\t" words[3] "\t" pending }
      else { name = words[3]; print "S\t" name; attr = "" }
      pending = ""; whole = ""
      next
    }
    match($0, /^pub struct [A-Za-z0-9_]+</) {
      split($0, words, /[ <]/); print "U\t" words[3] "\tgeneric"; pending = ""; whole = ""; next
    }
    match($0, /^pub (struct|enum) [A-Za-z0-9_]+/) {
      split($0, words, /[ <({;]/); print "L\t" words[3]; pending = ""; whole = ""; next
    }
    /^[^#\/ ]/ { pending = ""; whole = "" }
    name == "" { next }
    /^\}/ { name = ""; next }
    /^[ \t]*$/ || /^[ \t]*\/\// { next }
    /^    #\[serde\(rename = "[^"]*"\)\]$/ {
      renamed = $0; sub(/^[^"]*"/, "", renamed); sub(/".*$/, "", renamed); next
    }
    /^    #\[.*\]$/ { if (/rename|alias|flatten|skip/) { attr = $0 }; next }
    match($0, /^    pub [a-z0-9_]+: /) {
      field = substr($0, RSTART + 8, RLENGTH - 10)
      type = substr($0, RSTART + RLENGTH)
      sub(/[ \t]*\/\/.*$/, "", type)
      if (type !~ /,$/) { refuse($0) }
      else if (attr != "") { refuse(attr " on " field) }
      else {
        sub(/,$/, "", type)
        print "F\t" name "\t" (renamed != "" ? renamed : field) "\t" type
      }
      attr = ""; renamed = ""
      next
    }
    { refuse($0) }
  '
}

# The dotted path of every field under struct `$2`, from the records in `$1`,
# below the path `$3`. `$4` holds the structs above, to catch one that holds
# itself. What it cannot read goes to `$WORK/unreadable`.
paths() { # records file, struct, prefix, structs above
  local field type inner path
  awk -F'\t' -v s="$2" '$1 == "!" && $2 == s { print "  " s ": " $3 }' "$1" >>"$WORK/unreadable"
  while IFS=$'\t' read -r field type; do
    path="${3:+$3.}$field"
    echo "$path"
    inner="$type"
    while :; do
      case "$inner" in
        Option\<*\>) inner="${inner#Option<}"; inner="${inner%>}" ;;
        Vec\<*\>) inner="${inner#Vec<}"; inner="${inner%>}"; path="$path[]" ;;
        BTreeMap\<String,\ *\>) inner="${inner#BTreeMap<String, }"; inner="${inner%>}"; path="$path.*" ;;
        *) break ;;
      esac
    done
    case "$(awk -F'\t' -v s="$inner" '($1 == "S" || $1 == "L" || $1 == "U") && $2 == s { print $1 }' "$1" | sort -u | tr -d '\n')" in
      S)
        case " $4 " in
          *" $inner "*) echo "  $path: $inner holds itself" >>"$WORK/unreadable" ;;
          *) paths "$1" "$inner" "$path" "$4 $2" ;;
        esac
        ;;
      L) ;;
      U) awk -F'\t' -v s="$inner" -v p="$path" '$1 == "U" && $2 == s { print "  " p ": " s " is " $3 }' "$1" >>"$WORK/unreadable" ;;
      ?*) echo "  $path: $inner is defined more than once" >>"$WORK/unreadable" ;;
      *)
        case "$inner" in
          \(*[A-Z]*\)) echo "  $path: type $inner holds a type this check does not walk" >>"$WORK/unreadable" ;;
          String | PathBuf | bool | [iuf][0-9]* | usize | isize | \(*\)) ;;
          # Opaque JSON: its keys are not `domicile-config`'s to remove.
          serde_json::Map\<*\> | serde_json::Value) ;;
          *) echo "  $path: type $inner is not one this check can read" >>"$WORK/unreadable" ;;
        esac
        ;;
    esac
  done < <(awk -F'\t' -v s="$2" '$1 == "F" && $2 == s { print $3 "\t" $4 }' "$1")
}

FAILED=0

for side in base head; do
  if [ "$side" = base ]; then
    git ls-tree --name-only "$BASE" "$SRC/" | grep '\.rs$' | while read -r file; do git show "$BASE:$file"; done
  else
    cat "$SRC"/*.rs
  fi | fields >"$WORK/$side.records"
  : >"$WORK/unreadable"
  paths "$WORK/$side.records" Config "" "" | sort -u >"$WORK/$side"
  if [ -s "$WORK/unreadable" ]; then
    printf '  FAIL  on the %s side, this check cannot read:\n' "$side"
    sort -u "$WORK/unreadable"
    FAILED=1
  fi
done

# The paths in the module's `removedSettings = { ... };`. A dotted path must be
# quoted: Nix reads a bare `a.b =` as a nested attrset.
awk '
  /^  removedSettings = \{$/ { inside = 1; next }
  inside && /^  \};$/ { exit }
  note { if (/'"''"';$/) { note = 0 }; next }
  inside && match($0, /^    ("[a-z0-9_.*\[\]]+"|[a-z0-9_]+) =/) {
    path = substr($0, RSTART + 4, RLENGTH - 6)
    gsub(/"/, "", path)
    print path
    if (/= '"''"'$/) { note = 1 }
    next
  }
  inside && /^    [^ ]/ { print "!" $0 }
' "$MODULE" | sort -u >"$WORK/removed"
bare="$(sed -n 's/^!//p' "$WORK/removed")"
if [ -n "$bare" ]; then
  printf '  FAIL  cannot read these removedSettings keys; quote a dotted path, which Nix otherwise reads as nested sets:\n%s\n' "$bare"
  FAILED=1
fi
grep -v '^!' "$WORK/removed" >"$WORK/removed.paths"
mv "$WORK/removed.paths" "$WORK/removed"

for side in base head removed; do
  [ -s "$WORK/$side" ] || {
    printf '  FAIL  read nothing from the %s side, so its pattern no longer matches\n' "$side"
    FAILED=1
  }
done

# Whether `$1` or one of its ancestors is listed. `output.profiles[].name`'s
# ancestors are `output.profiles` and `output`.
listed() {
  local path="$1"
  while :; do
    grep -qxF "$path" "$WORK/removed" && return 0
    case "$path" in
      *.*) path="${path%.*}"; path="${path%\[\]}" ;;
      *) return 1 ;;
    esac
  done
}

unlisted=""
while read -r path; do
  listed "$path" || unlisted="$unlisted$path "
done < <(comm -23 "$WORK/base" "$WORK/head")
if [ -n "$unlisted" ]; then
  printf '  FAIL  domicile-config no longer parses these, and removedSettings lists neither them nor an ancestor: %s\n' "$unlisted"
  printf '        a config that sets one stops the desk; list it with where it went\n'
  FAILED=1
fi

# A path in a list's elements or a map's values needs its submodule to declare
# it, with `removed.optionsUnder "<the path up to its last [] or *>"`.
unwired=""
while read -r path; do
  case "$path" in
    *"[]"* | *".*."*)
      case "$path" in
        *".*."*) prefix="${path%".*."*}.*" ;;
        *) prefix="${path%"[]"*}[]" ;;
      esac
      awk -v want="options = lib.recursiveUpdate (removed.optionsUnder \"$prefix\")" \
        '{ sub(/^ +/, "") } index($0, want) == 1 { found = 1 } END { exit !found }' "$MODULE" \
        || unwired="$unwired$prefix "
      ;;
  esac
done <"$WORK/removed"
if [ -n "$unwired" ]; then
  printf '  FAIL  removedSettings has paths in these lists, and no submodule calls removed.optionsUnder for them: %s\n' "$unwired"
  FAILED=1
fi

parsed="$(comm -12 "$WORK/head" "$WORK/removed" | tr '\n' ' ')"
if [ -n "$parsed" ]; then
  printf '  FAIL  removedSettings lists these, and domicile-config still parses them: %s\n' "$parsed"
  FAILED=1
fi

[ "$FAILED" -eq 0 ] || exit 1
echo "ok: $(wc -l <"$WORK/head" | tr -d ' ') fields at $(git rev-parse --short "$BASE") and here, $(wc -l <"$WORK/removed" | tr -d ' ') removed"

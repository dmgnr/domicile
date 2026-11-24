#!/usr/bin/env bash
# Checks that the SDK's `config.schema.json` is what `domicile-config`'s Rust
# types derive, and `src/config.ts` and `src/config-schema.ts` are what that
# schema generates.
#
# Both files are generated and checked in, so a config change that is not
# regenerated leaves editors and TypeScript configs checked against a config
# the compositor no longer reads. Fix with `bun run generate` in
# `packages/chrome-sdk`.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SDK="$ROOT/packages/chrome-sdk"
for f in "$SDK/config.schema.json" "$SDK/src/config.ts" "$SDK/src/config-schema.ts"; do
  [ -f "$f" ] || { echo "no $f" >&2; exit 1; }
done
for tool in cargo bun; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "SKIP: no $tool to run the generator with"
    exit 77
  }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! bun "$SDK/codegen/generate-config.ts" "$WORK/config.schema.json" "$WORK/config.ts" "$WORK/config-schema.ts"; then
  echo "  FAIL  the generator runs"
  exit 1
fi

FAILED=0
compare() { # what, checked-in file, generated file
  if diff -u "$2" "$3"; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n' "$1"
    FAILED=$((FAILED + 1))
  fi
}
compare "config.schema.json is what domicile-config derives" \
  "$SDK/config.schema.json" "$WORK/config.schema.json"
compare "src/config.ts is what the schema generates" \
  "$SDK/src/config.ts" "$WORK/config.ts"
compare "src/config-schema.ts is what the schema generates" \
  "$SDK/src/config-schema.ts" "$WORK/config-schema.ts"

if [ "$FAILED" -gt 0 ]; then
  echo "    run \`bun run generate\` in packages/chrome-sdk"
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"

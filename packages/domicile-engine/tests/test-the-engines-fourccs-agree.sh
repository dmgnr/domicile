#!/usr/bin/env bash
# Tests that the compositor advertises the pixel formats the engine imports.
#
# `FormatFromFourcc` in the fork's brokered_frame_sink.cc refuses any other
# fourcc. `FOURCCS` in the compositor's engine.rs is what `zwp_linux_dmabuf_v1`
# offers clients. A format only the compositor lists gets every frame refused.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine/src/components/domicile/browser/brokered_frame_sink.cc"
COMPOSITOR="$ROOT/packages/domicile-compositor/src/engine.rs"

for file in "$ENGINE" "$COMPOSITOR"; do
  if [ ! -f "$file" ]; then
    echo "FAIL: no $file — one of the two lists has moved" >&2
    exit 1
  fi
done

# The case labels of FormatFromFourcc, and the entries of FOURCCS.
engine=$(sed -n '/FormatFromFourcc(uint32_t fourcc)/,/^}/p' "$ENGINE" |
  grep -o 'case 0x[0-9a-fA-F]*' | sed 's/case 0x//' | tr 'A-F' 'a-f' | sort)
compositor=$(sed -n '/pub const FOURCCS/,/\];/p' "$COMPOSITOR" |
  grep -o '0x[0-9a-fA-F_]*' | sed 's/0x//; s/_//g' | tr 'A-F' 'a-f' | sort)

# An empty parse would agree with itself.
if [ -z "$engine" ] || [ -z "$compositor" ]; then
  echo "FAIL: read no fourccs (engine: '$engine', compositor: '$compositor')" >&2
  exit 1
fi

if [ "$engine" != "$compositor" ]; then
  echo "FAIL: the engine imports and the compositor advertises different fourccs" >&2
  diff <(echo "$engine") <(echo "$compositor") | sed 's/^/  /' >&2
  exit 1
fi
echo "ok: the compositor advertises the $(echo "$engine" | wc -l) fourccs the engine imports"

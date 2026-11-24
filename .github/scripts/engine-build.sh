#!/usr/bin/env bash
# Build the engine, from inside Chromium's shell.
#
#   NIX_SHELL_RUN=".../engine-build.sh /build/chromium/src /tmp/ran" \
#     nix-shell /build/chromium/src/tools/nix/shell.nix
#
# A script rather than an inline command, because NIX_SHELL_RUN re-quotes its
# contents through three shells.
set -euo pipefail

CHROMIUM="${1:?usage: engine-build.sh <chromium/src> <sentinel>}"
SENTINEL="${2:?usage: engine-build.sh <chromium/src> <sentinel>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# `gn` and `autoninja` come from depot_tools; engine-depot-tools.sh picks which.
TOOLS="$("$HERE/engine-depot-tools.sh" "$CHROMIUM")" || exit 127
echo "depot_tools: $TOOLS"
export PATH="$TOOLS:$PATH"

# The cache is shared, so its totals would mix every build that ever ran.
if [ -n "${DOMICILE_CC_WRAPPER:-}" ]; then
  "$DOMICILE_CC_WRAPPER" --zero-stats >/dev/null || echo "  ccache" \
    "$DOMICILE_CC_WRAPPER would not zero its statistics, so they span builds."
fi

# The release build, plus the test binaries, probes and Electron's Node the
# checks run.
"$HERE/engine-release-build.sh" "$CHROMIUM" "${OUT_RELEASE:-out/Release}" \
  domicile_unittests ozone_unittests domicile_css_parity domicile_color_probe \
  domicile_solid_color_submitter domicile_capture_probe domicile_desk_probe \
  third_party/electron_node:node

# Chromium's shell can lose the exit status, so the caller checks for this file.
touch "$SENTINEL"

# Log whether the cache was used. Any layer between the systemd unit and the
# compiler can drop DOMICILE_CC_WRAPPER silently.
#
# Plain text, not `::warning::`: engine-build-in-shell.sh prefixes this log, so
# the runner would not parse a workflow command. Errors are not fatal because
# the sentinel decides the step's result.
if [ -n "${DOMICILE_CC_WRAPPER:-}" ]; then
  "$DOMICILE_CC_WRAPPER" --show-stats -v | sed 's/^/  ccache /' || {
    echo "  ccache $DOMICILE_CC_WRAPPER built, then would not report its" \
      "statistics. Whether the cache was consulted is unknown for this run."
  }
else
  echo "  ccache DOMICILE_CC_WRAPPER is unset, so this build used no compiler" \
    "cache. Either this machine's configuration does not set it, or the" \
    "variable did not survive the unit, nix-shell or the FHS sandbox."
fi

echo "engine-build.sh finished"

# Stand-ins for the engine's checks, for the tests of `run-checks.sh`.
#
# Sourced. Needs `ROOT`, the repository's root.

# Builds a repository at `repo` with the real runner and a stand-in for every
# check. Each check runs `<repo>/stand-in.sh <check>`, which the caller writes.
stand_in_engine_checks() { # repo
  local repo="$1" scripts="$1/packages/domicile-engine/scripts" script
  mkdir -p "$scripts" "$repo/packages/check-runner/src" "$repo/.github/scripts"
  cp "$ROOT/packages/domicile-engine/scripts/run-checks.sh" "$scripts/"
  cp "$ROOT/packages/check-runner/src/report.sh" "$repo/packages/check-runner/src/"
  cp "$ROOT/.github/scripts/engine-render-node-lock.sh" "$repo/.github/scripts/"
  for script in build-produced-what-the-guards-load unit-tests drm-unit-tests build-the-compositor; do
    stand_in_script "$repo" "$script" "$script"
  done
  stand_in_script "$repo" check-css-and-resize guard-css-and-resize
  stand_in_script "$repo" check-latency guard-latency
  # Names the check, not the guard script: `run-checks.sh` runs three checks
  # through another guard's script, with `SOFTWARE=1`, `HEADLESS=1` or an
  # argument.
  cat >"$scripts/lib-engine-guard.sh" <<LIB
require_engine_out() { :; }
stand_in() { "$repo/stand-in.sh" "\${1%.sh}\${SOFTWARE:+-in-memory}\${HEADLESS:+-on-headless}\${2:+-\$2}"; }
engine_guard() { stand_in "\$@"; }
engine_guard_and_control() { stand_in "\$@"; }
engine_guard_and_control_under_wayland() { stand_in "\$@"; }
engine_guard_under_wayland() { stand_in "\$@"; }
LIB
}

stand_in_script() { # repo, script, check
  printf '#!/usr/bin/env bash\nexec "%s/stand-in.sh" %s\n' "$1" "$3" \
    >"$1/packages/domicile-engine/scripts/$2.sh"
  chmod +x "$1/packages/domicile-engine/scripts/$2.sh"
}

# Prints every check `run-checks.sh` runs, one per line.
engine_checks() {
  awk '/^(FIRST|TOGETHER|LAST)=\(/ { in_list = 1; next }
       in_list && /^\)/ { in_list = 0 }
       in_list && /^  [a-z]/ { print $1 }' \
    "$ROOT/packages/domicile-engine/scripts/run-checks.sh"
}

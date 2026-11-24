#!/usr/bin/env bash
# Tests `guard-shell-workers.sh`'s verdict, and that the series and the checks
# carry what it guards.
#
# The browser fetches a worker's main script through
# `RegisterNonNetworkWorkerMainResourceURLLoaderFactories`, so without
# domicile:// there every worker the shell starts aborts. Reads the scripts and
# the patches, not a Chromium tree.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
GUARD="$ENGINE/scripts/guard-shell-workers.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

BLOCK="$(awk '/^FAILURE=""$/,/^esac$/' "$GUARD")"
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

verdict() { # $1 what the shell said
  (
    SAID="$1"
    eval "$BLOCK"
    if [ -z "$FAILURE" ]; then echo pass; else echo fail; fi
  )
}

says() { # $1 what the shell said, $2 what the failure must contain
  (
    SAID="$1"
    eval "$BLOCK"
    case "$FAILURE" in
    *"$2"*) echo yes ;;
    *) echo no ;;
    esac
  )
}

said() { # classic module shared shared-module
  printf '"GUARD workers classic=%s module=%s shared=%s shared-module=%s"' "$@"
}

echo "the verdict"
expect "every worker replying is a pass" pass \
  "$(verdict "$(said replied replied replied replied)")"
expect "a classic worker that failed is a failure" fail \
  "$(verdict "$(said error replied replied replied)")"
expect "a module worker that failed is a failure" fail \
  "$(verdict "$(said replied error replied replied)")"
expect "a shared worker that failed is a failure" fail \
  "$(verdict "$(said replied replied error replied)")"
expect "a shared module worker that said nothing is a failure" fail \
  "$(verdict "$(said replied replied replied silent)")"
expect "and names the worker loader" yes \
  "$(says "$(said error error error error)" "RegisterNonNetworkWorkerMainResourceURLLoaderFactories")"
expect "a shell that never reported is a failure" fail "$(verdict "")"
expect "and says the shell never ran" yes "$(says "" "never ran")"

echo
echo "what it guards"
# A patch names the function in its message and adds the factory in its file.
# Its hunk's context can't say which function: that depends on how far the
# insertion sits from the signature.
if (for patch in "$ENGINE"/patches/*.patch; do
  awk '
    /ChromeContentBrowserClient::RegisterNonNetworkWorkerMainResourceURLLoaderFactories/ { named = 1 }
    /^diff / { inside = ($0 ~ /chrome\/browser\/chrome_content_browser_client\.cc/) }
    inside && /^\+ +domicile::ShellURLLoaderFactory::Create/ { added = 1 }
    END { exit !(named && added) }' "$patch" && exit 0
done; exit 1); then
  printf '  ok    %s\n' "the worker main-script loaders serve domicile://"
else
  printf '  FAIL  %s\n    %s\n' "the worker main-script loaders serve domicile://" \
    "no patch adds ShellURLLoaderFactory to RegisterNonNetworkWorkerMainResourceURLLoaderFactories"
  FAILED=$((FAILED + 1))
fi
if grep -qx '  guard-shell-workers' "$ENGINE/scripts/run-checks.sh"; then
  printf '  ok    %s\n' "test:engine runs guard-shell-workers.sh"
else
  printf '  FAIL  %s\n    %s\n' "test:engine runs guard-shell-workers.sh" \
    "run-checks.sh does not list guard-shell-workers"
  FAILED=$((FAILED + 1))
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the shell's workers load, and the guard says so"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1

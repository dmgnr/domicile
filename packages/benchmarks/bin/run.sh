# Runs one desktop's benchmark: every workload, a fresh boot per run.
# Usage: benchmark <desktop> <driver> <output directory> [runs]
# Writes <output directory>/<desktop>-<workload>-<run>.run.json and each
# run's screenshots. Slack's workloads need BENCH_SLACK_WORKSPACE and
# BENCH_SLACK_COOKIE.
desktop=$1
driver=$2
out=$(realpath -m "$3")
runs=${4:-3}

workloads=(rest chat-and-web chat-web-and-editor)
if [ "$desktop" = console ]; then
  workloads=(rest)
fi

mkdir -p "$out"
# The driver keeps each VM's disk and store image under XDG_RUNTIME_DIR, a
# tmpfs too small for a desktop's store; this puts them on disk.
machines="$out/.machines"

# Slack's sign-in fails here, minutes in, rather than after the rest runs.
if [ "$desktop" != console ]; then
  slack-magic-link >/dev/null
fi

# On a host with a GPU, BENCH_RENDER_NODE (e.g. /dev/dri/renderD128) is the
# card that virgl draws the VM on. DISPLAY keeps the driver from adding
# -nographic, which would override that -display; nothing opens it.
gpu_env=()
if [ -n "${BENCH_RENDER_NODE:-}" ]; then
  # The VNC display: egl-headless alone keeps no picture of the screen, so
  # screendump has "no surface"; a VNC display, nobody connected, makes one.
  # `-vnc none` doesn't. Its socket is under $machines, made fresh per run.
  gpu_env=(DISPLAY=none "QEMU_OPTS=-display egl-headless,rendernode=$BENCH_RENDER_NODE -vnc unix:$machines/vnc")
fi

# A failed run is reported at the end, so the other runs still measure.
failed=()
for workload in "${workloads[@]}"; do
  for run in $(seq "$runs"); do
    name="$desktop-$workload-$run"
    # Where the VM script writes the one-time link it fetches, so the link
    # stays out of the log.
    link="$machines.link"
    echo "=== $name"
    mkdir -p "$out/$name"
    rm -rf "$machines" && mkdir -p "$machines"
    if ! env "${gpu_env[@]}" XDG_RUNTIME_DIR="$machines" BENCH_SLACK_LINK_FILE="$link" BENCH_WORKLOAD="$workload" BENCH_RUN="$run" \
      BENCH_RESULT="$out/$name.run.json" \
      "$driver/bin/nixos-test-driver" --output_directory "$out/$name"; then
      failed+=("$name")
    fi
    rm -rf "$machines" "$link"
  done
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "failed: ${failed[*]}" >&2
  exit 1
fi

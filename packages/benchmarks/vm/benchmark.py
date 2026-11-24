# One boot of one desktop under one workload: wait for the desktop, start the
# workload's apps, let them settle, then sample memory and CPU over a window.
# desktops.nix fills in `DESKTOP`; the rest comes from the environment
# run.sh sets. See packages/benchmarks/README.md.
import datetime as dt
import json
import os
import shutil
import subprocess
import time

DESKTOP = json.loads(r"""@DESKTOP@""")
WORKLOAD = os.environ["BENCH_WORKLOAD"]
RESULT = os.environ["BENCH_RESULT"]
RUN = int(os.environ["BENCH_RUN"])
WAIT = dt.timedelta(seconds=300)
SETTLE_SECONDS = int(os.environ.get("BENCH_SETTLE_SECONDS", "120"))
WINDOW_SECONDS = int(os.environ.get("BENCH_WINDOW_SECONDS", "300"))
INTERVAL_SECONDS = 10
WORKLOADS = {
    "rest": [],
    "chat-and-web": ["slack", "browser"],
    "chat-web-and-editor": ["slack", "browser", "editor"],
}


def in_the_session(argv, log):
    """Starts `argv` as alice, in the environment the desktop's apps get.

    `@LINK@` stands for the Slack link in /tmp/slack-link, read in the VM so
    the one-time link stays out of the log, which prints every command.
    """
    quoted = " ".join('"$(cat /tmp/slack-link)"' if arg == "@LINK@" else f"'{arg}'" for arg in argv)
    # Root reads it: Hyprland's /proc/<pid>/environ isn't readable by alice.
    machine.succeed(
        f"cp /proc/$(pgrep -u alice -o -f '{DESKTOP['compositor']}')/environ /tmp/session-environ"
        " && chmod 644 /tmp/session-environ"
    )
    machine.succeed(f"runuser -u alice -- in-session {quoted} >{log} 2>&1 &")


def cdp_urls():
    """Every DevTools page's address, its query left off, which can hold tokens."""
    return machine.execute(
        "curl -s http://127.0.0.1:9222/json/list http://127.0.0.1:9223/json/list"
        " | grep -o '\"url\": \"[^\"?]*' | cut -c9-120"
    )[1].split()


def cdp_targets(port):
    return machine.succeed(f"curl -sf http://127.0.0.1:{port}/json/list || echo '[]'")


def the_desktop_is_up():
    if DESKTOP["compositor"] is None:
        machine.wait_until_succeeds("pgrep -u alice -x bash", timeout=WAIT)
        return
    machine.wait_until_succeeds(f"pgrep -u alice -f '{DESKTOP['compositor']}'", timeout=WAIT)
    machine.wait_until_succeeds("ls /run/user/1000/wayland-[0-9]", timeout=WAIT)


def fresh_slack_link():
    """A new one-time link, fetched on the host right before it's used: the
    links expire within minutes, and a boot and settle take several."""
    link = os.environ["BENCH_SLACK_LINK_FILE"]
    with open(link, "w") as file:
        subprocess.run(["slack-magic-link"], check=True, stdout=file)
    machine.copy_from_host(link, "/tmp/slack-link")
    machine.succeed("chmod 644 /tmp/slack-link")


def start_slack():
    port = DESKTOP["slackDevtoolsPort"]
    fresh_slack_link()
    in_the_session(DESKTOP["slack"], "/tmp/slack.log")
    # Signed in: the workspace's client page loaded, not the sign-in screen.
    try:
        retry(lambda _: "app.slack.com/client" in cdp_targets(port), timeout=dt.timedelta(seconds=90))
        return
    except Exception:
        pass
    # A link given to Slack as it starts can be lost to its first-run
    # screen; given to the running app, it signs in.
    print(f"Slack isn't signed in yet: {cdp_urls()}; giving it a new link")
    fresh_slack_link()
    in_the_session(DESKTOP["slack"], "/tmp/slack-again.log")
    retry(lambda _: "app.slack.com/client" in cdp_targets(port), timeout=WAIT)


def start_browser():
    for index, argv in enumerate(DESKTOP["browser"]):
        in_the_session(argv, f"/tmp/browser-{index}.log")
    port = DESKTOP["browserDevtoolsPort"]
    retry(lambda _: all(page in cdp_targets(port) for page in DESKTOP["pages"]), timeout=WAIT)


def start_editor():
    in_the_session(DESKTOP["editor"], "/tmp/editor.log")
    machine.wait_until_succeeds("pgrep -u alice -f codium", timeout=WAIT)


# Every list of processes: the one-time Slack link is on Slack's command
# line, and the log and the artifact are public.
PROCESSES = "ps -u alice -o pid=,rss=,args= | sed 's,magic-login/[^ ]*,magic-login/…,' | cut -c1-200"

STARTS = {"slack": start_slack, "browser": start_browser, "editor": start_editor}


def qemu_pid():
    """QEMU, the driver's child or a descendant of it."""
    parents = {}
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                with open(f"/proc/{entry}/stat") as file:
                    parents[int(entry)] = int(file.read().rsplit(")", 1)[1].split()[1])
            except OSError:
                continue
    assert machine.process, "the machine isn't running"
    pids = [machine.process.pid]
    while pids:
        pid = pids.pop()
        with open(f"/proc/{pid}/comm") as file:
            # nixpkgs wraps it: `.qemu-system-x8`, its name cut to 15.
            if "qemu-system" in file.read():
                return pid
        pids += [child for child, parent in parents.items() if parent == pid]
    raise RuntimeError("no QEMU under the driver")


# The CI runner's PATH leaves out the system's programs, where NixOS puts it.
NVIDIA_SMI = shutil.which("nvidia-smi") or "/run/current-system/sw/bin/nvidia-smi"


def host_sample(pid):
    """QEMU's CPU ticks and its share of the host's NVIDIA card."""
    with open(f"/proc/{pid}/stat") as file:
        fields = file.read().rsplit(")", 1)[1].split()
    # pmon's columns vary by driver, so they're found by the header's names.
    lines = subprocess.run(
        [NVIDIA_SMI, "pmon", "-c", "1", "-s", "um"], check=True, capture_output=True, text=True
    ).stdout.splitlines()
    header = lines[0].lstrip("#").split()
    rows = [dict(zip(header, line.split())) for line in lines if not line.startswith("#")]
    mine = [row for row in rows if row.get("pid") == str(pid)]

    def total(column):
        return sum(int(row[column]) for row in mine if row.get(column, "-").isdigit())

    return {
        "gpuMib": total("fb"),
        "gpuPercent": total("sm"),
        # utime and stime, every thread's.
        "qemuTicks": int(fields[11]) + int(fields[12]),
        "seconds": time.monotonic(),
    }


def screenshot(name):
    """A picture of the screen, for a person to check the run by.

    Not a measure, so a run doesn't fail without one. With virgl, QEMU's
    `screendump` can come back empty; its answer is logged.
    """
    try:
        machine.screenshot(name)
    except Exception as error:
        answer = machine.send_monitor_command("screendump /dev/null")
        print(f"!!! no screenshot {name}: {error}; screendump says {answer!r}")


def sample():
    reading = json.loads(machine.succeed("bench-sample"))
    if DESKTOP["gpu"]:
        reading["host"] = host_sample(qemu_pid())
    return reading


def thread_ticks():
    ticks = {}
    for line in machine.succeed("bench-threads").splitlines():
        path, label, count = line.split("\t")
        ticks[path] = (label, int(count))
    return ticks


def busiest(before, after, seconds):
    """The threads that spent the most CPU between two readings, by label,
    as a percentage of one core. A thread that started in between counts
    from zero; one that ended doesn't count."""
    tick = int(machine.succeed("getconf CLK_TCK"))
    spent = {}
    for path, (label, count) in after.items():
        spent[label] = spent.get(label, 0) + count - before.get(path, (label, 0))[1]
    ranked = sorted(spent.items(), key=lambda item: -item[1])[:25]
    return [
        {"name": label, "cpuPercent": round(100 * count / tick / seconds, 2)}
        for label, count in ranked
        if count > 0
    ]


def measure():
    start, before = time.monotonic(), thread_ticks()
    samples = [sample()]
    for _ in range(WINDOW_SECONDS // INTERVAL_SECONDS):
        machine.sleep(INTERVAL_SECONDS)
        samples.append(sample())
    threads = busiest(before, thread_ticks(), time.monotonic() - start)
    return samples, threads


machine.start()
try:
    the_desktop_is_up()
    machine.sleep(SETTLE_SECONDS)
    for app in WORKLOADS[WORKLOAD]:
        STARTS[app]()
    if WORKLOADS[WORKLOAD]:
        machine.sleep(SETTLE_SECONDS)
    if DESKTOP["gpu"]:
        # Proof the desktop draws on the card and not in software: the
        # guest's GL renderer, and the engines' GPU processes' flags.
        print(machine.execute("eglinfo -B -p surfaceless 2>&1 | grep -i renderer")[1])
        print(machine.execute("ps -u alice -o args= | grep -- --type=gpu-process | grep -o -- '--use-[^ ]*\\|--disable-gpu[^ ]*\\|--ozone-platform=[^ ]*' | sort | uniq -c")[1])
    screenshot(f"{DESKTOP['name']}-{WORKLOAD}-{RUN}")
    samples, threads = measure()
    screenshot(f"{DESKTOP['name']}-{WORKLOAD}-{RUN}-end")
    result = {
        "cores": int(machine.succeed("nproc").strip()),
        "desktop": DESKTOP["name"],
        **({"hostTicksPerSecond": os.sysconf("SC_CLK_TCK")} if DESKTOP["gpu"] else {}),
        "processes": machine.succeed(PROCESSES),
        "run": RUN,
        "samples": samples,
        "threads": threads,
        "top": json.loads(machine.succeed("bench-top")),
        "workload": WORKLOAD,
    }
    with open(RESULT, "w") as file:
        json.dump(result, file, indent=2)
    # The run in the job's log too, readable without the artifact.
    print(f"result: {json.dumps({**result, 'processes': None})}")
except Exception:
    print(f"DevTools pages: {cdp_urls()}")
    # Why a Slack page stalled: what it logged, errors and warnings only, with
    # the workspace's name masked (GitHub masks secrets in the log too).
    workspace = os.environ.get("BENCH_SLACK_WORKSPACE") or "\0"
    for port in (9222, 9223):
        for target in json.loads(cdp_targets(port)):
            if "slack.com" in target.get("url", "") and "webSocketDebuggerUrl" in target:
                page = target["url"].split("?")[0]
                logged = machine.execute(f"bench-console '{target['webSocketDebuggerUrl']}'")[1]
                print(f"== console of {page}".replace(workspace, "…"))
                print(logged.replace(workspace, "…"))
    for command in [
        "dmesg | grep -iE 'virgl|drm|gpu' | tail -10",
        "ls -la /tmp/*.log",
        # Whether Slack got as far as writing its profile.
        "ls -la /home/alice/.config/Slack",
        # A link left here is one Slack's first instance never read.
        "ls -la /home/alice/.config/Slack/DomicileSingletonInbox",
        "for log in /tmp/*.log; do echo \"== $log\"; tail -20 \"$log\" | sed 's,magic-login/[^ ]*,magic-login/…,' | cut -c1-200; done",
        PROCESSES,
    ]:
        print(f"$ {command}")
        print(machine.execute(f"{command} 2>&1")[1])
    screenshot(f"{DESKTOP['name']}-{WORKLOAD}-{RUN}-failed")
    raise
finally:
    # Not shutdown(): some desktops take half an hour to power off, and
    # nothing on the disk is kept.
    machine.crash()

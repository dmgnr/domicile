#!/usr/bin/env python3
"""Type `a` at the shell, from outside the engine.

guard-locked-keys-stay-on-the-page.sh asks where a key typed at a locked desk
goes. Trusted keys go in over the DevTools protocol, as in
guard-app-routes-input-drive.py: a page cannot forward a key it made up.
"""

import argparse
import sys

from guard_webview_devtools import command, connect, shell_target


def key(kind, **fields):
    params = {
        "type": kind,
        "code": "KeyA",
        "key": "a",
        "windowsVirtualKeyCode": 65,
        # evdev 30 + 8: see guard-webview-keyboard-key.py.
        "nativeVirtualKeyCode": 38,
    }
    params.update(fields)
    return ("Input.dispatchKeyEvent", params)


SEQUENCE = [key("keyDown", text="a", unmodifiedText="a"), key("keyUp")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()

    connection = connect(shell_target(arguments.port))
    for identifier, (method, params) in enumerate(SEQUENCE, start=1):
        answer = command(connection, identifier, method, params)
        if "error" in answer:
            raise SystemExit(
                "the engine refused %s %s: %s" % (method, params["type"], answer["error"])
            )
    connection.close()
    print("drove %d events" % len(SEQUENCE), flush=True)


if __name__ == "__main__":
    try:
        main()
    except OSError as failure:
        sys.exit("could not reach the engine's debugging port: %s" % failure)

#!/usr/bin/env python3
"""The compositor's end of the control socket, for the guard that asks whether
a locked desk's keys stay on the page.

It answers `hello` with a `welcome`, opens one window, `term`, says `term` has
the keyboard, and says whether the desk is locked: locked unless `--unlocked`.
It prints every line the browser writes -- `said: {...}` -- which is what the
guard reads.
"""

import argparse
import json
import os
import socket
import sys
import time


def send(connection, message):
    connection.sendall((json.dumps(message) + "\n").encode("utf-8"))
    print("sent: %s" % json.dumps(message), flush=True)


def greet(connection, locked):
    send(connection, {"type": "welcome", "protocol_version": 1})
    for message in [
        {
            "type": "app_appeared",
            "app_id": "term",
            "title": "Term",
            "size": [400, 200],
            "dialog": False,
            "client_frame": False,
            "toplevel_id": "term-listed",
        },
        {"type": "focus_changed", "app_id": "term"},
        {"type": "locked", "locked": locked},
    ]:
        time.sleep(0.05)
        send(connection, message)
    print("sent the sequence", flush=True)


def serve(path, locked):
    if os.path.exists(path):
        os.unlink(path)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    listener.listen(4)
    print("listening on %s" % path, flush=True)
    while True:
        connection, _ = listener.accept()
        print("a channel connected", flush=True)
        with connection:
            remainder = b""
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                remainder += chunk
                while b"\n" in remainder:
                    line, remainder = remainder.split(b"\n", 1)
                    print("said: %s" % line.decode("utf-8", "replace"), flush=True)
                    if json.loads(line).get("type") == "hello":
                        greet(connection, locked)
        print("the channel went away", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="path to bind")
    parser.add_argument("--unlocked", action="store_true", help="the control")
    arguments = parser.parse_args()
    try:
        serve(arguments.socket, not arguments.unlocked)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

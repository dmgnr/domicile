#!/usr/bin/env python3
"""The compositor's end of the control socket, for the guard that asks whether
the desk's state attributes on `DomicileHost` say what the compositor said.

It answers `hello` with a `welcome`, then says idle, lock, both themes, the
clipboard, the tray, the modifiers, the pointer theme and the shell's options
-- and prints every
line the browser writes, then `sent the sequence`. The guard judges the page's
reading after that line.
"""

import argparse
import json
import os
import socket
import sys
import time

SEQUENCE = [
    {"type": "idle", "idle": True},
    {"type": "locked", "locked": False},
    {"type": "theme", "theme": "light"},
    {"type": "windows_theme", "theme": "dark"},
    {"type": "clipboard", "entries": [
        {"id": 7, "image": False, "preview": "hello", "current": True},
        {"id": 8, "image": True, "preview": "Image, 3 × 2",
         "thumbnail": "data:image/png;base64,iVBORw0KGgo=", "current": False},
    ]},
    {"type": "tray", "items": [
        {"id": "nm", "title": "Network", "icon": "", "bus": ":1.42",
         "menu": "/MenuBar", "item_is_menu": False},
        {"id": "sync", "title": "Sync", "bus": "org.kde.StatusNotifierItem-7-1",
         "item_is_menu": True},
        # No bus: nothing could reach it, so the browser drops it.
        {"id": "lost", "title": "Lost"},
    ]},
    {"type": "modifiers", "alt": True, "ctrl": False, "shift": True, "logo": False},
    # Stops in the browser process, which logs the theme it was given.
    {"type": "appearance", "high_contrast": False, "reduced_motion": False,
     "cursor": {"name": "domicile-guard", "size": 48}},
    # The page reads the options as the JSON text they came as.
    {"type": "shell_config", "keys": {}, "options": "{\"gaps\":4}"},
]


def send(connection, message):
    connection.sendall((json.dumps(message) + "\n").encode("utf-8"))
    print("sent: %s" % json.dumps(message), flush=True)


def greet(connection):
    send(connection, {"type": "welcome", "protocol_version": 1})
    for message in SEQUENCE:
        time.sleep(0.05)
        send(connection, message)
    print("sent the sequence", flush=True)


def is_hello(line):
    """Whether `line` is the browser's `hello`.

    The real compositor says nothing before it. The browser drops page-bound
    lines that arrive before the page binds its end of the channel.
    """
    return json.loads(line).get("type") == "hello"


def serve(path):
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
                    if is_hello(line):
                        greet(connection)
        print("the channel went away", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="path to bind")
    try:
        serve(parser.parse_args().socket)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

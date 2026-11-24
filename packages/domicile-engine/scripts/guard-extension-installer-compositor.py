#!/usr/bin/env python3
"""The compositor's end of the control socket, for guard-extension-installer.sh
and guard-extension-in-private.sh.

It answers the browser's `hello` with a `welcome`, the `browser_profiles` it
was given as JSON if any, and one `extensions` message naming the directories
it was given as `unpacked` -- none, for the installer guard's control -- and
the `settings` it was given, as JSON. That is what the real compositor sends
at the handshake from a desk's `[browser]` and `[extensions]`, spelled as
`domicile-protocol` spells it (`wire/host-messages.jsonl`).

It says `sent the extensions` once the line is written, which is the guard's
reading of whether the list crossed at all: a run with no mark and no such
line is a channel that never connected, not an installer that did nothing.
"""

import argparse
import json
import os
import socket
import sys


def send(connection, message):
    """Write one newline-delimited JSON message and say so."""
    line = json.dumps(message) + "\n"
    connection.sendall(line.encode("utf-8"))
    print("sent: %s" % line.strip(), flush=True)


def greet(connection, unpacked, settings, profiles):
    """Send the welcome, the profiles and the list."""
    send(connection, {"type": "welcome", "protocol_version": 1})
    if profiles is not None:
        send(connection, dict({"type": "browser_profiles"}, **profiles))
        print("sent the browser profiles", flush=True)
    send(
        connection,
        {
            "type": "extensions",
            "web_store": [],
            "unpacked": unpacked,
            "settings": settings,
        },
    )
    print("sent the extensions", flush=True)


def is_hello(line):
    """Whether `line` is the browser's `hello`.

    The real compositor says nothing before it. The browser drops page-bound
    lines that arrive before the page binds its end of the channel.
    """
    return json.loads(line).get("type") == "hello"


def serve(path, unpacked, settings, profiles):
    """Accept on `path`, send the welcome and the list on `hello`, and read
    until EOF."""
    if os.path.exists(path):
        os.unlink(path)

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    listener.listen(4)
    # Before accept, so a guard waiting on this line is not waiting on a buffer.
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
                        greet(connection, unpacked, settings, profiles)
        print("the channel went away", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="path to bind")
    parser.add_argument(
        "--unpacked",
        action="append",
        default=[],
        help="an absolute directory to name as unpacked; repeatable, or none",
    )
    parser.add_argument(
        "--settings",
        default="{}",
        help="each extension's settings by id, as JSON; none by default",
    )
    parser.add_argument(
        "--browser-profiles",
        default=None,
        help="the desk's browser profiles, as the message's JSON without its "
        "type; none sent by default",
    )
    arguments = parser.parse_args()
    profiles = (
        None
        if arguments.browser_profiles is None
        else json.loads(arguments.browser_profiles)
    )
    try:
        serve(
            arguments.socket,
            arguments.unpacked,
            json.loads(arguments.settings),
            profiles,
        )
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

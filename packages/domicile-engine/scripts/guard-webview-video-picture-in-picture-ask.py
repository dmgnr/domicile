#!/usr/bin/env python3
"""Asks for picture-in-picture on the video of one browser window's page, over
the DevTools protocol.

`requestPictureInPicture` needs the page's user activation, and `crux` has no
pointer to give it one. `Runtime.evaluate` with `userGesture` runs the call
with the activation a click would have given, in the page's own frame, so the
request goes the way a site's button's does: Blink, then
PictureInPictureServiceImpl, then the guest's WebContentsDelegate.

The target is the window's page, found by the end of its URL, and not the
shell's: the shell has no video. Prints `GUARD asked <what the call said>`.
"""

import argparse
import json
import time
import urllib.request

from guard_webview_devtools import command, connect

ASK = """document.querySelector("video").requestPictureInPicture().then(
  () => "entered",
  (error) => "refused " + error.name + ": " + error.message,
)"""


def page_target(port, ending, tries):
    """The debugging URL of the page whose address ends with `ending`.

    Retried: the window's page can be listed after the line the guard waited
    for.
    """
    listed = "http://127.0.0.1:%d/json/list" % port
    for _ in range(tries):
        try:
            with urllib.request.urlopen(listed, timeout=30) as answer:
                for target in json.load(answer):
                    if target.get("url", "").endswith(ending):
                        return target["webSocketDebuggerUrl"]
        except OSError:
            pass
        time.sleep(0.25)
    raise SystemExit("no page at an address ending %s" % ending)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ending", required=True, help="the page's path")
    parser.add_argument("--tries", type=int, default=40)
    arguments = parser.parse_args()

    connection = connect(page_target(arguments.port, arguments.ending, arguments.tries))
    answer = command(
        connection,
        1,
        "Runtime.evaluate",
        {"expression": ASK, "userGesture": True, "awaitPromise": True},
    )
    said = answer.get("result", {}).get("result", {}).get("value")
    print("GUARD asked %s" % (said if said is not None else json.dumps(answer)), flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Zooms a PDF's <webview> and reports how its viewer and its page zoomed.

guard-pdf-zoom.sh shows a PDF in a browser window. Chrome's PDF viewer asks
`chrome.tabs.setZoomSettings` for manual zoom: the browser keeps the viewer's
page at the default zoom and reports each zoom, which the viewer applies to
the document itself.

- Waits until the viewer has started (`window.viewer`, as
  guard-shell-pdf-viewer.py checks).
- Calls the <webview>'s setZoom with `--factor`.
- Reads the page's `devicePixelRatio`, which browser zoom scales, and the
  viewer's own zoom, until the viewer has the factor or `--after` runs out.
  The page is the <webview>'s own target; the viewer is a frame in it.

Prints `ratio=<devicePixelRatio> viewer=<viewer zoom>`, both to two places,
or `viewer=absent` if the viewer never started.
"""

import argparse
import json
import sys
import time
import urllib.request

from guard_webview_devtools import command, connect, shell_target

VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"
# The viewer's zoom, or null before it has started.
VIEWER_ZOOM = "Object.hasOwn(window, 'viewer') ? viewer.viewport.getZoom() : null"


def targets(port):
    """The debugging URLs of the <webview>'s page and the viewer's frame."""
    listed = "http://127.0.0.1:%d/json/list" % port
    page = viewer = None
    with urllib.request.urlopen(listed, timeout=30) as answer:
        for target in json.load(answer):
            if target.get("type") == "webview":
                page = target["webSocketDebuggerUrl"]
            elif target.get("url", "").startswith(VIEWER):
                viewer = target["webSocketDebuggerUrl"]
    return page, viewer


def evaluate(url, identifier, expression):
    """The value of `expression` in the target at `url`."""
    connection = connect(url)
    try:
        answer = command(
            connection,
            identifier,
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True},
        )
    finally:
        connection.close()
    if "result" not in answer:
        raise SystemExit("the engine refused Runtime.evaluate: %s" % answer)
    return answer["result"].get("result", {}).get("value")


def read_viewer(port, identifier):
    """[the page's devicePixelRatio, the viewer's zoom], or None before the
    viewer starts."""
    page, viewer = targets(port)
    if page is None or viewer is None:
        return None
    zoom = evaluate(viewer, identifier, VIEWER_ZOOM)
    if zoom is None:
        return None
    return [evaluate(page, identifier, "devicePixelRatio"), zoom]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--tries", type=int, default=60)
    parser.add_argument("--factor", type=float, default=2.0)
    parser.add_argument("--after", type=float, default=10.0)
    args = parser.parse_args()

    identifier = 0
    started = None
    for _ in range(args.tries):
        identifier += 1
        started = read_viewer(args.port, identifier)
        if started is not None:
            break
        time.sleep(0.5)
    if started is None:
        print("viewer=absent")
        return 0
    # The viewer first zooms to fit the page and tells the browser; a zoom
    # that arrives while it waits for that answer is dropped (ZoomManager).
    time.sleep(1.0)

    identifier += 1
    evaluate(shell_target(args.port), identifier, "guardZoom(%r)" % args.factor)

    read = started
    until = time.monotonic() + args.after
    while time.monotonic() < until:
        identifier += 1
        read = read_viewer(args.port, identifier) or read
        if abs(read[1] - args.factor) < 0.01:
            break
        time.sleep(0.25)
    # The page's zoom, if it changed, reaches the frame on its own schedule.
    time.sleep(1.0)
    identifier += 1
    read = read_viewer(args.port, identifier) or read
    print("ratio=%.2f viewer=%.2f" % (read[0], read[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

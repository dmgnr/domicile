#!/usr/bin/env python3
"""Measures whether a PDF's page is still drawn after its <webview> is hidden
and shown again.

guard-pdf-after-hiding.sh shows a one-page PDF, without the viewer's toolbar
or sidebar, so the only white on screen is the page on the viewer's gray.

- Waits until the page is drawn, and counts its white pixels.
- Hides the <webview>'s box, waits `--hidden` seconds, and shows it again.
- Counts the white pixels for `--after` seconds and keeps the most seen, so a
  page that is only slow to draw again is not called blank.

Prints `before=<white pixels> after=<white pixels>`, or `before=0` if the page
never drew.
"""

import argparse
import base64
import struct
import sys
import time
import zlib

from guard_webview_devtools import command, connect, shell_target

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# A pixel is the page's when every channel is at least this.
WHITE = 245
# Fewer white pixels than this is not the page yet.
DRAWN = 5000


def white_pixels(png):
    """How many pixels of an 8-bit RGB or RGBA PNG are white."""
    if not png.startswith(PNG_SIGNATURE):
        raise SystemExit("the screenshot is not a PNG")
    offset = len(PNG_SIGNATURE)
    data = b""
    width = height = channels = None
    while offset < len(png):
        (length,) = struct.unpack("!I", png[offset : offset + 4])
        kind = png[offset + 4 : offset + 8]
        body = png[offset + 8 : offset + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color = struct.unpack("!IIBB", body[:10])
            if depth != 8 or color not in (2, 6):
                raise SystemExit("the screenshot is not 8-bit RGB or RGBA")
            channels = 3 if color == 2 else 4
        elif kind == b"IDAT":
            data += body
        offset += 12 + length
    raw = zlib.decompress(data)
    stride = width * channels
    previous = bytearray(stride)
    position = 0
    white = 0
    for _ in range(height):
        kind = raw[position]
        line = bytearray(raw[position + 1 : position + 1 + stride])
        position += 1 + stride
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                guess = left + up - corner
                near = min(
                    (abs(guess - left), left),
                    (abs(guess - up), up),
                    (abs(guess - corner), corner),
                    key=lambda pair: pair[0],
                )[1]
                line[i] = (line[i] + near) & 0xFF
        previous = line
        for x in range(0, stride, channels):
            if min(line[x], line[x + 1], line[x + 2]) >= WHITE:
                white += 1
    return white


class Shell:
    """The shell page, over one debugging connection."""

    def __init__(self, port):
        self.connection = connect(shell_target(port))
        self.identifier = 0

    def ask(self, method, params):
        self.identifier += 1
        answer = command(self.connection, self.identifier, method, params)
        if "result" not in answer:
            raise SystemExit("the engine refused %s: %s" % (method, answer))
        return answer["result"]

    def white(self):
        shot = self.ask("Page.captureScreenshot", {"format": "png"})
        return white_pixels(base64.b64decode(shot["data"]))

    def run(self, expression):
        self.ask("Runtime.evaluate", {"expression": expression})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--tries", type=int, default=60)
    parser.add_argument("--hidden", type=float, default=1.0)
    parser.add_argument("--after", type=float, default=5.0)
    args = parser.parse_args()

    shell = Shell(args.port)
    try:
        before = 0
        for _ in range(args.tries):
            before = shell.white()
            if before >= DRAWN:
                break
            time.sleep(0.5)
        if before < DRAWN:
            print("before=0")
            return 0

        shell.run("guardHide()")
        time.sleep(args.hidden)
        shell.run("guardShow()")

        after = 0
        until = time.monotonic() + args.after
        while time.monotonic() < until:
            after = max(after, shell.white())
            time.sleep(0.25)
        print("before=%d after=%d" % (before, after))
        return 0
    finally:
        shell.connection.close()


if __name__ == "__main__":
    sys.exit(main())

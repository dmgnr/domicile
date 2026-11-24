#!/usr/bin/env python3
"""Measures how evenly a PDF's thin lines survive being drawn smaller.

guard-pdf-scaled-text.sh shows `guard-pdf-scaled-text.pdf`, forty equal thin
lines, at 0.8 of its size. The viewer's bitmap is rastered at that scale, as
it is on a monitor below the desk's highest density.

- A filtered downscale keeps each line's ink: the lines stay equal.
- A nearest-neighbor one keeps whole source columns or drops them, so some
  lines lose half their ink. That is what breaks thin strokes in text.

Takes a screenshot of the shell over the debugging port, finds the lines,
and sums each one's darkness over ten rows.
Retries until the lines are drawn, or `--tries` runs out.

Prints `lines=<count> spread=<max ink / min ink>`, or `lines=0`.
"""

import argparse
import base64
import struct
import sys
import time
import zlib

from guard_webview_devtools import command, connect, shell_target

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# A column is part of a line when it is this much darker than white.
INK = 24
# Rows summed per line, from the row that crosses the most lines.
ROWS = 10
# Fewer runs than this is not the fixture yet.
LINES = 40


def decode(png):
    """A PNG's rows as lists of gray levels, 0 black to 255 white."""
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
    rows = []
    previous = bytearray(stride)
    position = 0
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
        rows.append(
            [
                (line[x] + line[x + 1] + line[x + 2]) // 3
                for x in range(0, stride, channels)
            ]
        )
    return rows


def runs(row):
    """Each dark run in a row of gray levels, as (start, end)."""
    found = []
    start = None
    for x, level in enumerate(row + [255]):
        dark = 255 - level > INK
        if dark and start is None:
            start = x
        elif not dark and start is not None:
            found.append((start, x))
            start = None
    return found


def measure(rows):
    """`(count, spread)` of the fixture's lines, or None before they are drawn.

    The lines are the tallest block of rows that each cross at least `LINES`
    dark runs; the text under them is a few rows. Measured from its middle.
    """
    best = (0, 0)
    start = None
    for y, row in enumerate(rows + [[]]):
        if len(runs(row)) >= LINES:
            start = y if start is None else start
        elif start is not None:
            best = max(best, (y - start, start))
            start = None
    height, top = best
    if height < 2 * ROWS:
        return None
    middle = top + height // 2
    spans = lines_of(runs(rows[middle]))
    inks = [
        sum(
            255 - rows[y][x]
            for y in range(middle, middle + ROWS)
            for x in range(a - 1, b + 1)
        )
        for a, b in spans
    ]
    return len(inks), max(inks) / min(inks)


def lines_of(spans):
    """The `LINES` runs whose gaps vary least: the fixture, not the text."""

    def unevenness(first):
        chosen = spans[first : first + LINES]
        gaps = [b[0] - a[0] for a, b in zip(chosen, chosen[1:])]
        return max(gaps) - min(gaps)

    first = min(range(len(spans) - LINES + 1), key=unevenness)
    return spans[first : first + LINES]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--tries", type=int, default=60)
    parser.add_argument("--save", help="also write the screenshot here")
    args = parser.parse_args()

    for identifier in range(1, args.tries + 1):
        connection = connect(shell_target(args.port))
        try:
            answer = command(
                connection, identifier, "Page.captureScreenshot", {"format": "png"}
            )
        finally:
            connection.close()
        if "result" not in answer:
            print("the engine refused the screenshot: %s" % answer, file=sys.stderr)
            return 1
        png = base64.b64decode(answer["result"]["data"])
        if args.save:
            with open(args.save, "wb") as out:
                out.write(png)
        measured = measure(decode(png))
        if measured is not None:
            print("lines=%d spread=%.2f" % measured)
            return 0
        time.sleep(0.5)
    print("lines=0")
    return 0


if __name__ == "__main__":
    sys.exit(main())

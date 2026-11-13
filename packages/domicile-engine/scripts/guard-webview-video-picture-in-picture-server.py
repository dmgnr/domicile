#!/usr/bin/env python3
"""Serves the page guard-webview-video-picture-in-picture.sh loads.

  /video   a page playing a muted video drawn from a canvas, which reports
           to /report when it plays, enters picture-in-picture and leaves it.
  /report  prints `GUARD report <query>` with what the page said.

Served over HTTP because `crux` cannot reach arbitrary hosts. The video is a
canvas stream, so there is no media file to serve or decode.
"""

import argparse
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

VIDEO = "/video"
REPORT = "/report"

VIDEO_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>a page for the video picture-in-picture guard</title>
  </head>
  <body>
    <video muted playsinline></video>
    <script>
      const report = (what) => fetch("/report?" + new URLSearchParams(what));

      // Two colors in turn, so the stream always has a new frame.
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      let frame = 0;
      const draw = () => {
        context.fillStyle = frame++ % 2 === 0 ? "#204060" : "#406020";
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      draw();
      setInterval(draw, 50);

      const video = document.querySelector("video");
      video.srcObject = canvas.captureStream(20);
      video.addEventListener("playing", () => report({ event: "playing" }), {
        once: true,
      });
      video.addEventListener("enterpictureinpicture", (event) =>
        report({
          event: "entered",
          width: event.pictureInPictureWindow.width,
          height: event.pictureInPictureWindow.height,
        }),
      );
      video.addEventListener("leavepictureinpicture", () =>
        report({ event: "left", paused: video.paused }),
      );
      video.play();
    </script>
  </body>
</html>
"""


class Video(BaseHTTPRequestHandler):
    """Answers the paths above, and everything else with a 404."""

    def answer(self, page):
        encoded = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        path = urlsplit(self.path)
        if path.path == VIDEO:
            self.answer(VIDEO_PAGE)
        elif path.path == REPORT:
            # Flushed, since the guard reads it while this server runs.
            print("GUARD report %s" % path.query.replace("&", " "), flush=True)
            self.answer("")
        else:
            self.send_error(404, "this server has two pages and that is neither")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help="0 for any free one; the serving line names the one taken",
    )
    arguments = parser.parse_args()

    # Loopback only: nothing outside this machine should reach the fixture.
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), Video)
    # Flushed before serve_forever, since the guard waits for this line.
    print(
        "serving %s and %s on 127.0.0.1:%d"
        % (VIDEO, REPORT, server.server_address[1]),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

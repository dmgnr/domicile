#!/usr/bin/env python3
"""Serves the page guard-webview-chrome-sheets.sh loads.

  /probe   a page that reads which of the APIs whose only UI is Chrome's it
           has, and sends what it found to /report.
  /report  prints `GUARD report <query>` with what the page found.

Served over HTTP because `crux` cannot reach arbitrary hosts. 127.0.0.1 is a
secure context, so the APIs are offered here as on an https:// site.
"""

import argparse
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PROBE = "/probe"
REPORT = "/report"

PROBE_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>a page for the Chrome sheets guard</title>
  </head>
  <body>
    <script>
      const found = new URLSearchParams({
        payment: typeof PaymentRequest,
        pip: String(document.pictureInPictureEnabled),
        credentials: typeof navigator.credentials,
        docpip: typeof documentPictureInPicture,
      });
      fetch("/report?" + found);
    </script>
  </body>
</html>
"""


class Probe(BaseHTTPRequestHandler):
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
        if path.path == PROBE:
            self.answer(PROBE_PAGE)
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
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), Probe)
    # Flushed before serve_forever, since the guard waits for this line.
    print(
        "serving %s and %s on 127.0.0.1:%d"
        % (PROBE, REPORT, server.server_address[1]),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

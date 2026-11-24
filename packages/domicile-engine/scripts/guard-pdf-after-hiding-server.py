#!/usr/bin/env python3
"""Serves the PDF guard-pdf-after-hiding.sh shows in a browser window.

One path, `/guard.pdf`: `guard-shell-pdf.pdf`, a page reading "Hello PDF".
Served over HTTP for guard-webview-guest-page.py's reason: `crux` reaches no
arbitrary host, and a bundled fixture cannot change under the guard.
"""

import argparse
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The only path served. Not "/", so a stray request gets a 404 instead of the
# PDF.
PATH = "/guard.pdf"
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard-shell-pdf.pdf")


class ServesThePdf(BaseHTTPRequestHandler):
    """Answers PATH with the PDF, and everything else with a 404."""

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        if self.path != PATH:
            self.send_error(404, "this server has one file and it is " + PATH)
            return

        with open(FIXTURE, "rb") as fixture:
            body = fixture.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # To stderr, which the guard keeps.
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

    # 127.0.0.1, not 0.0.0.0: nothing off this machine should reach a guard's
    # fixture.
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), ServesThePdf)
    print(
        "serving a PDF on 127.0.0.1:%d" % server.server_address[1],
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

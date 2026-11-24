#!/usr/bin/env python3
"""The page guard-webview-reshown-tiles.sh shows in a browser window.

A screenful of text in many colors, so every tile in its viewport takes a real
raster and none is a solid color. It logs its `document.visibilityState` on
load and on every `visibilitychange`.

It logs to the console, which the engine writes to its log:

  GUARD page-loaded              the page ran
  GUARD state=visible|hidden     its visibility, then each change

Served over HTTP, not as a `data:` URL, for guard-webview-guest-page.py's
reason: `crux` reaches no arbitrary host, and a bundled fixture cannot change
under the guard.
"""

import argparse
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The only path served. Not "/", so a stray request gets a 404 instead of the
# page under test.
PATH = "/page"

LINE = (
    '<p style="color: hsl({hue} 70% 40%); margin: 0">'
    "line {index}: the quick brown fox jumps over the lazy dog, again and "
    "again, so that no tile of this page is a solid color</p>"
)

PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>a page of text that says whether it is shown</title>
  </head>
  <body style="font: 16px sans-serif">
    {lines}
    <script>
      const report = () => {{
        console.log(`GUARD state=${{document.visibilityState}}`);
      }};
      console.log("GUARD page-loaded");
      report();
      document.addEventListener("visibilitychange", report);
    </script>
  </body>
</html>
""".format(
    lines="\n".join(LINE.format(hue=(index * 37) % 360, index=index) for index in range(80))
)


class SaysItsVisibility(BaseHTTPRequestHandler):
    """Answers PATH with the page, and everything else with a 404."""

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        if self.path != PATH:
            self.send_error(404, "this server has one page and it is " + PATH)
            return

        body = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
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
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), SaysItsVisibility)
    print(
        "serving a page of text on 127.0.0.1:%d" % server.server_address[1],
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

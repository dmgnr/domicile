#!/usr/bin/env python3
"""The page guard-webview-spellcheck.sh checks spelling in.

  /page   one text field filling the viewport, holding two misspelled words,
          one per line: "recieve", which the dictionary has suggestions for,
          and "zorblax", which it has none for. Large and monospaced, so the
          guard's press points, from the top left, land on each word.

          Says `GUARD page-loaded` when it runs, and `GUARD page-text <text>`
          (lines joined by `|`) on every edit, which is how a replaced word
          shows.

          `?unchecked` is the control's: the field has `spellcheck="false"`,
          so no word in it is misspelled to the browser.

Served over HTTP for the reason guard-webview-framing-server.py serves its
own subject: `crux` reaches no arbitrary host.
"""

import argparse
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PAGE = "/page"

PAGE_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>two misspelled words</title>
    <style>
      html, body { margin: 0; height: 100%%; }
      textarea {
        display: block; position: fixed; inset: 0; box-sizing: border-box;
        margin: 0; border: 0; padding: 0; resize: none;
        font: 48px/80px monospace;
      }
    </style>
  </head>
  <body>
    <textarea spellcheck="%(spellcheck)s">recieve
zorblax</textarea>
    <script>
      const say = (what) => {
        console.log(`GUARD ${what}`);
      };
      const field = document.querySelector("textarea");
      field.addEventListener("input", () => {
        say(`page-text ${field.value.replaceAll("\\n", "|")}`);
      });
      say("page-loaded");
    </script>
  </body>
</html>
"""


class TwoMisspelledWords(BaseHTTPRequestHandler):
    """Answers /page, and everything else with a 404."""

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        address = urlsplit(self.path)
        if address.path == PAGE:
            unchecked = "unchecked" in parse_qs(address.query, keep_blank_values=True)
            body = PAGE_HTML % {"spellcheck": "false" if unchecked else "true"}
            self.answer("text/html; charset=utf-8", body.encode("utf-8"))
        else:
            self.send_error(404, "this server has one page and that is not it")

    def answer(self, content_type, body):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

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

    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), TwoMisspelledWords)
    print("serving %s on 127.0.0.1:%d" % (PAGE, server.server_address[1]), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

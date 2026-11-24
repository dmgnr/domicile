#!/usr/bin/env python3
"""Serves the site and the identity provider guard-webview-sign-in-with.sh uses.

One origin is both, which FedCM allows: a provider on the signing-in site's
own site needs no /.well-known/web-identity, though one is served anyway.

  /rp?phase=1   signs in, which the shell answers by choosing the account, and
                then asks again, which the shell withdraws by navigating away
  /rp?phase=2   asks again, which the shell dismisses
  /report       prints `GUARD report <query>` with what the page found

  /fedcm.json, /accounts, /client, /assert, /login, /privacy, /terms
                the provider: its config, one account, the site's links, the
                token, and its pages

Served over HTTP because `crux` cannot reach arbitrary hosts. 127.0.0.1 is a
secure context, so FedCM is offered here as on an https:// site.
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# The token the provider issues, which the page reports once signed in.
TOKEN = "guard-token"

ACCOUNT = {
    "id": "guard",
    "name": "Guard Tester",
    "given_name": "Guard",
    "email": "guard@idp.test",
    # Never signed in to the site before, so signing in shares what the site
    # asks for and the shell is told so.
    "approved_clients": [],
}

RP_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>a site that signs in with an identity provider</title>
  </head>
  <body>
    <script>
      const phase = new URLSearchParams(location.search).get("phase");
      const report = (found) => fetch("/report?" + new URLSearchParams(found));
      // "required" so a returning account is still offered, not signed in
      // on its own.
      const ask = (mediation) =>
        navigator.credentials.get({
          identity: {
            providers: [
              { configURL: location.origin + "/fedcm.json", clientId: "guard" },
            ],
          },
          mediation,
        });
      const run = async () => {
        if (phase === "1") {
          try {
            const credential = await ask("optional");
            await report({ step: "chosen", token: credential.token });
          } catch (error) {
            await report({ step: "chosen", error: error.name });
          }
          // Left waiting: the shell navigates the page away.
          await report({ step: "asking-again" });
          ask("required").catch(() => {});
        } else {
          try {
            await ask("required");
            await report({ step: "dismissed", error: "none" });
          } catch (error) {
            await report({ step: "dismissed", error: error.name });
          }
        }
      };
      run();
    </script>
  </body>
</html>
"""

PLAIN_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>%s</title>
  </head>
  <body>%s</body>
</html>
"""


class Site(BaseHTTPRequestHandler):
    """Answers the paths above, and everything else with a 404."""

    def origin(self):
        return "http://%s" % self.headers.get("Host")

    def answer(self, body, content_type, extra_headers=()):
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)

    def answer_json(self, value, extra_headers=()):
        self.answer(json.dumps(value), "application/json", extra_headers)

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        path = urlsplit(self.path)
        if path.path == "/rp":
            # The provider is this origin, so the page tells the browser the
            # user is signed in to it, as a provider's own page would.
            self.answer(
                RP_PAGE,
                "text/html; charset=utf-8",
                [("Set-Login", "logged-in")],
            )
        elif path.path == "/report":
            # Flushed, since the guard reads it while this server runs.
            print("GUARD report %s" % path.query.replace("&", " "), flush=True)
            self.answer("", "text/plain")
        elif path.path == "/.well-known/web-identity":
            self.answer_json({"provider_urls": [self.origin() + "/fedcm.json"]})
        elif path.path == "/fedcm.json":
            self.answer_json(
                {
                    "accounts_endpoint": "/accounts",
                    "client_metadata_endpoint": "/client",
                    "id_assertion_endpoint": "/assert",
                    "login_url": "/login",
                }
            )
        elif path.path == "/accounts":
            self.answer_json({"accounts": [ACCOUNT]})
        elif path.path == "/client":
            self.answer_json(
                {
                    "privacy_policy_url": self.origin() + "/privacy",
                    "terms_of_service_url": self.origin() + "/terms",
                }
            )
        elif path.path in ("/login", "/privacy", "/terms"):
            self.answer(
                PLAIN_PAGE % (path.path[1:], path.path[1:]),
                "text/html; charset=utf-8",
            )
        else:
            self.send_error(404, "this server has no such page")

    def do_POST(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        path = urlsplit(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        posted = parse_qs(self.rfile.read(length).decode("utf-8"))
        if path.path == "/assert" and posted.get("account_id") == ["guard"]:
            origin = self.headers.get("Origin", self.origin())
            self.answer_json(
                {"token": TOKEN},
                [
                    ("Access-Control-Allow-Origin", origin),
                    ("Access-Control-Allow-Credentials", "true"),
                ],
            )
        else:
            self.send_error(400, "the provider issues a token for its one account")

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
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), Site)
    # Flushed before serve_forever, since the guard waits for this line.
    print(
        "serving /rp, /report and a provider on 127.0.0.1:%d"
        % server.server_address[1],
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

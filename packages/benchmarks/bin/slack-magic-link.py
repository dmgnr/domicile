"""Prints a one-time link that signs the Slack desktop app in to a workspace.

Uses the web session in BENCH_SLACK_COOKIE (the `d` cookie of a signed-in
browser: a password sign-in from a new machine asks for an emailed code),
opens the page that hands the desktop app its sign-in, and takes the
`slack://` link it navigates to. On failure, prints the page's text and saves
a screenshot to BENCH_SLACK_DEBUG; the page's HTML is not saved, as it holds
the session's tokens and the artifacts are public.
"""

import os
import re
import sys
from typing import NoReturn

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

WORKSPACE = os.environ["BENCH_SLACK_WORKSPACE"]
COOKIE = os.environ["BENCH_SLACK_COOKIE"]
DEBUG = os.environ.get("BENCH_SLACK_DEBUG", "slack-debug")
BASE = f"https://{WORKSPACE}.slack.com"
LINK = re.compile(r"slack://[^\"'\s<>\\]+")


def fail(page, message) -> NoReturn:
    os.makedirs(DEBUG, exist_ok=True)
    page.screenshot(path=os.path.join(DEBUG, "page.png"), full_page=True)
    print(page.inner_text("body")[:2000], file=sys.stderr)
    sys.exit(f"{message} (at {page.url})")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context()
    context.add_cookies([
        {"name": "d", "value": COOKIE, "domain": ".slack.com", "path": "/", "secure": True, "httpOnly": True},
    ])
    page = context.new_page()
    # A navigation to an app's scheme reaches no request handler, only the
    # DevTools protocol.
    navigations = []
    devtools = context.new_cdp_session(page)
    devtools.send("Page.enable")
    devtools.on("Page.frameRequestedNavigation", lambda event: navigations.append(event["url"]))
    devtools.on("Page.frameStartedNavigating", lambda event: navigations.append(event["url"]))

    def found():
        texts = navigations + [frame.url for frame in page.frames] + [frame.content() for frame in page.frames]
        links = [link for text in texts for link in LINK.findall(text) if "magic" in link]
        return links[0].replace("&amp;", "&") if links else None

    # It never fires `load`: it navigates to the app scheme first.
    page.goto(f"{BASE}/ssb/redirect", wait_until="commit")
    page.wait_for_timeout(5_000)
    # A signed-out session lands on the sign-in page, or on the workspace's
    # front page with the page it wanted in `redir`.
    if any(part in page.url for part in ("sign_in", "signin", "redir=")):
        fail(page, "BENCH_SLACK_COOKIE isn't a signed-in session")
    if found() is None:
        try:
            page.get_by_text("Open Slack", exact=True).first.click(timeout=30_000)
        except PlaywrightTimeout:
            fail(page, "Slack gave no magic-login link and no 'Open Slack' button")
        page.wait_for_timeout(5_000)
    link = found()
    if link is None:
        seen = sorted({url.split("?")[0][:40] for url in navigations})
        print(f"navigations seen: {seen}", file=sys.stderr)
        fail(page, "Slack gave no magic-login link")
    print(link)
    browser.close()

#!/usr/bin/env python3
"""The verdict of guard-desk-state.sh: whether the page's latest reading of the
desk's state attributes says what the compositor stand-in said.

Takes the engine log. Prints what is wrong, naming each attribute that differs,
or nothing when the reading is right. The page logs a reading each time one
changes, so only the last one counts.
"""

import json
import re
import sys

PREFIX = '"GUARD state '

WANTED = {
    "altKey": True,
    "clipboard": [
        {"current": True, "id": 7, "image": False, "preview": "hello", "thumbnail": ""},
        {"current": False, "id": 8, "image": True, "preview": "Image, 3 × 2",
         "thumbnail": "data:image/png;base64,iVBORw0KGgo="},
    ],
    "ctrlKey": False,
    "idle": True,
    "locked": False,
    "shellOptions": '{"gaps":4}',
    "shiftKey": True,
    "theme": "light",
    "tray": [
        {"bus": ":1.42", "id": "nm", "itemIsMenu": False, "menu": "/MenuBar", "title": "Network"},
        {"bus": "org.kde.StatusNotifierItem-7-1", "id": "sync", "itemIsMenu": True, "menu": "", "title": "Sync"},
    ],
    "windowsTheme": "dark",
}


def latest_reading(log):
    """The last `GUARD state` reading in `log`, or None if the page made none."""
    with open(log, encoding="utf-8", errors="replace") as file:
        lines = re.findall(r'"GUARD state .*"', file.read())
    return json.loads(lines[-1][len(PREFIX):-1]) if lines else None


def verdict(state):
    if state is None:
        return "the page never read the state, so the module did not run or an attribute threw"
    wrong = sorted(k for k in WANTED if state.get(k) != WANTED[k])
    if not wrong:
        return ""
    return "the attributes do not say what the compositor said: %s" % ", ".join(
        "%s is %s, wanted %s" % (k, json.dumps(state.get(k)), json.dumps(WANTED[k])) for k in wrong
    )


def main():
    failure = verdict(latest_reading(sys.argv[1]))
    if failure:
        print(failure)
    return 0


if __name__ == "__main__":
    sys.exit(main())

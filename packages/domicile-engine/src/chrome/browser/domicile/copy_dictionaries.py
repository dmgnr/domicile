#!/usr/bin/env python3
# Copyright 2026 Connor Prussin
# SPDX-License-Identifier: MIT
"""Copies the Hunspell dictionaries into the folder beside the engine.

    copy_dictionaries.py <hunspell_dictionaries> <out>/dictionaries <stamp>

Every `.bdic` in the checkout, so a language Chrome lists has its dictionary
without listing each file here. Fails when there are none: the engine would
check no spelling, and only its log would say so.
"""

import pathlib
import shutil
import sys


def main(source, destination, stamp):
    dictionaries = sorted(pathlib.Path(source).glob("*.bdic"))
    if not dictionaries:
        sys.exit(f"no .bdic dictionaries in {source}")
    out = pathlib.Path(destination)
    out.mkdir(parents=True, exist_ok=True)
    for dictionary in dictionaries:
        shutil.copyfile(dictionary, out / dictionary.name)
    pathlib.Path(stamp).write_text(
        "".join(f"{dictionary.name}\n" for dictionary in dictionaries))


if __name__ == "__main__":
    main(*sys.argv[1:])

#!/usr/bin/env python3
"""Remove explicitly disallowed patches from a pinned Thorium series."""

import argparse
import sys
from collections import Counter
from pathlib import Path


def patch_path(line: str) -> str | None:
    entry = line.split("#", maxsplit=1)[0].strip()
    if not entry:
        return None
    if entry.startswith("["):
        _, separator, entry = entry.partition("]")
        if not separator:
            return None
        entry = entry.strip()
    if ":" in entry and not entry.startswith("other/"):
        _, _, entry = entry.partition(":")
    return entry.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--series", required=True, type=Path)
    parser.add_argument("--exclusions", required=True, type=Path)
    arguments = parser.parse_args()

    exclusions = {
        line.split("#", maxsplit=1)[0].strip()
        for line in arguments.exclusions.read_text().splitlines()
        if line.split("#", maxsplit=1)[0].strip()
    }
    if not exclusions:
        print("Thorium security exclusion list is empty", file=sys.stderr)
        return 1

    lines = arguments.series.read_text().splitlines(keepends=True)
    entries = Counter(patch_path(line) for line in lines)
    for excluded in sorted(exclusions):
        count = entries[excluded]
        if count == 0:
            print(
                f"required Thorium patch is absent from series: {excluded}",
                file=sys.stderr,
            )
            return 1
        if count != 1:
            print(
                f"required Thorium patch must occur exactly once in series: {excluded} (found {count})",
                file=sys.stderr,
            )
            return 1

    for line in lines:
        entry = patch_path(line)
        if entry in exclusions:
            print(f"Excluded Thorium patch by security policy: {entry}", file=sys.stderr)
        else:
            sys.stdout.write(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

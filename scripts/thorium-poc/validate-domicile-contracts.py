#!/usr/bin/env python3
"""Validate security-sensitive Domicile contracts in an applied Chromium tree."""

import argparse
import re
from pathlib import Path


def require_file(root: Path, relative_path: str) -> str:
    path = root / relative_path
    if not path.is_file():
        raise SystemExit(f"missing required Domicile source file: {relative_path}")
    return path.read_text()


def require_match(source: str, pattern: str, message: str) -> None:
    if re.search(pattern, source, re.DOTALL) is None:
        raise SystemExit(message)


def require_shell_binder(source: str, interface: str) -> None:
    registration = f"map->Add<domicile::mojom::{interface}>"
    start = source.find(registration)
    if start < 0:
        raise SystemExit(f"missing Domicile binder: {interface}")

    remaining = source[start + len(registration) :]
    next_registration = re.search(r"map->Add<domicile::mojom::\w+>", remaining)
    end = start + len(registration) + (
        next_registration.start() if next_registration is not None else len(remaining)
    )
    binder = source[start:end]
    require_match(
        binder,
        r"if\s*\(!domicile::IsShellOrigin\(frame->GetLastCommittedOrigin\(\)\)\)\s*\{(?:\s|//[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)*mojo::ReportBadMessage\([\s\S]*?\);(?:\s|//[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)*return;",
        f"Domicile binder {interface} must require the shell origin",
    )


def validate(root: Path) -> None:
    schemes = require_file(root, "chrome/common/chrome_content_client.cc")
    require_match(
        schemes,
        r"schemes->standard_schemes\.push_back\(domicile::kDomicileScheme\);",
        "missing standard domicile scheme registration",
    )
    require_match(
        schemes,
        r"schemes->secure_schemes\.push_back\(domicile::kDomicileScheme\);",
        "missing secure domicile scheme registration",
    )
    if re.search(
        r"schemes->(?:web_safe_schemes|cors_enabled_schemes)\.push_back\(\s*domicile::kDomicileScheme\s*\)",
        schemes,
        re.DOTALL,
    ):
        raise SystemExit("Domicile must not be registered as web-safe or CORS-enabled")

    startup = require_file(root, "chrome/browser/ui/startup/startup_browser_creator.cc")
    require_match(
        startup,
        r"MaybeLaunchAppShortcutWindow[\s\S]*?policy->IsWebSafeScheme\(url\.GetScheme\(\)\)[\s\S]*?url\.SchemeIs\(url::kFileScheme\)[\s\S]*?url\.SchemeIs\(domicile::kDomicileScheme\)",
        "missing trusted command-line domicile launch exception",
    )
    url_util = require_file(root, "chrome/browser/ui/startup/url_util.cc")
    require_match(
        url_util,
        r"bool ValidateLaunchUrlWebUnsafe\(const GURL& url\)[\s\S]*?const bool url_scheme_is_domicile\s*=\s*url\.SchemeIs\(domicile::kDomicileScheme\);[\s\S]*?return[^;]*url_scheme_is_domicile",
        "missing domicile launch URL validation exception",
    )

    binders = require_file(root, "chrome/browser/chrome_browser_interface_binders.cc")
    for interface in (
        "ControlChannel",
        "WebViewGuestHost",
        "ExtensionTray",
        "BrowserWindows",
        "CastSinks",
        "ShellFetch",
        "Downloads",
    ):
        require_shell_binder(binders, interface)

    shell_origin = require_file(root, "components/domicile/browser/shell_origin.cc")
    require_match(
        shell_origin,
        r"origin\.scheme\(\)\s*==\s*kDomicileScheme\s*&&\s*origin\.host\(\)\s*==\s*kDomicileShellHost",
        "shell origin must require the domicile scheme and shell host",
    )

    features = require_file(
        root, "third_party/blink/renderer/platform/runtime_enabled_features.json5"
    )
    external_surface = re.search(
        r'name:\s*"DomicileExternalSurface"(?P<properties>[^}]*)\}',
        features,
        re.DOTALL,
    )
    if (
        external_surface is None
        or re.search(
            r'origin_trial_feature_name:\s*"DomicileExternalSurface"',
            external_surface.group("properties"),
        )
        is None
        or re.search(r"\bstatus\s*:", external_surface.group("properties"))
        is not None
    ):
        raise SystemExit("DomicileExternalSurface must be an origin-trial-only feature")

    require_match(
        features,
        r'name:\s*"DomicileControlChannel"[^}]*status:\s*"stable"',
        "missing stable DomicileControlChannel feature",
    )

    tags = require_file(root, "third_party/blink/renderer/core/html/html_tag_names.json5")
    for name, interface in (("app", "HTMLAppElement"), ("webview", "HTMLWebViewElement")):
        require_match(
            tags,
            rf'name:\s*"{name}"[^}}]*interfaceName:\s*"{interface}"',
            f"missing Domicile {name} element tag",
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    arguments = parser.parse_args()
    validate(arguments.root)
    print("PASS: applied Domicile scheme, launch, shell-origin, feature, and element contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

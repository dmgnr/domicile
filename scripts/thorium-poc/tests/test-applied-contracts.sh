#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VALIDATOR="$ROOT/scripts/thorium-poc/validate-domicile-contracts.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

write_fixture() {
  local source_root="$1"
  mkdir -p \
    "$source_root/chrome/common" \
    "$source_root/chrome/browser/ui/startup" \
    "$source_root/chrome/browser" \
    "$source_root/components/domicile/browser" \
    "$source_root/third_party/blink/renderer/platform" \
    "$source_root/third_party/blink/renderer/core/html"

  cat > "$source_root/chrome/common/chrome_content_client.cc" <<'SOURCE'
schemes->standard_schemes.push_back(domicile::kDomicileScheme);
schemes->secure_schemes.push_back(domicile::kDomicileScheme);
SOURCE
  cat > "$source_root/chrome/browser/ui/startup/startup_browser_creator.cc" <<'SOURCE'
bool MaybeLaunchAppShortcutWindow() {
if (policy->IsWebSafeScheme(url.GetScheme()) ||
    url.SchemeIs(url::kFileScheme) ||
    url.SchemeIs(domicile::kDomicileScheme)) {
  return true;
}
}
SOURCE
  cat > "$source_root/chrome/browser/ui/startup/url_util.cc" <<'SOURCE'
bool ValidateLaunchUrlWebUnsafe(const GURL& url) {
  const bool url_scheme_is_domicile =
      url.SchemeIs(domicile::kDomicileScheme);
  return url_scheme_is_domicile || IsWebSafeScheme(url.scheme());
}
SOURCE
  cat > "$source_root/chrome/browser/chrome_browser_interface_binders.cc" <<'SOURCE'
void BindShellOnlyInterfaces() {
  if (!domicile::IsShellOrigin(frame->GetLastCommittedOrigin())) {
    mojo::ReportBadMessage("only the shell may bind this interface");
    return;
  }
}
void BindShellOnlyInterfaces() {
  if (!domicile::IsShellOrigin(frame->GetLastCommittedOrigin())) {
    mojo::ReportBadMessage("only the shell may bind this interface");
    return;
  }
}
void BindShellOnlyInterfaces() {
  if (!domicile::IsShellOrigin(frame->GetLastCommittedOrigin())) {
    mojo::ReportBadMessage("only the shell may bind this interface");
    return;
  }
}
void BindShellOnlyInterfaces() {
  if (!domicile::IsShellOrigin(frame->GetLastCommittedOrigin())) {
    mojo::ReportBadMessage("only the shell may bind this interface");
    return;
  }
}
SOURCE
  cat > "$source_root/components/domicile/browser/shell_origin.cc" <<'SOURCE'
return origin.scheme() == kDomicileScheme &&
       origin.host() == kDomicileShellHost;
SOURCE
  cat > "$source_root/third_party/blink/renderer/platform/runtime_enabled_features.json5" <<'SOURCE'
{ name: "DomicileExternalSurface", status: "stable" }
{ name: "DomicileControlChannel", status: "stable" }
SOURCE
  cat > "$source_root/third_party/blink/renderer/core/html/html_tag_names.json5" <<'SOURCE'
{ name: "app", interfaceName: "HTMLAppElement" }
{ name: "webview", interfaceName: "HTMLWebViewElement" }
SOURCE
}

expect_valid() {
  local source_root="$1"
  python3 "$VALIDATOR" --root "$source_root" || fail "valid Domicile source contracts were rejected"
}

expect_invalid() {
  local source_root="$1"
  local expected="$2"
  local output="$TMP/validator.log"
  if python3 "$VALIDATOR" --root "$source_root" > "$output" 2>&1; then
    fail "invalid Domicile source contracts unexpectedly passed"
  fi
  grep -Fq "$expected" "$output" || fail "missing validator diagnostic '$expected': $(cat "$output")"
}

write_fixture "$TMP/valid"
expect_valid "$TMP/valid"

cp -a "$TMP/valid" "$TMP/missing-secure-scheme"
sed -i '/secure_schemes/d' "$TMP/missing-secure-scheme/chrome/common/chrome_content_client.cc"
expect_invalid "$TMP/missing-secure-scheme" "missing secure domicile scheme registration"

cp -a "$TMP/valid" "$TMP/missing-standard-scheme"
sed -i '/standard_schemes/d' "$TMP/missing-standard-scheme/chrome/common/chrome_content_client.cc"
expect_invalid "$TMP/missing-standard-scheme" "missing standard domicile scheme registration"

cp -a "$TMP/valid" "$TMP/cors-enabled"
echo 'schemes->cors_enabled_schemes.push_back(domicile::kDomicileScheme);' >> "$TMP/cors-enabled/chrome/common/chrome_content_client.cc"
expect_invalid "$TMP/cors-enabled" "Domicile must not be registered as web-safe or CORS-enabled"

cp -a "$TMP/valid" "$TMP/web-safe"
echo 'schemes->web_safe_schemes.push_back(domicile::kDomicileScheme);' >> "$TMP/web-safe/chrome/common/chrome_content_client.cc"
expect_invalid "$TMP/web-safe" "Domicile must not be registered as web-safe or CORS-enabled"

cp -a "$TMP/valid" "$TMP/untrusted-launch"
sed -i '/url.SchemeIs(domicile::kDomicileScheme)/d' "$TMP/untrusted-launch/chrome/browser/ui/startup/startup_browser_creator.cc"
expect_invalid "$TMP/untrusted-launch" "missing trusted command-line domicile launch exception"

cp -a "$TMP/valid" "$TMP/unvalidated-launch"
sed -i '/url_scheme_is_domicile/d' "$TMP/unvalidated-launch/chrome/browser/ui/startup/url_util.cc"
expect_invalid "$TMP/unvalidated-launch" "missing domicile launch URL validation exception"

cp -a "$TMP/valid" "$TMP/untrusted-binder"
sed -i '0,/IsShellOrigin/s/IsShellOrigin/IsAnyOrigin/' "$TMP/untrusted-binder/chrome/browser/chrome_browser_interface_binders.cc"
expect_invalid "$TMP/untrusted-binder" "expected four shell-origin guarded binders"

cp -a "$TMP/valid" "$TMP/wrong-shell-origin"
sed -i 's/origin.host() == kDomicileShellHost/origin.host() == kAnyHost/' "$TMP/wrong-shell-origin/components/domicile/browser/shell_origin.cc"
expect_invalid "$TMP/wrong-shell-origin" "shell origin must require the domicile scheme and shell host"

cp -a "$TMP/valid" "$TMP/missing-control-channel"
sed -i '/DomicileControlChannel/d' "$TMP/missing-control-channel/third_party/blink/renderer/platform/runtime_enabled_features.json5"
expect_invalid "$TMP/missing-control-channel" "missing stable DomicileControlChannel feature"

cp -a "$TMP/valid" "$TMP/missing-external-surface"
sed -i '/DomicileExternalSurface/d' "$TMP/missing-external-surface/third_party/blink/renderer/platform/runtime_enabled_features.json5"
expect_invalid "$TMP/missing-external-surface" "missing stable DomicileExternalSurface feature"

cp -a "$TMP/valid" "$TMP/missing-elements"
sed -i '/name: "webview"/d' "$TMP/missing-elements/third_party/blink/renderer/core/html/html_tag_names.json5"
expect_invalid "$TMP/missing-elements" "missing Domicile webview element tag"

cp -a "$TMP/valid" "$TMP/missing-app-element"
sed -i '/name: "app"/d' "$TMP/missing-app-element/third_party/blink/renderer/core/html/html_tag_names.json5"
expect_invalid "$TMP/missing-app-element" "missing Domicile app element tag"

echo "Applied Domicile source contract tests passed"

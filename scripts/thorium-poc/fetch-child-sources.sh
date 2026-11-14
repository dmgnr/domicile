#!/usr/bin/env bash
set -euo pipefail

ROOT=""
MANIFEST=""
while (($# > 0)); do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$ROOT/.git" || -f "$ROOT/.git" ]] || { echo "Chromium source is not a Git checkout: $ROOT" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "child source manifest is missing: $MANIFEST" >&2; exit 1; }

while IFS=$'\t' read -r path url revision sparse_paths || [[ -n "$path$url$revision$sparse_paths" ]]; do
  [[ -z "$path" ]] && continue
  [[ -n "$url" && -n "$revision" && -n "$sparse_paths" ]] || { echo "invalid child source manifest row: $path" >&2; exit 1; }
  target="$ROOT/$path"
  parent="$(dirname "$target")"
  mkdir -p "$parent"
  staging="$(mktemp -d "$parent/.child-source.XXXXXX")"
  git -C "$staging" init -q
  git -C "$staging" remote add origin "$url"
  git -C "$staging" config extensions.partialClone origin
  git -C "$staging" config remote.origin.promisor true
  git -C "$staging" config remote.origin.partialclonefilter blob:none
  read -r -a sparse_patterns <<< "$sparse_paths"
  if git -C "$staging" fetch --filter=blob:none --depth 1 origin "$revision" && \
    git -C "$staging" config core.sparseCheckout true && \
    git -C "$staging" config core.sparseCheckoutCone false && \
    printf '%s\n' "${sparse_patterns[@]}" > "$staging/.git/info/sparse-checkout" && \
    git -C "$staging" checkout --detach FETCH_HEAD; then
    actual="$(git -C "$staging" rev-parse HEAD)"
    if [[ "$actual" != "$revision" ]]; then
      echo "child source revision mismatch at $path: found $actual, expected $revision" >&2
      exit 1
    fi
  else
    echo "child source revision fetch failed: $path @ $revision from $url" >&2
    exit 1
  fi
  if [[ -e "$target" ]]; then
    if [[ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      echo "child source target is not empty: $target" >&2
      exit 1
    fi
    rmdir "$target"
  fi
  mv "$staging" "$target"
  echo "Fetched child source $path @ $actual"
done < "$MANIFEST"

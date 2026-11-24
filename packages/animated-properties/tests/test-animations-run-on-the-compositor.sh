#!/usr/bin/env bash
# Fails on a transition or keyframe that animates a property off the
# compositor. See the package README.
set -euo pipefail
cd "$(dirname "$0")/../../.."
bun packages/animated-properties/src/check.ts

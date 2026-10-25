#!/usr/bin/env bash
# Project-level verification gate. Project rules may add their own checks;
# the engine guarantees the manifest, the generated copies and the doctor.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

status=0

if ! npm run manifest:check; then
  status=1
fi

if ! node core/dist/bin/ai-hub.js doctor; then
  status=1
fi

exit "$status"

#!/usr/bin/env bash
# Project-level checks for the angular-express preset.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
status=0
for rule in .ai-hub/harness/rules/*.sh; do
  [ -f "$rule" ] || continue
  if ! bash "$rule"; then
    status=1
  fi
done
exit "$status"

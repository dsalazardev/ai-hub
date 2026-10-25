#!/usr/bin/env bash
# Regla: No-Legacy-Directives — Prohibido *ngIf, *ngFor, *ngSwitch (usar @if, @for, @switch)
# Nivel: L2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

violations=$(grep -rn "\*ngIf\|\*ngFor\|\*ngSwitch" \
  --include='*.html' \
  "$PROJECT_ROOT/frontend/src" \
  2>/dev/null || true)

if [[ -n "$violations" ]]; then
  echo "[FAIL] no-legacy-directives"
  echo "$violations"
  exit 1
fi
echo "[OK]   no-legacy-directives"
exit 0

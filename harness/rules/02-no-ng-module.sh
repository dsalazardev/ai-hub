#!/usr/bin/env bash
# Regla: No-NgModule — Prohibido @NgModule en componentes Angular
# Nivel: L2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

violations=$(grep -rn "@NgModule\|NgModule({" \
  --include='*.ts' \
  "$PROJECT_ROOT/frontend/src" \
  2>/dev/null || true)

if [[ -n "$violations" ]]; then
  echo "[FAIL] no-ng-module"
  echo "$violations"
  exit 1
fi
echo "[OK]   no-ng-module"
exit 0

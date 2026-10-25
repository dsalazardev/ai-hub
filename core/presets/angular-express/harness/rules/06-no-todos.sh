#!/usr/bin/env bash
# Regla: No-TODOs — Prohibidos TODO en codigo de produccion (excepto TODO(test))
# Nivel: L2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

violations=$(grep -rPn "\bTODO\b(?!\(test\))" \
  --include='*.ts' \
  "$PROJECT_ROOT/frontend/src" \
  "$PROJECT_ROOT/backend/src" \
  2>/dev/null | grep -v "\.spec\.ts\|\.test\.ts" || true)

if [[ -n "$violations" ]]; then
  echo "[FAIL] no-todos"
  echo "$violations"
  exit 1
fi
echo "[OK]   no-todos"
exit 0

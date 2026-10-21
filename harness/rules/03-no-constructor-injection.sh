#!/usr/bin/env bash
# Regla: No-Constructor-Injection — Solo inject() permitido, no DI via constructor
# Nivel: L2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

violations=$(grep -rPn "constructor\s*\([^)]*(?:private|public|protected|readonly)\s+\w" \
  --include='*.ts' \
  "$PROJECT_ROOT/frontend/src" \
  2>/dev/null | grep -v "\.spec\.ts\|\.test\.ts" || true)

if [[ -n "$violations" ]]; then
  echo "[FAIL] no-constructor-injection"
  echo "$violations"
  exit 1
fi
echo "[OK]   no-constructor-injection"
exit 0

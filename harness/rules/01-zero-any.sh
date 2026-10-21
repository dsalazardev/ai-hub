#!/usr/bin/env bash
# Regla: Zero-Any — Prohibido `: any` en archivos TypeScript (excepto tests)
# Nivel: L2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

violations=$(grep -rn ": any\b" \
  --include='*.ts' \
  "$PROJECT_ROOT/frontend/src" \
  "$PROJECT_ROOT/backend/src" \
  2>/dev/null | grep -v "\.spec\.ts\|\.test\.ts" || true)

if [[ -n "$violations" ]]; then
  count=$(echo "$violations" | wc -l | tr -d ' ')
  printf '\033[0;33m[WARN]\033[0m  zero-any — %s ocurrencia(s) de '\'': any'\'' detectada(s).\n' "$count"
  printf '       Se permite por excepciones validas (DALs, catch blocks), pero es una mala practica.\n'
  printf '       Debe resolverse progresivamente. Usa '\''unknown'\'' con type guards donde sea posible.\n'
  echo "$violations"
  exit 0
fi
echo "[OK]   zero-any"
exit 0

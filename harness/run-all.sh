#!/usr/bin/env bash
# .ai-hub/harness/run-all.sh
# Runner orquestador del Harness Nivel 2 — descubre y ejecuta todos los scripts de rules/

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_RULES_DIR="$SCRIPT_DIR/rules"

TOTAL=0
FAIL_COUNT=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Caso: directorio rules/ vacio o inexistente
if [[ ! -d "$HARNESS_RULES_DIR" ]] || [[ -z "$(LC_ALL=C ls "$HARNESS_RULES_DIR"/*.sh 2>/dev/null)" ]]; then
  printf "${YELLOW}[WARN]${NC}  No hay reglas en .ai-hub/harness/rules/\n"
  exit 0
fi

for f in $(LC_ALL=C ls "$HARNESS_RULES_DIR"/*.sh | sort); do
  TOTAL=$((TOTAL + 1))
  if ! bash "$f"; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo ""
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  printf "${GREEN}[OK]${NC}    %d/%d reglas pasaron\n" "$TOTAL" "$TOTAL"
  exit 0
else
  PASS_COUNT=$((TOTAL - FAIL_COUNT))
  printf "${RED}[FAIL]${NC}  %d/%d reglas fallaron (%d/%d pasaron)\n" "$FAIL_COUNT" "$TOTAL" "$PASS_COUNT" "$TOTAL"
  exit 1
fi

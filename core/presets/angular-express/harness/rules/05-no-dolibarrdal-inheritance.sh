#!/usr/bin/env bash
# Regla: No-DolibarrDal-Inheritance — Herencia de DolibarrDal solo en infrastructure/dal/dolibarr/
# Nivel: L2
#
# G2: Los DALs segregados (uno por endpoint) DEBEN heredar de DolibarrDal para acceder a helpers
#     protegidos (combineSqlFilters, mapFiltersFromDomain, this.dolibarr.*). Esto es correcto.
# Prohibido: heredar de DolibarrDal fuera de infrastructure/dal/dolibarr/ (services, routes, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

violations=$(grep -rn "extends DolibarrDal" \
  --include='*.ts' \
  "$PROJECT_ROOT/backend/src" \
  2>/dev/null | grep -v "infrastructure/dal/dolibarr/" || true)

if [[ -n "$violations" ]]; then
  echo "[FAIL] no-dolibarrdal-inheritance"
  echo "$violations"
  exit 1
fi
echo "[OK]   no-dolibarrdal-inheritance"
exit 0

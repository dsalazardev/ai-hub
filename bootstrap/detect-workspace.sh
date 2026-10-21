#!/usr/bin/env bash
# .ai-hub/bootstrap/detect-workspace.sh
# Detecta si el desarrollador abrió el monorepo root, /frontend, o /backend
# Exporta variables de entorno para que el orchestrator cargue los skills correctos

set -e

# Detectar directorio de trabajo actual
CURRENT_DIR=$(pwd)
CURRENT_NAME=$(basename "$CURRENT_DIR")

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Workspace Detection"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Función para encontrar la raíz del repo (donde existe AGENTS.md)
find_repo_root() {
  local dir="$CURRENT_DIR"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/AGENTS.md" ]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  echo ""
}

REPO_ROOT=$(find_repo_root)

if [ -z "$REPO_ROOT" ]; then
  echo "[ERROR] No se encontró la raíz del repositorio"
  echo "        Asegúrate de que existe AGENTS.md en algún directorio padre"
  exit 1
fi

# Detectar tipo de workspace
WORKSPACE_TYPE=""
RELATIVE_PATH=$(python3 -c "import os.path; print(os.path.relpath('${CURRENT_DIR}', '${REPO_ROOT}'))" 2>/dev/null || echo "$CURRENT_NAME")

case "$RELATIVE_PATH" in
  "frontend"|"frontend/"|"./frontend"|"./frontend/")
    WORKSPACE_TYPE="frontend"
    ;;
  "backend"|"backend/"|"./backend"|"./backend/")
    WORKSPACE_TYPE="backend"
    ;;
  "."|"./"|"")
    WORKSPACE_TYPE="root"
    ;;
  *)
    WORKSPACE_TYPE="subdirectory"
    ;;
esac

# Determinar qué skills cargar
SKILL_PATHS=""
case "$WORKSPACE_TYPE" in
  "root")
    SKILL_PATHS=".ai-hub/skills/shared"
    echo "[OK] Workspace: ROOT (monorepo completo)"
    echo "     Skills cargados: shared (todos)"
    ;;
  "frontend")
    SKILL_PATHS=".ai-hub/skills/shared:${REPO_ROOT}/.ai-hub/skills/shared"
    echo "[OK] Workspace: FRONTEND"
    echo "     Skills cargados: shared + frontend-specific"
    ;;
  "backend")
    SKILL_PATHS=".ai-hub/skills/shared:${REPO_ROOT}/.ai-hub/skills/shared"
    echo "[OK] Workspace: BACKEND"
    echo "     Skills cargados: shared + backend-specific"
    ;;
  "subdirectory")
    SKILL_PATHS="${REPO_ROOT}/.ai-hub/skills/shared"
    echo "[OK] Workspace: SUBDIRECTORIO (${RELATIVE_PATH})"
    echo "     Skills cargados: shared (desde root)"
    ;;
esac

# Exportar variables (formato compatible con bash source)
echo ""
echo "── Variables exportadas ────────────────────────────────────────"
echo "export AI_HUB_WORKSPACE_TYPE=\"${WORKSPACE_TYPE}\""
echo "export AI_HUB_REPO_ROOT=\"${REPO_ROOT}\""
echo "export AI_HUB_SKILL_PATHS=\"${SKILL_PATHS}\""
echo "export AI_HUB_CURRENT_DIR=\"${CURRENT_DIR}\""

# También exportar para el proceso actual
export AI_HUB_WORKSPACE_TYPE="${WORKSPACE_TYPE}"
export AI_HUB_REPO_ROOT="${REPO_ROOT}"
export AI_HUB_SKILL_PATHS="${SKILL_PATHS}"
export AI_HUB_CURRENT_DIR="${CURRENT_DIR}"

echo ""
echo "═══════════════════════════════════════════════════════════════"

# Si se ejecuta con 'source', las variables quedan en el shell
# Si se ejecuta directamente, solo se muestran

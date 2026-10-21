#!/usr/bin/env bash
# .ai-hub/bootstrap/install-planning-skill.sh
# Instala la skill planning-with-files localmente en .ai-hub/skills/shared/
# No requiere instalación global — cualquier desarrollador puede ejecutar este script

set -e

SKILL_NAME="planning-with-files"
SKILL_URL="https://github.com/othmanadi/planning-with-files"
TARGET_DIR=".ai-hub/skills/shared/${SKILL_NAME}"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Instalando ${SKILL_NAME}"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Verificar que estamos en el root del repo
if [ ! -f "AGENTS.md" ]; then
  echo "[ERROR] Debes ejecutar este script desde la raíz del repositorio"
  echo "        Asegúrate de que existe AGENTS.md en el directorio actual"
  exit 1
fi

# Crear directorio destino si no existe
mkdir -p "${TARGET_DIR}"

# Verificar si ya está instalada
if [ -f "${TARGET_DIR}/SKILL.md" ]; then
  echo "[OK] ${SKILL_NAME} ya está instalada en ${TARGET_DIR}"
  echo ""
  exit 0
fi

# Intentar instalar via npx skills CLI (si está disponible)
if command -v npx >/dev/null 2>&1; then
  echo "[INFO] Intentando instalar via npx skills..."
  if npx skills add "${SKILL_URL}" --skill "${SKILL_NAME}" --local 2>/dev/null; then
    echo "[OK] Instalada via npx skills"
    echo ""
    exit 0
  else
    echo "[WARN] npx skills no disponible o falló, usando fallback git clone"
  fi
else
  echo "[INFO] npx no disponible, usando fallback git clone"
fi

# Fallback: clonar manualmente con git
if command -v git >/dev/null 2>&1; then
  echo "[INFO] Clonando desde ${SKILL_URL}..."
  
  TEMP_DIR=$(mktemp -d)
  git clone --depth 1 "${SKILL_URL}" "${TEMP_DIR}" 2>/dev/null || {
    echo "[ERROR] No se pudo clonar el repositorio"
    echo "        Verifica tu conexión a internet o instala la skill manualmente:"
    echo "        git clone ${SKILL_URL} ${TARGET_DIR}"
    rm -rf "${TEMP_DIR}"
    exit 1
  }
  
  # Copiar archivos
  cp -r "${TEMP_DIR}"/* "${TARGET_DIR}/"
  rm -rf "${TEMP_DIR}"
  
  echo "[OK] ${SKILL_NAME} instalada en ${TARGET_DIR}"
else
  echo "[ERROR] git no está instalado y npx no está disponible"
  echo "        Instala git o descarga la skill manualmente:"
  echo "        ${SKILL_URL}"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"

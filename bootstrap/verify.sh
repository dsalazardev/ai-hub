#!/usr/bin/env bash
# .ai-hub/bootstrap/verify.sh
# Equivalente a init.sh de BettaTech pero para stack Angular + Node.js
# Este script verifica que el entorno está listo para trabajar con el AI Hub

set -u

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok() { printf "${GREEN}[OK]${NC}    %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC}  %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC}  %s\n" "$1"; }

EXIT_CODE=0

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  AI Hub 2.0 — Environment Verification"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Verificando entorno ──────────────────────────────────────
echo "── 1. Verificando entorno ──────────────────────────────────────"

# Node.js
if ! command -v node >/dev/null 2>&1; then
  fail "node no está instalado"; EXIT_CODE=1
else
  ok "node -> $(node --version)"
fi

# npm
if ! command -v npm >/dev/null 2>&1; then
  fail "npm no está instalado"; EXIT_CODE=1
else
  ok "npm -> $(npm --version)"
fi

# Docker
if ! command -v docker >/dev/null 2>&1; then
  warn "docker no está instalado"
else
  ok "docker disponible"
fi

# Docker Compose
if ! command -v docker-compose >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
  warn "docker compose no está disponible"
else
  ok "docker compose disponible"
fi

# Git
if ! command -v git >/dev/null 2>&1; then
  warn "git no está instalado"
else
  ok "git -> $(git --version | head -1)"
fi

# AI Hub CLI compilado
if ! test -f .ai-hub/core/dist/bin/ai-hub.js; then
  warn "Falta .ai-hub/core/dist: ejecuta npm run ai:setup"
else
  ok "AI Hub CLI compilado"
fi

echo ""

# ── 2. Verificando archivos base del .ai-hub/ ───────────────────
echo "── 2. Verificando archivos base del .ai-hub/ ───────────────────"

for f in AGENTS.md .ai-hub/manifest.yaml .ai-hub/orchestrator/PROMPT.md .ai-hub/README.md; do
  if [ ! -f "$f" ]; then
    fail "Falta archivo base: $f"; EXIT_CODE=1
  else
    ok "Existe $f"
  fi
done

echo ""

# ── 3. Copias generadas sincronizadas ───────────────────────────
echo "── 3. Copias generadas sincronizadas ───────────────────────────"

if ! test -f .ai-hub/core/dist/bin/ai-hub.js; then
  warn "No se puede comprobar sin .ai-hub/core/dist: ejecuta npm run ai:setup"
elif node .ai-hub/core/dist/bin/ai-hub.js sync --check; then
  ok "Skills, agentes y reglas de cada herramienta al día con .ai-hub/"
else
  fail "Copias generadas desactualizadas o editadas a mano (ver arriba)"; EXIT_CODE=1
fi

echo ""

# ── 4. Verificando build frontend ───────────────────────────────
echo "── 4. Verificando build frontend ───────────────────────────────"

if [ -d "frontend" ]; then
  if (cd frontend && npx --no-install ng build --configuration development >/dev/null 2>&1); then
    ok "Frontend build exitoso"
  else
    fail "Frontend build falló"; EXIT_CODE=1
  fi
else
  warn "Directorio frontend/ no encontrado"
fi

echo ""

# ── 5. Verificando build backend ────────────────────────────────
echo "── 5. Verificando build backend ────────────────────────────────"

if [ -d "backend" ]; then
  TSC_OUTPUT=$(cd backend && npx tsc --noEmit --project tsconfig.json 2>&1)
  SRC_ERRORS=$(echo "$TSC_OUTPUT" | grep -v "tests/" | grep -c "error TS" || true)
  TEST_ERRORS=$(echo "$TSC_OUTPUT" | grep "tests/" | grep -c "error TS" || true)

  if [ "$SRC_ERRORS" -eq 0 ]; then
    ok "Backend TypeScript compila (src/)"
    if [ "$TEST_ERRORS" -gt 0 ]; then
      warn "Errores encontrados solo en tests/ ($TEST_ERRORS errores pre-existentes)"
    fi
  else
    fail "Backend TypeScript tiene errores en src/ ($SRC_ERRORS errores)"; EXIT_CODE=1
  fi
else
  warn "Directorio backend/ no encontrado"
fi

echo ""

# ── 6. Verificando planning skill ───────────────────────────────
echo "── 6. Verificando planning skill ───────────────────────────────"

if [ -d ".ai-hub/skills/shared/planning-with-files" ]; then
  ok "planning-with-files skill instalada"
elif [ -d ".agents/skills/planning-with-files" ]; then
  warn "planning-with-files existe en .agents/ (legacy)"
  warn "Ejecuta .ai-hub/bootstrap/install-planning-skill.sh"
else
  warn "planning-with-files no instalada"
  warn "Ejecuta .ai-hub/bootstrap/install-planning-skill.sh"
fi

echo ""

# ── 7. Validando convenciones de código (Nivel 2 harness) ──────────────────
echo "── 7. Validando convenciones de código (Nivel 2 harness) ──────────────────"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_RUNNER="$SCRIPT_DIR/../harness/run-all.sh"

if [[ -f "$HARNESS_RUNNER" ]]; then
  RULE_COUNT=$(LC_ALL=C ls "$SCRIPT_DIR/../harness/rules/"*.sh 2>/dev/null | wc -l | tr -d ' ')
  if bash "$HARNESS_RUNNER"; then
    ok "Nivel 2 harness ($RULE_COUNT reglas)"
  else
    fail "Nivel 2 harness (ver output arriba)"; EXIT_CODE=1
  fi
else
  warn "Harness no instalado ($HARNESS_RUNNER no encontrado)"
fi

echo ""

# ── 8. Verificando CLI openspec ─────────────────────────────────
echo "── 8. Verificando CLI openspec ─────────────────────────────────"

if ! npx --no-install openspec --version >/dev/null 2>&1; then
  fail "openspec CLI no disponible en node_modules. Ejecuta npm ci en la raíz del repo"; EXIT_CODE=1
elif ! npx --no-install openspec --version 2>/dev/null | grep -qE "^1\.([3-9]|1[0-9])"; then
  fail "openspec version insuficiente (requiere >=1.3). Version actual: $(npx --no-install openspec --version 2>/dev/null)"; EXIT_CODE=1
elif ! npx --no-install openspec list --json 2>/dev/null | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  fail "openspec list --json no retorna JSON valido. Verifica openspec/changes/archive/"; EXIT_CODE=1
else
  ok "openspec CLI disponible ($(npx --no-install openspec --version 2>/dev/null))"
fi

echo ""

# ── 9. Verificando openspec/state.json ─────────────────────────
echo "── 9. Verificando openspec/state.json ─────────────────────────"

if ! test -f openspec/state.json; then
  fail "openspec/state.json no existe. Ejecuta el script de inicializacion del cambio ai-hub-v3-paths."; EXIT_CODE=1
elif ! python3 -c "import json,sys; d=json.load(open('openspec/state.json')); sys.exit(0 if d.get('version',0)>=3 else 1)" 2>/dev/null; then
  fail "openspec/state.json invalido o version < 3. Regenerar con el script T-04 de ai-hub-v3-paths."; EXIT_CODE=1
else
  VERSION=$(python3 -c "import json; print(json.load(open('openspec/state.json'))['version'])")
  ok "openspec/state.json valido (version=${VERSION})"
fi

echo ""

# ── 10. Verificando .planning/current.md ────────────────────────
echo "── 10. Verificando .planning/current.md ────────────────────────"

if ! test -s .planning/current.md; then
  warn "Sin sesion activa en .planning/current.md — crear desde template C de openspec/changes/ai-hub-v3-paths/design.md"
else
  ok ".planning/current.md presente"
fi

echo ""

# ── 11. Verificando credenciales IA (GitLab) ─────────────────────
echo "── 11. Verificando credenciales IA (GitLab) ────────────────────"

if [ -f ".ai-hub/.env" ]; then
  ok ".ai-hub/.env presente"
  if grep -qE "^GITLAB_TOKEN=.+" ".ai-hub/.env" 2>/dev/null; then
    ok "GITLAB_TOKEN configurado (no se muestra)"
  else
    warn "GITLAB_TOKEN vacío o ausente en .ai-hub/.env (skills GitLab sin credenciales)"
  fi
  if grep -qE "^GITLAB_URL=.+" ".ai-hub/.env" 2>/dev/null; then
    ok "GITLAB_URL configurado"
  else
    warn "GITLAB_URL ausente (se asumirá https://gitlab.v3.onnadigital.com)"
  fi
else
  warn ".ai-hub/.env no existe — copia .ai-hub/.env.example y complétalo para usar GitLab"
  warn "Referencia: .ai-hub/skills/shared/gitlab-auth/SKILL.md"
fi

echo ""

# ── 12. Resumen ─────────────────────────────────────────────────
echo "── 12. Resumen ─────────────────────────────────────────────────"

if [ $EXIT_CODE -eq 0 ]; then
  ok "Entorno listo. Puedes empezar a trabajar."
  echo ""
  echo "   Próximos pasos:"
  echo "   1. Revisa .ai-hub/README.md para entender la arquitectura"
  echo "   2. Edita las fuentes en .ai-hub/ y ejecuta npm run ai:sync"
  echo "   3. Empieza con: /opsx:explore o /opsx-explore"
else
  fail "Entorno NO está listo. Resuelve los errores antes de avanzar."
  echo ""
  echo "   Acciones recomendadas:"
  echo "   - Si las copias generadas no coinciden: npm run ai:sync"
  echo "   - Si falta planning: .ai-hub/bootstrap/install-planning-skill.sh"
  echo "   - Si hay errores de build: revisa frontend/ y backend/"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"

exit $EXIT_CODE

#!/usr/bin/env bash
# .ai-hub/bootstrap/load-env.sh
# Carga las credenciales locales de IA (.ai-hub/.env) en el shell actual.
# Uso: source .ai-hub/bootstrap/load-env.sh

if [ -n "${BASH_SOURCE[0]:-}" ]; then
  AI_HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
else
  AI_HUB_DIR="$(pwd)/.ai-hub"
fi

ENV_FILE="${AI_HUB_DIR}/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[ai-hub] No existe ${ENV_FILE}." >&2
  echo "[ai-hub] Copia .ai-hub/.env.example a .ai-hub/.env y complétalo (GITLAB_TOKEN)." >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

URL_STATE=$([ -n "${GITLAB_URL:-}" ] && echo "configurada" || echo "ausente")
TOKEN_STATE=$([ -n "${GITLAB_TOKEN:-}" ] && echo "configurado" || echo "ausente")
echo "[ai-hub] Variables de ${ENV_FILE} cargadas (GITLAB_URL: ${URL_STATE}; GITLAB_TOKEN: ${TOKEN_STATE})"

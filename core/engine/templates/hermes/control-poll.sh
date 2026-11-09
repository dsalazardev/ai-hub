#!/bin/sh
# ai-hub control poll (hermes-control). Lo instala `ai-hub control enroll` en
# <HERMES_HOME del perfil>/scripts/ y lo ejecuta un cron de Hermes sin agente:
#   hermes -p hermes-control cron create "every 15m" --name ai-hub-control-poll \
#     --no-agent --script control-poll.sh --deliver discord
# Su stdout es UN mensaje de Discord: el primer paso que tenga algo que decir, o nada.
# Sin credenciales: el token lo lee `ai-hub` de .ai-hub/.env dentro de su propio proceso.
set -eu
REPO='__AI_HUB_REPO__'
cd "$REPO"
# Espejo de solo lectura: se actualiza si es un clon git; un fallo no bloquea la propuesta.
git fetch --quiet --prune origin 2>/dev/null || true
for step in "apply --preapproved" "expire"; do
  out=$(npx --no-install ai-hub control $step 2>&1 || true)
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    exit 0
  fi
done
npx --no-install ai-hub control decide --online --format discord

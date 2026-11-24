#!/bin/sh
# ai-hub-managed: control-poll.sh v=2
# ai-hub control poll (hermes-control). Lo instala `ai-hub control enroll` en
# <HERMES_HOME del perfil>/scripts/ y lo ejecuta un cron de Hermes sin agente:
#   hermes -p hermes-control cron create "every 15m" --name <manifest.control.pollJob> \
#     --no-agent --script control-poll.sh --deliver discord
# Su stdout es UN mensaje de Discord (aviso de caída, de recuperación o una decisión), o nada.
# `control poll` separa lectura, decisión y escritura, y guarda su salud en .ai-hub/runs/health.json.
# Sin credenciales: el token lo lee `ai-hub` de .ai-hub/.env dentro de su propio proceso.
# Este archivo lo gestiona AI-Hub: `enroll --yes` lo sustituye (con copia) cuando hay una versión nueva.
# Si quieres mantener tu propia versión, quita la línea `ai-hub-managed` y enroll no la tocará.
set -eu
REPO='__AI_HUB_REPO__'
cd "$REPO"
# Espejo de solo lectura: se actualiza si es un clon git; un fallo no bloquea el poll.
git fetch --quiet --prune origin 2>/dev/null || true
exec npx --no-install ai-hub control poll

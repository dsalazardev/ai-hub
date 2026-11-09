#!/bin/sh
# ai-hub GitLab route (hermes-control, fase 2). Lo instala `ai-hub control enroll` en
# <HERMES_HOME del perfil>/scripts/ y lo usa la ruta del webhook, sin agente:
#   hermes -p hermes-control webhook subscribe ai-hub-gitlab --events "Issue Hook,Merge Request Hook" \
#     --script gitlab-route.sh --prompt "{script_output}" --deliver discord --deliver-only
# Hermes comprueba X-Gitlab-Token y pasa el payload por stdin. Un stdout vacío descarta el evento;
# si hay decisión nueva, su texto es el mensaje de Discord. Sin credenciales en este archivo.
set -eu
cd '__AI_HUB_REPO__'
exec npx --no-install ai-hub control ingest --format discord

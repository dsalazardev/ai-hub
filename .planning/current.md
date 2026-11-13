# Estado de la sesión — channel-types y webhook-operativo aplicados y archivados — 2026-11-12

**Changes activos:** ninguno. Archivados hoy: `2026-11-12-channel-types` (3/3) y `2026-11-12-webhook-operativo` (30/30).
**Versión:** 0.15.0 publicada; el release siguiente (versión, CHANGELOG, `release.test.ts`, `install-counts.json`) es del
propietario, con la entrada preparada en `archive/2026-11-12-webhook-operativo/design.md` §D10.

## Cerrado

- channel-types: un id de categoría o de voz se rechaza; un 200 sin `type` se acepta como antes (D-D).
- webhook-operativo: bloque `platforms.webhook` en el `config.yaml` del dueño del listener, `--webhook-owner`,
  aviso de reinicio compartido, `GET /health`, migración del `.env`, ningún secreto escrito, `doctor` con
  `control:webhook`. Detalle de pruebas rojas/verdes y aserciones cambiadas en `impl_webhook-operativo.md`.
- Verificación: typecheck, build y manifest:check en verde; `npm test` 55/55 archivos, 870 pasadas, 6 omitidas
  (1358,71 s, WSL apagado); doctor sano; drift y `sync --check-lock` no aplican en el taller.

## Los tres choques de webhook-operativo con specs vigentes, y su resolución

1. Sin gateway instalado (contradecía «No gateway installed»): D-A, webhook no verificable, salida 0.
2. `--check` sin gateway (contradecía «Gateway not verifiable»): D-A, gateway y webhook no verificables, salida 0.
3. Orden de etapas (cron después de la ruta): D-B, cron y `control-poll.sh` antes del webhook; R5 adaptado y declarado.

## Registro de hallazgos

- En una ronda anterior `findings.md` se restauró desde HEAD para dejar `git status` vacío, porque está versionado
  aunque `.planning/` figure en `.gitignore`; el propietario acepta el árbol sucio y no debe repetirse.
- La fuente de los hallazgos de estas rondas es el `design.md` de `webhook-operativo` (ahora archivado).

## Abierto (decide el propietario)

- `openspec/specs/hermes-control/spec.md` › «Enroll check verifies the whole profile read-only»: 536 caracteres tras
  el archivado; `validate --strict` de esa spec pasa de verde a aviso. Propuesta: mover la frase del webhook a un
  escenario. Las otras specs con avisos de longitud (control-onboarding, dev-cli, agent-guardrails, preset-system,
  spec-kit-pipeline) ya los tenían.
- `hermesHome()` no respeta `HERMES_HOME`; solo el check `control:webhook` de `doctor` lo hace.
- Release (0.16.0 o la que decida) y prueba real con Hermes y GitLab.

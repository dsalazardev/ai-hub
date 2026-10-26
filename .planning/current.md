# Estado de sesión — install-completo

- Fecha: 2026-10-26
- Cambio: `install-completo` **archivado**
- Fase: archivado
- Progreso tracked: **26/26 tareas** y **4/4 artefactos**
- Repo: `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\DESARROLLO\ai-hub`
- Archivo: `openspec/changes/archive/2026-10-26-install-completo/`

## Resultado

La instalación completa está implementada y verificada:

- `init --yes` entrega 191 skills, 35 agentes, 6 reglas universales, 5 reglas materializadas en `.ai-hub/rules` y 4.662 destinos.
- `--preset-only` entrega 0 skills de proyecto, 6 agentes, 2 reglas y 120 destinos.
- `--exclude rule:skill-quality` entrega catálogo completo, 2 reglas y 4.642 destinos; skills/agents permanecen `full` y solo rules es `custom`.
- `angular-express` full entrega 9 reglas y 4.677 destinos sin duplicar `core`.
- El motor conserva 4.665 entradas de lock; `sync --check-lock` reporta “no aplica” en el checkout.
- `doctor` verde en motor y en instalaciones full/preset-only/custom; `drift` y `sync --check-lock` verdes en los tres consumidores.

## Evidencia

- Suite: 3 corridas consecutivas exit 0 (77,8 / 73,0 / 72,1 s; 187 tests + 1 skip).
- `prepublishOnly`: exit 0; build + manifest:build + suite.
- Tarball: 1.296 entradas y las 4 rutas `rules/skill-quality/*.md`.
- Medición full: 5.767 archivos, 46.402.682 B, 21,5 s cold / 6,2 s warm.
- CI local: 115,3 s; `timeout-minutes: 30`.
- `openspec validate "install-completo" --strict`: válido.
- `git add -n -f openspec/changes/install-completo`: lista proposal, design, tasks, `.openspec.yaml` y los 4 specs; sin `-f` sale 1 por `.gitignore`.

## Pendiente

1. Revisión humana del diff y del sello 0.2.0.
2. Publicar 0.2.0 solo tras CI y prueba en copia temporal; no se publica en esta sesión.

El cambio ya está archivado; los main specs de `agent-guardrails`, `dev-cli`, `harness-memory` y `preset-system` incluyen los 13 requisitos nuevos y los 2 modificados.

## Archivos clave

- `core/src/catalog.ts`, `core/src/cli/onboarding.ts`, `core/src/cli/maintenance.ts`, `core/src/cli/doctor.ts`.
- `core/src/engine/gates.ts`, `core/src/presets/materialize.ts`, `core/src/sync/sync.ts`.
- `core/vitest.config.ts`, `core/tests/install-generic.test.ts`, `core/tests/install-angular.test.ts`, `core/tests/selection.test.ts`.
- `core/rules/skill-quality/`, `core/scripts/measure-install.mjs`.
- `README.md`, `AGENTS.md`, `CHANGELOG.md`, `manifest.yaml`.

## Comando para retomar

```powershell
npm run ai:build
npm run ai:test
openspec instructions apply --change "install-completo" --json
```

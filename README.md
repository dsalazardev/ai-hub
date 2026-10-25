# AI Hub — universal software factory

> Un motor agnóstico, presets por stack y Spec Kit como única metodología.
> `ai-hub` instala un arnés verificado en cualquier repositorio, sin contener el dominio de ninguno.

---

## Inicio rápido

```bash
# 1. Compila el motor
npm ci --prefix core && npm run ai:build

# 2. Onboarding: detecta el stack y muestra el plan (no escribe nada)
node core/dist/bin/ai-hub.js init

# 3. Aplica el plan
node core/dist/bin/ai-hub.js init --yes

# 4. Proyecta a los asistentes y verifica
node core/dist/bin/ai-hub.js sync
node core/dist/bin/ai-hub.js doctor
```

`init` detecta el preset desde `package.json`, `angular.json`, `pyproject.toml` o `requirements.txt`. Si dos presets empatan, exige `--preset <id>`. El plan tiene un hash SHA-256 determinista.

---

## Capas

| Capa | Ruta | Quién la edita |
|---|---|---|
| Motor | `core/src/`, `core/engine/`, `core/agents/`, `core/skills/shared/` | Mantenedores del CLI |
| Preset | `core/presets/<id>/` | Mantenedores del preset |
| Proyecto | `.ai-hub/`, `manifest.yaml`, `.ai-hubrc.json` | Equipo del proyecto |

El motor no nombra lenguajes, frameworks, empresas ni módulos. El contenido de dominio vive en `core/presets/` y se copia una sola vez a `.ai-hub/`.

### Presets incluidos

| Preset | Detecta | Stack |
|---|---|---|
| `base` | sin señales | mínimo, cualquier lenguaje |
| `generic-ts` | `package.json`, `tsconfig.json` | TypeScript + npm |
| `angular-express` | `angular.json`, `@angular/core`, `express` | Angular + Express BFF |
| `python` | `pyproject.toml`, `requirements.txt` | Python + pytest/mypy/ruff |

Un preset puede extender otro (`angular-express` → `generic-ts` → `base`). La resolución sigue el orden: `--preset` > `.ai-hubrc.json` > detección > `base`.

---

## CLI: 18 comandos

| Comando | Responsabilidad |
|---|---|
| `init` | Detecta stack, elige preset y aplica un plan reproducible |
| `install` | Materializa el preset y sincroniza los destinos |
| `add` | Añade una skill o agente del preset |
| `list` | Lista preset, targets, comandos, skills y agentes |
| `sync` | Proyecta las fuentes a los destinos; `--check` informa deriva |
| `drift` | Informa deriva de hash sin escribir |
| `doctor` | Valida motor, preset, manifiesto, targets, hooks y deriva |
| `check` | Alias de `doctor` + `drift` para CI |
| `backups` | Lista snapshots |
| `restore` | Restaura un snapshot |
| `uninstall` | Elimina una skill o agente añadido |
| `purge` | Elimina el arnés tras crear un snapshot |
| `upgrade` | Actualiza el paquete y re-sincroniza |
| `repair` | Reaplica solo lo que falta o está roto |
| `worktrees` | Lista o reapea worktrees (`reap --confirm`, `--auto`) |
| `trunk` | Muestra, cierra o abre la rama principal |
| `memory` | Escribe, lista y reanuda el ledger |
| `context` | Regenera `.planning/context-next.md` |

`ai-hub help` lista exactamente estos 18. Un comando desconocido sale con 2. `verify` y `judge` se mantienen como compatibilidad.

### Contrato de `.ai-hubrc.json`

```json
{
  "version": 2,
  "dir": ".",
  "preset": "generic-ts",
  "targets": ["claude", "opencode", "pi", "cursor", "copilot"],
  "guardMode": "shadow"
}
```

`resolveAiHubDir()` resuelve: `AI_HUB_DIR` → `dir` del rc → `./.ai-hub` → `./ai-hub` → ancestro con `manifest.yaml`. Un rc v1 se migra; una fuente explícita inválida falla en vez de continuar.

---

## Metodología: Spec Kit

17 comandos en tres carriles:

- **Assessment (5)** — `assess-intake`, `assess-research`, `assess-define`, `assess-shape`, `assess-decide`.
- **Feature SDD (9)** — `constitution`, `specify`, `clarify`, `plan`, `checklist`, `tasks`, `analyze`, `implement`, `converge`.
- **Bug Fix (3)** — `bug-assess`, `bug-fix`, `bug-test`.

Las 17 skills son nativas (`speckit-*`). No hay comandos ni estado de OpenSpec en el runtime; el `openspec/` del repositorio de autoría es histórico.

### Etiquetas GitLab

`ai::todo`, `ai::in-spec`, `ai::spec-ready`, `ai::in-dev`, `ai::in-review`, `ai::done`, `ai::blocked`.

`ai::spec-ready` se aprueba con el SHA-256 de `spec.md + plan.md + tasks.md`; ningún agente se autoaprueba.

---

## Guardias

`core/src/harness/guards/` implementa un `runPreflight(command, ctx)` puro:

- `danger`: borrado recursivo forzado, `mkfs`, escritura en dispositivo, fork bomb, push forzado, reset duro, SQL destructivo, pipe-to-shell.
- `trunk`: cierra la rama con CI, despliegue, equipo o política explícita.
- `branch`: impide cambiar a una rama ocupada por otro worktree.
- `ship`: impide volver a la trunk con trabajo sin commit o sin push.

Cada decisión incluye regla, motivo y salida. `guardMode` es `shadow` por defecto; `enforce` es opt-in. Los adaptadores (Hermes, Claude, OpenCode) comparten el mismo contrato y fallan abiertos. La superficie siempre activa se genera para Claude, OpenCode, Pi, Cursor y Copilot.

El reaper de worktrees solo elimina un worktree propio, limpio e integrado, y exige `--confirm` en modo interactivo. `install --hooks` cablea el `post-merge` opcional.

---

## Memoria y estado

- `.planning/state.json` — proyecto, preset, cambio activo, fase y conteo de tareas.
- `.planning/memory.jsonl` — eventos `start`, `checkpoint`, `decision`, `end`; esquema cerrado; nunca prompts, contenido ni secretos.
- `.planning/context-next.md` — contexto regenerable con `ai-hub context`.

---

## Targets

| Target | Skills | Agentes | Reglas | Superficie |
|---|---|---|---|---|
| Claude | `.claude/skills` | `.claude/agents` | `.claude/rules` | `.claude/rules/preflight.md` |
| OpenCode | `.opencode/skills` | `.opencode/agents` | `.opencode/rules` | `.opencode/rules/preflight.md` |
| Pi | `.pi/skills` | `.pi/agents` | `.pi/prompts` | `.pi/prompts/preflight.md` |
| Cursor | `.cursor/rules/*.mdc` | — | `.cursor/rules/*.mdc` | `.cursor/rules/preflight.mdc` |
| Copilot | `.github/skills` | `.github/agents` | `.github/instructions` | `.github/instructions/preflight.instructions.md` |

Añadir un target es una fila en `core/src/sync/targets.ts` y un id en `core/engine/engine.yaml`.

---

## Desarrollo

```bash
npm run ai:build        # compila core/
npm run ai:test         # tests
npm run ai:typecheck    # tsc --noEmit
npm run ai:sync         # regenera destinos
npm run ai:drift        # verifica deriva
npm run ai:doctor       # diagnóstico completo
npm run manifest:build  # regenera core/manifest.json
npm run manifest:check  # verifica inventario
```

---

## Referencias

- `AGENTS.md` — constitución operativa.
- `manifest.yaml` — configuración del proyecto.
- `core/engine/engine.yaml` — invariantes del motor.
- `core/schema/` — esquemas de manifiesto, preset, estado y motor.
- `openspec/changes/` — historial de cambios del propio `ai-hub`.

# AI Hub — universal software factory

> Un motor agnóstico, presets por stack y Spec Kit como única metodología.
> `ai-hub` instala un arnés verificado en cualquier repositorio, sin contener el dominio de ninguno.

**Autor:** Daner Alejandro Salazar Colorado.

---

## Inicio rápido

Requisitos en el repositorio consumidor: Node.js >= 22, [uv](https://docs.astral.sh/uv/getting-started/installation/) con `uvx` en el PATH y un `bash` que ejecute (en Windows, Git Bash; el lanzador de WSL sin distribución no sirve). `init --yes` instala también Spec Kit (`specify-cli` 1.2.3 con las extensiones `bug` y `assess`) y una instalación completa tarda **unos 60 s** (59,6 s medidos con `generic-ts`). Sin `uv` o sin `bash`, `init --yes` sale con código 2 antes de escribir nada y dice qué falta; `--no-speckit` instala sin Spec Kit y deja el arnés degradado hasta un `install` posterior.

```bash
# 1. Desde el checkout de ai-hub, compila el motor
npm ci --prefix core
npm run ai:build

# 2. En el repositorio consumidor (no en el checkout del motor)
cd /ruta/a/mi-repo
AI_HUB=/ruta/a/ai-hub/core/dist/bin/ai-hub.js

# 3. Onboarding: muestra el plan completo sin escribir nada
node "$AI_HUB" init

# 4. Aplica el plan y verifica
node "$AI_HUB" init --yes
node "$AI_HUB" doctor
node "$AI_HUB" drift
node "$AI_HUB" sync --check-lock
```

Para el mínimo de 0.1.x: `init --preset-only --yes`. Para el catálogo completo sin las 4 rúbricas: `init --yes --exclude rule:skill-quality`.

`init` detecta el preset desde `package.json`, `angular.json`, `pyproject.toml` o `requirements.txt`. Si dos presets empatan, exige `--preset <id>`. El plan tiene un hash SHA-256 determinista.

### Contrato de instalación (0.3.0)

Una instalación nueva usa `full` por defecto: **261 skills de proyecto + 17 comandos Spec Kit**, 39 agentes, las 6 reglas universales, las reglas propias del preset y la regla generada `ai-hub-speckit`. Los 17 comandos los provee Spec Kit en cuatro destinos; AI-Hub no proyecta sus cuerpos.

Cifras medidas en copias temporales con el CLI compilado y `uvx` real (`core/tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---:|
| `init --yes` (`generic-ts`, full) | 6.853 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.833 |
| `init --yes --preset angular-express` | 6.868 |

- Spec Kit se instala en `claude`, `opencode`, `pi` y `cursor` (`cursor-agent`). **Copilot queda excluido de Spec Kit**: recibe agentes, reglas y la regla `ai-hub-speckit`, y `doctor` lo informa como `copilot: sin Spec Kit`.
- `--preset-only`: 0 skills de proyecto, 6 agentes y 2 reglas base, más los 17 comandos Spec Kit.
- `--exclude skill:<id>,agent:<id>,rule:<id>`: selección `custom`.
- `full` es dinámico: `doctor` compara contra el catálogo instalado y `upgrade` incorpora activos nuevos. Un catálogo actualizado avisa con exit 0; un `publish` editado falla con exit 1.
- Las 11 skills de la tercera cadena SDD llevan `runtime: false`: siguen en el paquete pero no se instalan.
- MCP es del consumidor: si existe `mcp-manifest.yaml` en la raíz se proyectan `.mcp.json`, `.cursor/mcp.json` y `.vscode/mcp.json`; si no, `doctor` dice `MCP: no configurado`.
- `.planning/` es del checkout de desarrollo. La instalación no lo crea; `memory` y `context` reportan `no aplica en instalación`.
- `.ai-hub/`, `sync.lock.json`, `.specify/` y `specs/` se versionan; los destinos generados no, e `install` los regenera en un clon nuevo.
- Migración desde 0.2.x: `install` añade el bloque `speckit`, ejecuta Spec Kit, transfiere la propiedad de los comandos sin borrar los archivos de Spec Kit y retira las copias antiguas (Copilot incluido) y las skills `runtime: false`.

### Empaquetado y medición

Las 4 rúbricas viajan en `core/rules/skill-quality/` porque `core/package.json.files` incluye `rules`; un test SHA-256 exige que la copia del taller sea idéntica. `npm pack --dry-run` desde `core` reporta 1.295 entradas y ningún `skills/shared/speckit-*`.

No hay `postinstall`: la instalación sólo escribe cuando se ejecuta `init`/`install`. `prepublishOnly` ejecuta `build`, `manifest:build` y `npm test` (proyectos `unit` e `integration`), que incluye pruebas con Spec Kit real: la máquina que publica necesita `uv` y `bash`. Los tests de git se omiten, nombrando el binario, si `git` no se puede ejecutar.

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
| `install` | Materializa el catálogo o el preset según la selección y sincroniza |
| `add` | Añade una skill o cualquier agente del catálogo |
| `list` | Lista preset, targets, comandos, skills, agentes y selección |
| `sync` | Proyecta las fuentes a los destinos; `--check` informa deriva |
| `drift` | Informa deriva de hash sin escribir |
| `doctor` | Valida motor, preset, manifiesto, completitud, targets, hooks y deriva |
| `check` | Alias solo de `doctor` para CI |
| `backups` | Lista snapshots |
| `restore` | Restaura un snapshot |
| `uninstall` | Elimina una skill, agente o regla añadida |
| `purge` | Elimina el arnés tras crear un snapshot |
| `upgrade` | Actualiza el paquete y re-sincroniza; completa dimensiones `full` |
| `repair` | Reaplica solo lo que falta o está roto |
| `worktrees` | Lista o reapea worktrees (`reap --confirm`, `--auto`) |
| `trunk` | Muestra, cierra o abre la rama principal |
| `memory` | Escribe, lista y reanuda el ledger (solo taller) |
| `context` | Regenera `.planning/context-next.md` (solo taller) |

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

Los 17 comandos los provee Spec Kit (`specify-cli` 1.2.3 fijado por el paquete, extensiones `bug` y `assess`), instalado por `init` con `uvx`. `engine.yaml` los identifica con su id canónico (`speckit.plan`, `speckit.bug.assess`); la invocación se deriva por destino (`/speckit-plan` en Claude y Cursor, `/speckit.plan` en OpenCode y Pi). No hay comandos ni estado de OpenSpec en el runtime; el `openspec/` del repositorio de autoría es histórico.

### Etiquetas GitLab

`ai::todo`, `ai::in-spec`, `ai::spec-ready`, `ai::in-dev`, `ai::in-review`, `ai::done`, `ai::blocked`.

`ai::spec-ready` se aprueba con el SHA-256 de `specs/<feature>/{plan,spec,tasks}.md` (rutas relativas a la raíz; contrato y vector de prueba en `AGENTS.md` §5); ningún agente se autoaprueba ni mueve una etiqueta.

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

## Memoria y estado (solo taller)

`.planning/` pertenece al checkout de desarrollo. Una instalación no lo crea y `memory`/`context` salen 0 con `no aplica en instalación`.

- `.planning/state.json` — proyecto, preset, cambio activo, fase y conteo de tareas.
- `.planning/memory.jsonl` — eventos `start`, `checkpoint`, `decision`, `end`; esquema cerrado; nunca prompts, contenido ni secretos.
- `.planning/context-next.md` — contexto regenerable con `ai-hub context`.

---

## Targets

| Target | Skills | Agentes | Reglas | Superficie | Spec Kit |
|---|---|---|---|---|---|
| Claude | `.claude/skills` | `.claude/agents` | `.claude/rules` | `.claude/rules/preflight.md` | `claude` en `.claude/skills` |
| OpenCode | `.opencode/skills` | `.opencode/agents` | `.opencode/rules` | `.opencode/rules/preflight.md` | `opencode` en `.opencode/commands` |
| Pi | `.pi/skills` | `.pi/agents` | `.pi/prompts` | `.pi/prompts/preflight.md` | `pi` en `.pi/prompts` |
| Cursor | `.cursor/rules/*.mdc` | — | `.cursor/rules/*.mdc` | `.cursor/rules/preflight.mdc` | `cursor-agent` en `.cursor/skills` |
| Copilot | `.github/skills` | `.github/agents` | `.github/instructions` | `.github/instructions/preflight.instructions.md` | — (excluido) |

Añadir un target es una fila en `core/src/sync/targets.ts` y un id en `core/engine/engine.yaml`. Los comandos `speckit-*` / `speckit.*` dentro del directorio de Spec Kit de cada destino pertenecen a Spec Kit; `sync` nunca los escribe ni los borra.

---

## Desarrollo

```bash
npm run ai:build        # compila core/
npm run ai:test         # unit (10 s) + integration (60 s), serial; repetir 3 veces
npm run ai:typecheck    # tsc --noEmit
npm run ai:sync         # regenera destinos
npm run ai:drift        # verifica deriva
npm run ai:doctor       # diagnóstico completo
npm run manifest:build  # regenera core/manifest.json
npm run manifest:check  # verifica inventario
node core/scripts/measure-install.mjs --preset generic-ts --budget 60000
```

---

## Referencias

- `AGENTS.md` — constitución operativa.
- `manifest.yaml` — configuración del proyecto.
- `core/engine/engine.yaml` — invariantes del motor.
- `core/schema/` — esquemas de manifiesto, preset, estado y motor.
- `openspec/changes/` — historial de cambios del propio `ai-hub`.

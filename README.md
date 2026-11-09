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

### Asistente de onboarding (0.7.0)

`ai-hub init` **sin flags** en una terminal real (TTY en stdout y stdin, fuera del checkout del motor) abre un asistente interactivo de `@clack/prompts`. El gate vive al inicio de `cmdInit`: con cualquier flag, con la salida pipeada o en CI, ni una línea del asistente se ejecuta y la salida es byte a byte la del flujo de flags.

El asistente es una **generadora de flags**, no un camino paralelo: cada decisión se resuelve a los flags existentes (`--targets`, `--preset`, `--full`/`--preset-only`/`--exclude`, `--script`, `--scripts`) y el plan lo construye el mismo `planBodyFor` — el mismo input por el asistente y por flags produce el mismo plan y el mismo hash (test permanente en `core/tests/assistant.test.ts`). Pasos:

1. **Destinos** — multi-select con preselección por detección (`claude --version`, etc.).
2. **Preset** — el detectado; si dos empatan, elección explícita (nunca adivina).
3. **Perfil** — `full` / `preset-only` / `custom` con excludes guiados.
4. **Scripts** — multi-select del conjunto (`py`/`sh`/`ps`, mínimo uno, preseleccionado con los tres) y elección del activo cuando selecciona más de un tipo; informa el shell resuelto para `sh` y el intérprete para `py`.
5. **Entorno** — verificación de herramientas (informativa: si falta una, nombra cómo instalarla y loguearse; el login jamás se verifica) y preflight de Spec Kit (fail-closed: si falla, exit 2 antes de escribir).
6. **Idea del proyecto** — opcional, saltable.
7. **Plan** — el mismo JSON de `--dry-run` con el entorno real, y confirmación. Al confirmar aplica por el mismo camino que `--yes`; al cancelar en cualquier paso no se escribe un byte.

Con idea, la confirmación escribe `backlog/seed.md` (la idea textual, la fecha y un apuntador) y `backlog/pre-prompt.md`, una plantilla bilingüe (español/inglés) que instruye al **agente del cliente** — no al CLI — a convertir la idea en items de backlog con criterio de aceptación verificable, priorizarlos y arrancar con `/speckit.constitution` y `/speckit-assess-intake`. La semilla es un activo versionable del proyecto: no entra al hash del plan, `sync` no la lockea y el `.gitignore` generado no la ignora. `doctor` la reporta como aviso informativo (`[OK] backlog: …`), nunca como gate.

`@clack/prompts` ^1.8.1 es la única dependencia nueva: JS puro sin binarios nativos, 166,3 KB (170.333 bytes) de árbol en `node_modules`; el tarball publicado no incluye `node_modules` y crece sólo por los archivos nuevos de `dist`.

### Conjunto de scripts (0.8.0) y banner neón (0.9.0)

El conjunto de scripts de Spec Kit pasa a ser elegible: `--scripts py` instala sólo `.specify/scripts/python`; `--scripts py,sh --script sh` instala python y bash con `sh` activo (los `specify init` van tipo por tipo, activo al final). Sin `--scripts` — y sin `speckit.scripts` en el manifest — se instalan los tres tipos exactamente como en 0.4–0.7: la salida pipeada es byte a byte la de 0.7.0. `--script` acepta además `py` (sonda `python -c "print('ok')"`, candidatos `python`, `python3`, `py`). El activo tiene que pertenecer al conjunto: la contradicción explícita sale con código 2 antes de escribir, nombrando ambos campos; un `--script` explícito pisa al `speckit.script` del manifest. El plan hasheado incluye `speckit.scripts` sólo cuando el conjunto difiere de los tres, así `--scripts sh,ps,py` explícito produce el mismo hash que la invocación sin flags.

En la TUI, el paso de scripts es un multi-select del conjunto (mínimo uno) más la elección del activo cuando selecciona más de un tipo, y el asistente abre con un **banner de identidad** neón — el arte slant de "AI-HUB" con gradiente vertical cian→azul en ANSI puro, `» Autonomous Software Factory` y la versión del paquete resuelta en runtime — sin dependencias nuevas (interpolación a mano: truecolor, 256 colores o apagado por `NO_COLOR`), con fallback de una línea por debajo de 60 columnas y ausente de toda salida pipeada porque el adaptador sólo se carga tras el gate de TTY.

### Contrato de instalación (0.3.0)

Una instalación nueva usa `full` por defecto: **262 skills de proyecto + 17 comandos Spec Kit**, 40 agentes, las 6 reglas universales, las reglas propias del preset y la regla generada `ai-hub-speckit`. Los 17 comandos los provee Spec Kit en cuatro destinos; AI-Hub no proyecta sus cuerpos.

Cifras medidas en copias temporales con el CLI compilado y `uvx` real (`core/tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---:|
| `init --yes` (`generic-ts`, full) | 6.872 |
| `init --yes --preset-only` | 66 |
| `init --yes --exclude rule:skill-quality` | 6.852 |
| `init --yes --preset angular-express` | 6.887 |

- Spec Kit se instala en `claude`, `opencode`, `pi` y `cursor` (`cursor-agent`). **Copilot queda excluido de Spec Kit**: recibe agentes, reglas y la regla `ai-hub-speckit`, y `doctor` lo informa como `copilot: sin Spec Kit`.
- `--preset-only`: 0 skills de proyecto, 11 agentes (los 6 de rol, `narrator` y el panel de refutación) y 2 reglas base, más los 17 comandos Spec Kit.
- `--exclude skill:<id>,agent:<id>,rule:<id>`: selección `custom`.
- `full` es dinámico: `doctor` compara contra el catálogo instalado y `upgrade` incorpora activos nuevos. Un catálogo actualizado avisa con exit 0; un `publish` editado falla con exit 1.
- Las 11 skills de la tercera cadena SDD llevan `runtime: false`: siguen en el paquete pero no se instalan.
- MCP es del consumidor: si existe `mcp-manifest.yaml` en la raíz se proyectan `.mcp.json`, `.cursor/mcp.json` y `.vscode/mcp.json`; si no, `doctor` dice `MCP: no configurado`.
- `.planning/` es del checkout de desarrollo. La instalación no lo crea; `memory` y `context` reportan `no aplica en instalación`.
- `.ai-hub/`, `sync.lock.json`, `.specify/` y `specs/` se versionan; los destinos generados no, e `install` los regenera en un clon nuevo.
- Migración desde 0.2.x: `install` añade el bloque `speckit`, ejecuta Spec Kit, transfiere la propiedad de los comandos sin borrar los archivos de Spec Kit y retira las copias antiguas (Copilot incluido) y las skills `runtime: false`.

### Empaquetado y medición

Las 4 rúbricas viajan en `core/rules/skill-quality/` porque `core/package.json.files` incluye `rules`; un test SHA-256 exige que la copia del taller sea idéntica. `npm pack --dry-run` desde `core` reporta 1.888 entradas y ningún `skills/shared/speckit-*`.

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
| `php` | `composer.json` | PHP + Composer/PHPUnit, área `modules` (Laravel: `php artisan test`) |

Un preset puede extender otro (`angular-express` → `generic-ts` → `base`). La resolución sigue el orden: `--preset` > `.ai-hubrc.json` > detección > `base`.

Un preset publica skills propias o del catálogo compartido (la del preset gana). Sus reglas y skills pueden usar `{{stack.<clave>}}`: `sync` lo resuelve con `manifest.stack` solo en las fuentes del preset que siguen intactas; una copia editada por el proyecto o una fuente del motor no se interpola, y una clave desconocida hace fallar `sync` nombrando archivo y clave.

---

## CLI: 28 comandos

| Comando | Responsabilidad |
|---|---|
| `init` | Detecta stack, elige preset y aplica un plan reproducible |
| `install` | Materializa el catálogo o el preset según la selección, recupera fuentes de `.ai-hub/` ausentes y sincroniza |
| `add` | Añade una skill o cualquier agente del catálogo |
| `list` | Lista preset, targets, comandos, skills, agentes y selección; `--collisions` informa pares de skills con descripciones casi iguales (umbral 0,80) |
| `sync` | Proyecta las fuentes a los destinos; `--check` informa deriva |
| `drift` | Informa deriva de hash sin escribir |
| `doctor` | Valida motor, preset, manifiesto, completitud, targets, hooks reales, referencias del catálogo y deriva |
| `check` | Alias solo de `doctor` para CI |
| `backups` | Lista snapshots |
| `restore` | Restaura un snapshot |
| `uninstall` | Elimina una skill, agente o regla añadida |
| `purge` | Elimina el arnés tras crear un snapshot |
| `upgrade` | Actualiza el paquete y re-sincroniza; completa dimensiones `full` |
| `repair` | Reaplica solo lo que falta o está roto; restaura fuentes de `.ai-hub/` borradas desde el catálogo del motor |
| `worktrees` | Lista o reapea worktrees (`reap --confirm`, `--auto`) |
| `trunk` | Muestra, cierra o abre la rama principal |
| `memory` | Escribe, lista y reanuda el ledger (solo taller) |
| `context` | Regenera `.planning/context-next.md` (solo taller) |
| `env` | `env exec -- <cmd>`: ejecuta un comando con `.ai-hub/.env` cargado, sin bash ni PowerShell |
| `ci` | `ci gitlab` escribe `.gitlab-ci.ai-hub.yml`; `ci devcontainer` escribe `.devcontainer/devcontainer.json` (Node + uv + bash). Solo a petición, `init` nunca los escribe (`--force` para sobrescribir) |
| `hooks` | `hooks install --pre-commit|--post-merge`: hooks de git que salen 0 si falta `npx` |
| `gate` | Verifica el trabajo: artefactos por feature (`specs/NNN-*/`), WIP ≤ 1, `--seal <hash>` (fail-closed) y los comandos `typecheck`/`lint`/`test`/`verify` del manifiesto con el shell resuelto (nunca `bash` del PATH); `--quick` omite los comandos |
| `runs` | Telemetría de ejecuciones en `.ai-hub/runs/` (ignorado) con esquema cerrado: `start`, `event` (`--from-status`), `note` (`decision`, `warn`, `awaiting-ok`, `lesson`), `end`, `list`; único escritor; nunca guarda prompts, contenido, tokens ni variables de entorno; retención `policy.runs.keep` (50) |
| `control` | `control tick --dry-run [--json] [--issue] [--labels-from] [--online]`: propone transiciones de etiqueta según `exit_effects`, revalida el sello antes de `ai::in-dev`, aplica `max_rounds` y lista lo pendiente de OK humano. No escribe, no mueve etiquetas, no comenta, no lanza agentes; nunca propone `ai::spec-ready` |
| `review` | `review consolidate <informes…>`: consolida los bloques ```json findings``` del panel (une a ±3 líneas o por evidencia, degrada a `question` lo que no trae archivo, línea o escenario); solo escribe por stdout |
| `seal` | `seal review --verdict <APPROVE|APPROVE_WITH_NITS|CHANGES_REQUESTED> [--base <ref>]`: liga el veredicto de revisión al SHA-256 del diff real (en `.ai-hub/runs/`, ignorado). La guardia `ship` deniega volver a la trunk si el diff cambió o el veredicto es `CHANGES_REQUESTED`; un diff que toca `specs/<feature>/` no se puede aprobar (invalida la aprobación humana de §5). El sello de spec no cambia |
| `adopt` | Adopta un arnés heredado (núcleo copiado, manifiesto y lock v1, MCP dentro de `.ai-hub/`, metodología anterior) por fases; ver "Adopción de un arnés heredado" |
| `hook` | Hook de host (`pre`/`post`/`stop`): lee el payload por stdin, aplica el preflight y la guardia de alcance; siempre sale 0 (falla abierto) |

`ai-hub help` lista exactamente estos 28. `verify` es alias de `gate`. Un comando desconocido sale con 2. `verify` y `judge` se mantienen como compatibilidad.

### Adopción de un arnés heredado

`ai-hub adopt` se ejecuta en la raíz del repositorio:

1. **F0 — `adopt --dry-run`** (el único paso que no necesita snapshot): detecta el núcleo copiado en `.ai-hub/core/`, el manifiesto y el lock v1, el MCP dentro de `.ai-hub/`, `openspec/`, `.planning/`, los scripts `ai:*` y `.githooks/`; imprime el plan y no escribe nada.
2. **F1 — `adopt --yes`** toma un snapshot en `.backups/` antes de tocar nada (sin `.ai-hub/.env` ni `.ai-hub/runs/`), archiva los artefactos v1 en `.ai-hub/legacy/`, crea el manifiesto v2 (las reglas v1 pasan a `rules.publish` y `agents.can_modify` a `paths.areas`) y el `.ai-hubrc.json`, y mueve el MCP a `mcp-manifest.yaml` en la raíz. `ai-hub restore <snapshot>` lo revierte.
3. **F2 — convivencia:** `policy.legacy.openspec: archive` con fecha (`--legacy-until`, 90 días por defecto); hasta entonces los artefactos de la metodología anterior son aviso en `doctor`, no fallo. `openspec/` queda como histórico.
4. **F3 — retirada:** se elimina `.ai-hub/core/`. `package.json` y `.githooks/` nunca se editan: se imprime el diff sugerido. `--archive-planning` mueve `.planning/` a `.ai-hub/work/legacy-planning/`.
5. **F4 — verificación:** `doctor` y `drift`.

### Áreas, región de AGENTS.md y políticas

- `paths.areas` (`[{id, paths, role, rules}]`, en el manifiesto o en el preset) reparte el `can_modify` de `implementer-frontend` e `implementer-backend` por áreas; la guardia de alcance lo aplica. `sync` genera la regla `ai-hub-area-<id>` en cada destino (`globs` en Cursor, `applyTo` en Copilot).
- Con `agentsMd: true`, `sync` mantiene una región entre `<!-- ai-hub:start -->` y `<!-- ai-hub:end -->` en el `AGENTS.md` raíz (índice de reglas, lecciones y contrato de cierre; lo leen Codex y Copilot coding agent) y en el `AGENTS.md` de cada área. El resto del archivo es del proyecto; el lock registra solo el hash de la región. `doctor` avisa si el `AGENTS.md` raíz supera 32 KB.
- `policy.wip`, `policy.maxRounds`, `policy.requireEars` y `policy.requireTraceability` solo endurecen: un valor más permisivo que el motor hace fallar el manifiesto. Los declarados aparecen en la regla `ai-hub-speckit`.
- Las copias de `.ai-hub/` que el proyecto no tocó se refrescan con la versión nueva al ejecutar `install`/`upgrade`; las editadas se conservan y se informan como colisión.

### Contrato de cierre y cabeceras de agentes

- Todo rol termina su respuesta con una línea `AI-HUB-STATUS: <STATE> | artifact=<ruta|-> | reason=<código>[: <frase>]`. Los estados admitidos (los de `exit_effects` más `REFUTED`/`NOT-REFUTED`), la obligación de `reason` y el límite de rondas de `converge` (3; el proyecto solo puede bajarlo con `policy.maxRounds`) se generan desde `engine.yaml` en la regla `ai-hub-speckit`.
- Los agentes del catálogo declaran `capabilities` (`read`, `search`, `edit`, `shell`, `web`, `delegate`), `max_turns` y `tier`, sin nombres de proveedor. Cada destino los traduce: Claude (`tools` reales y `maxTurns`), OpenCode (permisos que solo deniegan y `steps`), Copilot (`.github/agents/*.agent.md` con alias de herramientas), Cursor (`.cursor/agents` con `readonly`). El núcleo de Pi no tiene subagentes. El modelo lo pone el proyecto con `manifest.agentModels.<destino>.<tier>`; sin correspondencia, el host hereda el de la sesión. `doctor` (`agents:capabilities`) lista lo que cada destino no puede expresar y falla si un revisor o refuter declara `edit` o `shell`.
- El preset `base` publica el panel de refutación (`refuter-correctness`, `refuter-security`, `refuter-tests`, `finding-verifier`) y `narrator`: todo preset los hereda.

### Estado de trabajo del consumidor

`init` materializa `.ai-hub/work/` (versionado: hallazgos, notas, revisiones, devoluciones e informes por feature), `.ai-hub/lessons.md` (versionado, del proyecto; `sync` lo proyecta como la regla `ai-hub-lessons` en cada destino) y `.ai-hub/runs/` (ignorado). `.planning/` es solo del taller. El agente `narrator` (preset `base`, solo lectura) redacta el comentario de la issue de una ejecución en la que no participó; quien lo invoca lo guarda en `.ai-hub/work/<feature>/report.md` y `control tick` lo enumera. La skill `improve-from-runs` mejora la fábrica a partir de la telemetría: una pieza culpable, un arreglo, una lección.

### Hooks reales y referencias del catálogo

- `sync` proyecta hooks **ejecutables**: en Claude mezcla por clave entradas `npx --no-install ai-hub hook pre|post|stop` en `.claude/settings.json` (nunca lo sobrescribe ni lo registra en el lock; un JSON inválido no se toca) y en OpenCode genera `.opencode/plugins/ai-hub.js`. Cursor, Copilot y Pi no admiten hooks: conservan la regla en prosa y `doctor` lo dice. Con hooks reales, `guardMode: enforce` deniega o pide confirmación (`ask`) de verdad.
- `doctor` ejecuta `catalog:references`: toda ruta `.ai-hub/**`, todo `npx ai-hub <cmd>`, todo `subagent_type` y todo enlace relativo de las skills, agentes y reglas que el proyecto escribió o editó debe resolver. Las referencias heredadas conocidas viven en `core/engine/catalog-baseline.json` con fecha de caducidad.

### Credenciales del arnés

- `init` añade `.ai-hub/.env` y `.ai-hub/runs/` a `.gitignore` y materializa solo `.ai-hub/.env.example` (valores `CHANGEME`). El paquete **nunca** escribe credenciales por su cuenta.
- El `.env` real lo creas tú: a mano desde el ejemplo, o en el paso **opcional** que el asistente interactivo ofrece al final (`Enter` vacío lo salta; el token se escribe enmascarado; con `--yes` no hay pregunta). Ningún agente pide tokens.
- Declara el tracker en `manifest.yaml` (`tracker: {kind: gitlab, urlEnv: GITLAB_URL, tokenEnv: GITLAB_TOKEN}`); `doctor` comprueba `env:ignored` y `env:keys` (solo presencia de claves) y, con `--online`, `tracker:token` (una lectura de identidad, salida redactada).
- Los snapshots de `.backups/` nunca copian `.ai-hub/.env`.

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

**Codex (parcial).** Codex lee el `AGENTS.md` raíz: con `agentsMd: true`, `sync` le proyecta la región gestionada (índice de reglas, lecciones y contrato de cierre). No recibe skills, agentes, hooks ni comandos de Spec Kit; un destino `codex` completo queda en el roadmap (P4).

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
node scripts/upstream-watch.mjs    # vigila Spec Kit y los dist-tags de npm (solo taller)
```

`scripts/upstream-watch.mjs` es la **única pieza que no viaja** en el paquete: vive en la raíz del taller, fuera de `core/` y de `files`. Solo lee (GitHub y el registro de npm, sin credenciales) y sale 1 si hay una versión estable de Spec Kit fuera de `speckit.supported`.

---

## Referencias

- `AGENTS.md` — constitución operativa.
- `manifest.yaml` — configuración del proyecto.
- `core/engine/engine.yaml` — invariantes del motor.
- `core/schema/` — esquemas de manifiesto, preset, estado y motor.
- `openspec/changes/` — historial de cambios del propio `ai-hub`.

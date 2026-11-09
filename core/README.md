# @dsalazardev/ai-hub-cli

Arnés agéntico instalable para repositorios de software. Instala un motor común
—CLI, reglas, agentes, skills, guardias— y lo proyecta hacia las herramientas que
el proyecto ya usa, sin acoplarse a un lenguaje ni a un dominio concreto.

## Requisitos

- Node.js >= 22
- [uv](https://docs.astral.sh/uv/getting-started/installation/) con `uvx` en el PATH: `init` e `install`
  ejecutan Spec Kit con `uvx --from specify-cli==<versión fijada>`, sin `uv tool install`.
- `bash` para los scripts `sh` de Spec Kit (por defecto en todas las plataformas). En Windows,
  Git for Windows (Git Bash) en el PATH; el lanzador `bash` de WSL sin distribución no sirve.
  Alternativa: `speckit.script: ps` en `manifest.yaml` (requiere PowerShell).

## Uso rápido

En un repositorio vacío o existente:

```bash
npx @dsalazardev/ai-hub-cli init --yes
npx @dsalazardev/ai-hub-cli install
npx @dsalazardev/ai-hub-cli doctor
```

`init` detecta el preset según el stack del repositorio y materializa `.ai-hub/`,
que es obligatoria, e instala Spec Kit en la raíz con las extensiones `bug` y `assess`.
`install` proyecta reglas, agentes y skills a los destinos declarados en `targets` y
repite la instalación de Spec Kit. `doctor` valida motor, preset, manifiesto, deriva y
Spec Kit.

## Spec Kit

Spec Kit ejecuta los 17 comandos de la metodología; AI-Hub define roles, estados y
etiquetas. El paquete declara el rango soportado de `specify-cli` (`supported`, única
fuente: toda resolución usa el rango y toma la última estable dentro de él, sin pin exacto
ni fecha de resolución) y fija la versión de las extensiones. `manifest.yaml` puede
restringir la versión dentro del rango (`speckit.version`, que se instala exacta), elegir
el script (`speckit.script: sh | ps`) y la integración por defecto
(`speckit.defaultTarget`), pero no ampliar el rango ni cambiar las extensiones.

- Una instalación deja `.specify/scripts/{bash,powershell,python}` con seis archivos cada
  uno: la secuencia interna corre un `specify init` por tipo de script y deja el elegido
  al final. Los directorios de los tipos no elegidos existen pero nadie los invoca: es el
  comportamiento esperado, no un fallo.
- Spec Kit se instala en `claude`, `opencode`, `pi` y `cursor` (`cursor-agent`). **Copilot
  no recibe Spec Kit**: recibe agentes, reglas y la regla `ai-hub-speckit`.
- Sin `uv`, sin red y sin caché para el rango soportado, o sin `bash` con `script: sh`,
  `init` sale con código 2 **antes de escribir nada** y dice qué falta.
- `init --no-speckit` instala sin Spec Kit y deja el arnés **degradado** (`doctor` sale 1).
  Un `ai-hub install` posterior sin la bandera lo reactiva.
- `.specify/` y `specs/` se versionan; las copias de los comandos en las carpetas de los
  asistentes no, y `install` las regenera en un clon nuevo.

### CI

`doctor` no necesita Python, pero un clon nuevo no tiene las copias de los comandos de
Spec Kit en las carpetas de los asistentes, que están ignoradas. El job instala `uv`,
regenera con `install` y verifica:

```yaml
- uses: astral-sh/setup-uv@v6
- run: npx @dsalazardev/ai-hub-cli install
- run: npx @dsalazardev/ai-hub-cli doctor
```

Si la detección es ambigua, el preset se elige explícitamente:

```bash
npx @dsalazardev/ai-hub-cli init --preset angular-express --yes
```

Destinos admitidos: `claude`, `opencode`, `pi`, `cursor`, `copilot`. Se pueden
limitar:

```bash
npx @dsalazardev/ai-hub-cli install --targets claude
```

## Comandos

| Comando | Qué hace |
|---|---|
| `init` | Detecta el repo, elige preset e imprime el plan; `--yes` lo aplica, `--preset <id>`, `--preset-only`, `--targets`, `--no-speckit` |
| `install` | Materializa el preset y sincroniza destinos; refresca copias de `.ai-hub/` no tocadas |
| `add` | Añade una skill o agente del catálogo al proyecto |
| `list` | Preset, destinos, comandos, skills y agentes; `--collisions` |
| `sync` | Reproyecta; `--check` no escribe, `--check-lock` verifica integridad |
| `drift` | Informa diferencias entre fuentes y destinos |
| `doctor` / `check` | Diagnóstico completo del arnés; `--online` comprueba la identidad del tracker (redactada) |
| `backups` / `restore` | Lista y restaura snapshots (sin `.ai-hub/.env` ni `.ai-hub/runs/`) |
| `uninstall` / `purge` | Retira un activo añadido / los destinos generados, con snapshot previo |
| `upgrade` / `repair` | Actualiza y re-sincroniza / reaplica solo lo que falta o está roto |
| `worktrees` / `trunk` | Reaper conservador de worktrees / estado de la rama principal |
| `memory` / `context` | Ledger y `.planning/context-next.md` (solo taller) |
| `env` | `env exec -- <cmd>`: ejecuta con `.ai-hub/.env` cargado, sin bash ni PowerShell |
| `ci` | `ci gitlab` / `ci devcontainer` (Node + uv + bash): plantillas solo a petición, `--force` |
| `hooks` | `hooks install --pre-commit|--post-merge`: hooks de git que fallan abiertos |
| `gate` | Artefactos por feature, WIP, `--seal <hash>` fail-closed y comandos del manifiesto; `--quick` |
| `runs` | Telemetría cerrada en `.ai-hub/runs/`: `start`, `event` (`--from-status`), `note`, `end`, `list` |
| `control` | `control tick --dry-run [--json] [--issue] [--labels-from] [--online]`: propone, no aplica |
| `review` | `review consolidate <informes…>`: consolida el panel de refutación por stdout |
| `seal` | `seal review --verdict <APPROVE|APPROVE_WITH_NITS|CHANGES_REQUESTED> [--base <ref>]`: liga el veredicto al diff real; la guardia `ship` lo exige |
| `adopt` | Adopta un arnés heredado por fases: `--dry-run` primero, `--yes` con snapshot |
| `hook` | Hook de host `pre|post|stop` (stdin); siempre sale 0 |

`ai-hub help` lista los 28 comandos. `verify` es alias de `gate`.

### Credenciales (opt-in)

`init` ignora `.ai-hub/.env` y escribe solo `.ai-hub/.env.example` con `CHANGEME`. El `.env` real lo
crea la persona: a mano o en el último paso del asistente interactivo (saltable con Enter, enmascarado,
nunca con `--yes`). Ningún agente pide tokens; los comandos que los necesitan van por
`ai-hub env exec -- <cmd>`.

## Checks de Spec Kit en `doctor`

`doctor` verifica la instalación de Spec Kit leyendo `.specify/` y calculando hashes; no
ejecuta Python ni `uvx`. En el checkout del motor todos informan `no aplica`.

| Check | Criterio | Reparación |
|---|---|---|
| `speckit:managed` | `speckit.managed` no es `false`; un arnés con `--no-speckit` es **degradado** y `doctor` sale 1 | `ai-hub install` (sin `--no-speckit`) |
| `speckit:installed` | Existe `.specify/init-options.json` | `ai-hub install` |
| `speckit:version` | `speckit_version` cae dentro del rango soportado (o es exactamente la que restringe `speckit.version`) | `ai-hub install` |
| `speckit:script` | El script declarado en el manifest coincide con el instalado en `.specify/init-options.json` (`sh`/`ps`) | `ai-hub install` |
| `speckit:shell` | El shell del script declarado ejecuta `echo ok` (`bash` para `sh`, PowerShell para `ps`) | Instalar Git Bash/bash, o declarar `speckit.script: ps` |
| `speckit:integrations` | `.specify/integration.json` tiene exactamente las integraciones de los destinos con Spec Kit, sin `copilot`, y la integración por defecto declarada | `ai-hub install`; si aparece `copilot`, `specify integration uninstall copilot` |
| `speckit:targets` | Informativo: `copilot: sin Spec Kit` (recibe agentes y reglas, no comandos) | — |
| `speckit:extensions` | `bug` y `assess` instalados en la versión fijada, registrados y presentes en cada destino con Spec Kit | `ai-hub install` |
| `speckit:integrity` | Cada archivo de `.specify/integrations/*.manifest.json` existe; si su hash difiere solo avisa (el próximo `init` lo sobrescribe) | `ai-hub install`; personalizar con overrides de Spec Kit, no editando plantillas |
| `speckit:collision` | Ninguna ruta de `sync.lock.json` pertenece a Spec Kit | `ai-hub sync`; no publicar skills con nombre `speckit-*` |
| `speckit:constitution` | Aviso si `.specify/memory/constitution.md` sigue siendo la plantilla | Ejecutar `/speckit.constitution` (o `/speckit-constitution`) |
| `speckit:versioning` | En un repositorio git no se ignoran la constitución, `init-options.json` ni `specs/` | Quitar esas rutas de `.gitignore` |

## Estructura instalada

```
.ai-hub/            preset materializado, manifiesto y configuración (obligatoria)
.specify/           Spec Kit: constitución, plantillas, scripts, assessments y bugs (versionado)
specs/              features de Spec Kit: spec.md, plan.md, tasks.md (versionado)
.claude/ .opencode/ .pi/ .cursor/ .github/   destinos generados según targets (ignorados)
```

Una instalación no crea `.planning/`: es estado del checkout de desarrollo del motor.

## Codex

Cobertura parcial: con `agentsMd: true`, `sync` mantiene la región gestionada del `AGENTS.md`
raíz, que Codex lee. Skills, agentes, hooks y comandos de Spec Kit no llegan a Codex; el destino
completo está en el roadmap (P4).

## Lo que no viaja en el paquete

Todo lo que el consumidor usa llega con `npm i`. La única excepción declarada es
`scripts/upstream-watch.mjs`, la vigilancia del upstream (Spec Kit y dist-tags de npm): es una
herramienta del taller del mantenedor, vive fuera de `core/` y no está en `files`.

## Seguridad

Ver `SECURITY.md`: cómo informar una vulnerabilidad, alcance y rotación de credenciales.

## Procedencia de activos

Ver `NOTICE.md` para el origen de skills y agentes reutilizados.

## Licencia

MIT. Copyright (c) 2026 Daner Alejandro Salazar Colorado.

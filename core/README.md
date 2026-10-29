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
etiquetas. El paquete fija la versión de `specify-cli`, la de las extensiones y una
fecha `--exclude-newer` para las dependencias de `uvx`. Esa fecha se mueve solo en un
release, nunca automáticamente. `manifest.yaml` puede restringir la versión dentro del rango
soportado (`speckit.version`), elegir el script (`speckit.script: sh | ps`) y la integración
por defecto (`speckit.defaultTarget`), pero no ampliar la versión ni cambiar las extensiones.

- Spec Kit se instala en `claude`, `opencode`, `pi` y `cursor` (`cursor-agent`). **Copilot
  no recibe Spec Kit**: recibe agentes, reglas y la regla `ai-hub-speckit`.
- Sin `uv`, sin red y sin caché para la versión fijada, o sin `bash` con `script: sh`,
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
| `init` | Detecta el repo, elige preset e imprime el plan; `--yes` lo aplica |
| `install` | Materializa el preset y sincroniza destinos |
| `sync` | Reproyecta; `--check` no escribe, `--check-lock` verifica integridad |
| `drift` | Informa diferencias entre fuentes y destinos |
| `doctor` / `check` | Diagnóstico completo del arnés |
| `add` | Añade una skill o agente del catálogo al proyecto |
| `context` | Regenera `.planning/context-next.md` |
| `purge` | Retira los destinos generados, con snapshot previo |

## Checks de Spec Kit en `doctor`

`doctor` verifica la instalación de Spec Kit leyendo `.specify/` y calculando hashes; no
ejecuta Python ni `uvx`. En el checkout del motor todos informan `no aplica`.

| Check | Criterio | Reparación |
|---|---|---|
| `speckit:managed` | `speckit.managed` no es `false`; un arnés con `--no-speckit` es **degradado** y `doctor` sale 1 | `ai-hub install` (sin `--no-speckit`) |
| `speckit:installed` | Existe `.specify/init-options.json` | `ai-hub install` |
| `speckit:version` | `speckit_version` coincide con la versión fijada (o la que restrinja `speckit.version`) | `ai-hub install` |
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

## Procedencia de activos

Ver `NOTICE.md` para el origen de skills y agentes reutilizados.

## Licencia

MIT. Copyright (c) 2026 Daner Alejandro Salazar Colorado.

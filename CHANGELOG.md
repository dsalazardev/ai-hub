# Changelog

## 0.6.0 — Rol refuter y panel de refutación adversarial (2026-10-29)

### Añadido

- **Rol `refuter` (noveno rol):** el motor declara 9 roles. El noveno es la postura adversarial de revisión — refutar la preparación, no confirmarla —, declarado `read_only: true` (campo booleano opcional en el schema del engine): no modifica ningún archivo, su única salida es el veredicto, y no posee ningún comando Spec Kit. `crossValidate` rechaza un rol read-only que declare permisos de escritura, nombrando el rol y la violación.
- **Panel de refutación:** cuatro agentes nuevos publicados como agentes del motor en el perfil full (35 → 39): tres lentes (`refuter-correctness`, `refuter-security`, `refuter-tests`) más `finding-verifier`. Cada lente recibe exactamente los cuatro inputs del contrato — nunca la conversación ni la defensa del builder — y ataca a ciegas antes de comparar. El veredicto del panel es REFUTED / NOT-REFUTED; por hallazgo, el verifier emite `CONFIRMED`, `REFUTED` o `UNPROVEN`, y sólo `CONFIRMED` puede bloquear. `NOT-REFUTED` no es una aprobación: afirma que el ataque falló. El panel no mueve etiquetas ni aprueba nada; el gate de marca barre ahora también `core/agents`.
- **Validación de `role` en el catálogo:** un agente puede declarar `role` en su frontmatter; cuando está, debe existir en los roles del engine y la validación falla nombrando el agente y el rol desconocido. Las 29 declaraciones legacy (`reviewer`, `build-resolver`, `spec-miner`) que nunca fueron ids de rol quedan retiradas; el campo es opcional y no se proyecta a los destinos.

### Cifras medidas

Re-medidas en consumidor temporal con el CLI compilado y `uvx` real (specify-cli 1.2.5 dentro del rango soportado); la fórmula del plan las reproduce (`tests/fixtures/install-counts.json`). Los tres perfiles full-like crecen +16 destinos (4 agentes × 4 destinos de agente; cursor no declara superficie de agentes); `presetOnly` no cambia:

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.853 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.833 |
| `init --yes --preset angular-express` | 6.868 |

`full` instala 261 skills de proyecto + 17 comandos Spec Kit, 39 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.6.0`. No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.5.0 — Catálogo completo y marca de origen dsalazardev (2026-10-29)

### Ruptura

- **BREAKING — catálogo completo:** `skills.publish` pasa de 163 a 261 skills de proyecto: las 98 skills nuevas (ads … zapier) se publican integradas en orden alfabético. El catálogo queda con 272 SKILL.md: 261 publicadas más los 11 comandos Spec Kit que declaran `runtime: false` y el doctor ignora como huérfanas.
- **BREAKING — marca de origen:** toda skill publicada declara `origin: dsalazardev` (antes `origin: ai-hub`); los 272 SKILL.md quedan alineados y `dsalazardev` es la marca de origen oficial del catálogo.
- **Gate de marca extendido:** el patrón BRAND de `core/tests/brand.test.ts` proscribe además `origin: ai-hub` y `02-DOCS`; el vocabulario heredado del upstream se reescribió en el catálogo y en las reglas universales (`com.risco.contrast` → `com.dsalazardev.contrast` consistente entre fixture y script, `.rsc` → `.ai-hub`, vault `02-DOCS` → `docs/` con las rutas del SDD mapeadas a las canónicas del motor). `NOTICE.md` conserva intacta la procedencia upstream (rsc-harness, MIT).

### Cifras medidas

Re-medidas en consumidor temporal con el CLI compilado y `uvx` real (specify-cli 1.2.5 dentro del rango soportado); la fórmula del plan las reproduce (`tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.837 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.817 |
| `init --yes --preset angular-express` | 6.852 |

`full` instala 261 skills de proyecto + 17 comandos Spec Kit, 35 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.5.0`. No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.4.0 — Spec Kit por rango soportado y tres scripts siempre (2026-10-29)

### Ruptura

- **BREAKING — pin → rango:** el bloque `speckit` de `engine.yaml` ya no declara `pin` ni `excludeNewer`: `supported` (`>=1.2.3 <1.3.0`) es la única fuente de versión y toda resolución de `uvx` usa `--from specify-cli>=1.2.3,<1.3.0`, tomando la última estable dentro del rango (hoy 1.2.5). Sin rango, `uvx` resuelve una dev (`1.2.1.dev0`); con el rango, una major nueva queda excluida hasta que el motor lo amplíe en un release revisado. Los datos de motor que aún declaren `pin` o `excludeNewer` fallan al cargar nombrando el campo retirado.
- **BREAKING — `excludeNewer` eliminado:** con versión flotante, una fecha de resolución no acota nada coherente (una instalación de febrero con fecha de octubre resuelve distinto que una de noviembre con la misma fecha). Sale del bloque `speckit`, de `SpeckitSettings`, del plan y de los mensajes del preflight; la mención de la entrada 0.3.1 queda como historial publicado que describía el comportamiento vigente entonces. El preflight offline nombra el rango: «no se pudo resolver el rango soportado de specify-cli (>=1.2.3 <1.3.0) con uvx…».
- `speckit:version` valida por rango con `satisfiesRange(instalada, supported)`: una instalación con 1.2.5 pasa a estar sana (antes fallaba contra el pin exacto) y `1.3.0` o `1.2.1.dev0` siguen fallando, nombrando la instalada y el rango. `speckit:managed` informa el rango en lugar del pin.
- El hash del plan lleva la versión RESUELTA: capturada del stdout del sondeo (`uvx … --version`) en dry-run y de `init-options.speckit_version` tras instalar; sin resolución, el plan nombra el rango y el hash no depende de las herramientas de la máquina. Dos máquinas que resuelven 1.2.4 y 1.2.5 el mismo día dan hashes distintos: aceptado por diseño.
- `speckit.version` declarada por el proyecto sigue válida sólo dentro del rango y se instala exacta (`==<declarada>`); sin bloque `speckit`, el rango manda.

### Añadido

- Tres directorios de scripts siempre: una sola invocación de `init`/`install` corre internamente un `specify init` por tipo de script (los dos no elegidos primero y el elegido al final) y deja `.specify/scripts/{bash,powershell,python}` con 6 archivos cada uno y un manifiesto de integridad de 24 entradas. Los directorios de los tipos no elegidos existen pero nadie los invoca: comportamiento esperado, no un fallo. `doctor` no exige los tres: un proyecto viejo cuyo manifiesto declara sólo `scripts/bash` sigue sano.

### Cifras medidas

Las cifras de destinos no cambian respecto a 0.3.1 — los tres init internos escriben sólo en `.specify/`, que Spec Kit posee y `sync` nunca toca:

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 4.407 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 4.387 |
| `init --yes --preset angular-express` | 4.422 |

`full` instala 163 skills de proyecto + 17 comandos Spec Kit, 35 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.4.0`. No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.3.1 — resolución autónoma del shell de Spec Kit (2026-10-28)

### Añadido

- `shellCandidates` (`core/src/speckit/commands.ts`): para `script: sh` en Windows, el `bash` del PATH seguido de las rutas estándar de Git for Windows construidas desde `ProgramFiles`, `ProgramFiles(x86)` y `LOCALAPPDATA` (variable ausente → candidato omitido); las rutas absolutas se filtran por existencia antes de sondear. Linux y macOS quedan con el candidato único del PATH. `probeShell` devuelve además la lista de comandos probados (`tried`), con `platform` y `env` inyectables para los tests.
- Bandera `--script <sh|ps>` en `ai-hub init` y `ai-hub install`: valida el valor antes de sondear (otro valor → exit 2 nombrando `sh` y `ps`), resuelve bandera > `speckit.script` del manifest > motor, y persiste `speckit.script` en el manifest escrito sólo cuando la bandera se usó. El hash del plan sigue a la bandera (`speckitPlan` ya incluía `script`). Cambiar el script efectivo sobre una instalación existente reinstala Spec Kit con el nuevo valor.
- Check `speckit:script` de `doctor` (doceavo): compara `speckit.script` del manifest con el `script` de `.specify/init-options.json` y falla nombrando ambos valores; `speckit:shell` distingue ahora el shell resuelto fuera del PATH («resuelto fuera del PATH: <ruta>») del que está en el PATH.

### Corregido

- El mensaje de fallo del preflight de Spec Kit lista los comandos probados, nombra Git for Windows y ofrece la bandera exacta (`ai-hub init --script ps`, o `ai-hub install --script ps` cuando viene de `install`); ya no remite a `manifest.yaml`, que no existe en un proyecto nuevo.
- En Windows con el `bash` del PATH apuntando al lanzador de WSL sin distribución, `init`/`install` resuelven solos el Git Bash instalado en ruta estándar; antes la sonda reportaba `shell: missing` y el preflight fallaba.

### Cifras medidas

Las cifras de destinos no cambian respecto a 0.3.0 — medidas en copias temporales con el CLI compilado y `uvx` real (`tests/fixtures/install-counts.json`); la fórmula del plan las reproduce:

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 4.407 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 4.387 |
| `init --yes --preset angular-express` | 4.422 |

`full` instala 163 skills de proyecto + 17 comandos Spec Kit, 35 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.3.1`. La fecha de resolución `excludeNewer: 2026-10-27` no se mueve: 0.3.1 no repinne `specify-cli`; moverla es una decisión de release, nunca automática. No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.3.0 — integración de Spec Kit (2026-10-27)

### Ruptura

- **BREAKING — cuerpos `speckit-*`:** AI-Hub deja de poseer y proyectar los cuerpos de las 17 skills `speckit-*`; los 17 directorios `skills/shared/speckit-*` salen del paquete. Spec Kit (`specify-cli` 1.2.3 con las extensiones `bug` y `assess` 1.0.1) provee los 17 comandos en cada destino y es el único dueño de `.specify/**`, `specs/**` y sus comandos. `engine.yaml` conserva 17 comandos, 8 roles y 7 etiquetas; cada comando apunta a su id canónico (`speckit.plan`, `speckit.bug.assess`).
- **BREAKING — vocabulario de estados:** los estados de salida se normalizan a la salida de Spec Kit en mayúsculas (`GO`/`NEEDS_CLARIFICATION`/`KILL`, `VALID`/`NEEDS_REPRODUCTION`/`INVALID`, `APPLIED`/`PARTIAL`/`NOT_APPLIED`, `VERIFIED`/`PARTIAL`/`FAILED`, `CONVERGED`/`NEEDS_WORK`, y `DONE`/`BLOCKED` para los comandos sin veredicto). El vocabulario propio de 0.2.x queda retirado y lo rechaza el gate `engine:retired-states`. `KILL` e `INVALID` solo proponen `ai::done`: lo propone `hermes-control` y lo confirma un humano.
- **BREAKING — Copilot sin Spec Kit:** Spec Kit se instala en `claude`, `opencode`, `pi` y `cursor` (`cursor-agent`). Copilot recibe agentes, reglas y la regla `ai-hub-speckit`, pero no los comandos; `doctor` lo informa como `copilot: sin Spec Kit`. Las copias 0.2.x de `.github/skills/speckit-*` se retiran al migrar.
- Las 11 skills de la tercera cadena SDD (`specify`, `clarify`, `plan`, `tasks`, `analyze`, `implement`, `sdd`, `sdd-init`, `verify`, `review`, `ship`) llevan `runtime: false`: siguen en el paquete, pero no se instalan, materializan ni proyectan. El catálogo instalable pasa de 174 a 163 skills de proyecto.
- `init` e `install` requieren `uv` (`uvx`) y, con `script: sh`, un `bash` que ejecute. Sin ellos, o sin red ni caché para la versión fijada, salen con código 2 antes de escribir. `--no-speckit` instala sin Spec Kit y deja el arnés degradado (`doctor` 1) hasta un `install` sin la bandera.

### Añadido

- Instalación de Spec Kit con `uvx --from specify-cli==1.2.3 --exclude-newer <excludeNewer>`: `specify init` no interactivo con la integración por defecto y `--extension bug --extension assess`, y `integration install` + `integration use` por cada destino adicional; nunca `extension add --force`. El plan de `init` incluye la intención de Spec Kit en el hash y el entorno (uv, caché, shell) fuera.
- `excludeNewer: 2026-10-27` es la fecha de publicación de 0.3.0, declarada una sola vez en `engine/engine.yaml`. Moverla es una decisión de release, nunca automática.
- Propiedad única por archivo: `sync` no escribe ni borra rutas de Spec Kit, suelta del lock las entradas 0.2.x que pasan a Spec Kit sin borrar el archivo y poda los directorios que quedan vacíos.
- `doctor`: `speckit:managed`, `installed`, `version`, `shell`, `integrations`, `extensions`, `integrity`, `collision`, `constitution`, `versioning` y `speckit:targets` (informativo). Ninguno ejecuta Python ni `uvx`; en el checkout del motor informan `no aplica`.
- Regla generada `ai-hub-speckit` en los 5 destinos: roles, invocación por destino, tabla estado → etiqueta, rutas canónicas y sello.
- Contrato de `hermes-control` en `AGENTS.md` §5: tabla de estados y sello con rutas relativas a la raíz (`specs/<feature>/{spec,plan,tasks}.md`), con vector de prueba e implementación de referencia en `src/speckit/seal.ts`.
- `memory resume` y `context` leen la feature de Spec Kit (`specs/<feature>/tasks.md`) sin copiar su contenido a `.planning/`.
- Backup de `.specify/memory/**` y de la configuración de `.specify/` antes de ejecutar Spec Kit.

### Cifras medidas

Medidas en copias temporales con el CLI compilado y `uvx` real (`tests/fixtures/install-counts.json`); la fórmula del plan las reproduce:

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 4.407 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 4.387 |
| `init --yes --preset angular-express` | 4.422 |

`full` instala 163 skills de proyecto + 17 comandos Spec Kit, 35 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.3.0`; `npm pack --dry-run` sin ningún `skills/shared/speckit-*`.
- No se publica en npm desde esta sesión; el release queda condicionado al gate de CI y a una prueba en copia temporal.

### Rollback

- Volver a 0.2.x del paquete y `ai-hub restore <id>` con el backup que `install` crea antes de ejecutar Spec Kit.

## 0.2.0 — install completo

### Ruptura

- `ai-hub init` usa **`full` por defecto**: 191 skills (17 nativas + 174 de proyecto), 35 agentes, las 6 reglas universales y las reglas propias del preset. Con `generic-ts` son 4.662 destinos; con `angular-express`, 4.677.
- Un manifest 0.1.x sin `skills.selection`, `agents.selection`, `rules.selection` ni `catalog` se lee como `preset`. Un CLI 0.1.x **no** lee un manifest 0.2 con esos campos: actualiza el CLI antes de migrar.
- `install` sobre un manifest existente conserva su selección; no expande a `full` sin `--full` ni `upgrade`.
- `.planning/` deja de crearse en una instalación. `memory` y `context` reportan `no aplica en instalación`; `init --migrate` sólo funciona en el checkout del motor.

### Añadido

- `--preset-only` conserva el mínimo de 0.1.x: 0 skills de proyecto, 6 agentes, 2 reglas y 120 destinos.
- `--exclude skill:<id>,agent:<id>,rule:<id>` y `skills.selection`/`agents.selection`/`rules.selection`; `--exclude rule:skill-quality` deja el catálogo completo con 2 reglas y 4.642 destinos.
- `catalog.version` y `catalog.hash` por dimensiones `full`; `doctor` distingue un catálogo actualizado (aviso, exit 0) de un `publish` editado (exit 1) y `upgrade` refresca el sello.
- Las 4 rúbricas de `skill-quality` se materializan en `.ai-hub/rules/` y viajan en `core/rules/` dentro del paquete; un test SHA-256 exige que la copia del taller sea idéntica.
- `add agent` acepta cualquier agente del catálogo; `uninstall` acepta reglas y sólo cambia la dimensión afectada.
- MCP es una fuente explícita del consumidor (`mcp-manifest.yaml`). Sin ese archivo, no se generan `.mcp.json`, `.cursor/mcp.json` ni `.vscode/mcp.json` y `doctor` dice `MCP: no configurado`.
- `doctor` verifica completitud por dimensión y escanea el catálogo instalado; el versionado de destinos es opcional y no ejecuta `git ls-files` fuera de un repositorio.
- `init` escribe reglas idempotentes en `.gitignore` para destinos generados; `.ai-hub/` y `sync.lock.json` siguen versionados.
- Suite `unit` (10 s) e `integration` (60 s) en serie, índice de catálogo compartido por `globalSetup` y guard estructural de un solo barrido.
- `core/scripts/measure-install.mjs` mide lock, archivos, bytes y tiempos cold/warm; `--budget` permite fijar el presupuesto.

### Empaquetado

- `core/package.json` en `0.2.0`; `npm pack --dry-run` reporta 1.296 entradas y las 4 rutas `rules/skill-quality/*.md`.
- No hay `postinstall`. `prepublishOnly` ejecuta `build`, `manifest:build` y `npm test` (unit + integración).
- No se publica en npm desde esta sesión. El release queda condicionado al gate de CI y a una prueba en copia temporal.

### Rollback

- `uninstall` de los activos añadidos o `purge` con backup; `restore` recupera el snapshot. `init` crea backup cuando ya existe un manifest.

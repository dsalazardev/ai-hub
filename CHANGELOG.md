# Changelog

## 0.13.0 — control-onboarding: conexión automática del plano de control (2026-11-09)

`ai-hub init` deja el plano de control **completo y funcionando en una sola pasada opt-in**, con un bot propio
por proyecto, cuando detecta Hermes ≥ 0.23 y hay terminal. Antes había que editar `manifest.control` a mano,
crear el bot, pegar el token en el `.env` de un perfil y ejecutar `control enroll`. **Opt-in:** sin Hermes, o si
la persona salta el paso, nada cambia. Hermes y Discord siguen siendo **externos y opcionales**.

### Cambio

- **Nuevo paso al final del asistente de `init`** (mismo patrón que el del tracker): una pregunta de entrada
  (vacío = saltar) y, si se acepta, todo obligatorio en este orden: token del bot de Discord (enmascarado),
  canal de control, id del aprobador, TTL y expiración con valores por defecto seguros. Cancelar en cualquier
  punto deja **cero** escrituras del bloque.
- **Validación antes de guardar**: el token y el canal se comprueban contra la API de Discord; un 401 nunca se
  guarda y se vuelve a preguntar. Sin red, guarda solo con `--allow-unvalidated`.
- **El arnés escribe, la persona no toca YAML ni `.env`**: `manifest.control`, el perfil `hermes-control`
  (`hermes profile create … --no-skills`, sin clonar), su `.env` con el token tecleado y la proyección del canal
  y de los aprobadores; después `control enroll --yes` y el reinicio del gateway si está instalado.
- **Perfil independiente con bot propio**: un token ya usado por otro perfil se rechaza nombrando el perfil, sin
  imprimir nada secreto. Un perfil con otro bot no se sobrescribe sin `--reconfigure-hermes`.
- **Siembra de la idea**: con idea y sin `IDEA.md`, lo deja en la raíz enlazado a `backlog/seed.md`, que sigue
  siendo la fuente. Sin idea, no escribe nada.
- **Resumen de cinco líneas**: perfil, canal, aprobador, TTL y `ai-hub control enroll --check`.
- **Modo no interactivo explícito**: `init --connect-hermes` con `--discord-channel`, `--approver`, `--ttl-hours`
  y `--expire` por flags y el token **solo por stdin** (`--discord-token-stdin`); `--discord-token <valor>` sale
  con código 2 antes de escribir nada.
- **Idempotencia**: una segunda corrida con las mismas respuestas no crea nada y deja el `.env` del perfil
  idéntico. El hash del plan no cambia al aceptar o saltar el paso.
- Specs: capability nueva `control-onboarding` (15 requisitos, 27 escenarios) y **dos requisitos modificados**:
  `hermes-control` (el único token que el paquete escribe es el que la persona teclea, y solo en el `.env` del
  perfil) e `interactive-onboarding` (la excepción de credenciales cubre **dos** pasos opt-in, tracker y control).

### Sin cambios en los caminos sin Hermes

Sin Hermes, `init` da **0 líneas de diferencia** y el mismo hash de plan que 0.12.0; `doctor` solo cambia la ruta
del directorio y mantiene el código de salida. No se escriben ni `IDEA.md` ni `manifest.control`.

### Cifras medidas

Re-medidas con el CLI compilado de 0.13.0 en copias temporales (`--no-speckit`); idénticas a 0.12.0:

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.872 |
| `init --yes --preset-only` | 66 |
| `init --yes --exclude rule:skill-quality` | 6.852 |
| `init --yes --preset angular-express` | 6.887 |

`full` instala 262 skills de proyecto + 17 comandos Spec Kit, 40 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.13.0`. Tarball: **1.981 → 1.985 entradas** (+4: `dist/control/onboard` y
  `dist/control/onboard-step`, en `.js` y `.d.ts`). Es el único delta respecto de 0.12.0: el paso vive dentro de
  `onboarding.ts` y `assistant.ts`, sin archivos nuevos fuera de `dist/control/`.

### Pendiente del propietario

Verificación en vivo con un token y un canal reales: el diseño asume `GET /users/@me` para validar el bot y
`hermes gateway restart` para conectarlo. Publicar (`npm publish --access public` desde `core/`) es del propietario.

## 0.12.0 — hermes-control: plano de control opt-in (2026-11-09)

El lado del arnés de `hermes-control`: GitLab es el tablero (las 7 etiquetas `ai::`), una persona aprueba por
Discord y el arnés verifica, redacta cada decisión y aplica solo lo aprobado. **Opt-in:** sin `manifest.control`
nada cambia. El runtime de Hermes y Discord es **externo y opcional**; el paquete no gana dependencias.

### Cambio

- `ai-hub control` gana `decide` (publica decisiones deterministas e idempotentes, una por mensaje de Discord),
  `ingest` (evento de GitLab por stdin, sin LLM: solo issues y MR del proyecto, deduplicado, un cambio manual de
  etiqueta anula lo pendiente), `apply` (gramática `aprobar <iid> <hash>` / `rechazar` / `detalle`, lista de
  aprobadores, relectura de la etiqueta, sello y WIP; un PUT que añade el destino y retira las demás `ai::`, más
  una nota de evidencia con marcador), `expire` (caducidad → `ai::blocked` con `approval_expired`, o solo aviso) y
  `enroll` (perfil `hermes-control`, skill, scripts, webhook y cron en Hermes ≥ 0.23; `--dry-run` primero,
  `--check` de credenciales de Discord por presencia; nunca pasa ni imprime secretos). `help` sigue en 28.
- `control tick --online` lista el tablero, liga issue ↔ feature por `ai-hub:feature=`, toma el hash aprobado
  solo de la nota del plano de control y acepta líneas de estado de un motor remoto como evidencia de rango
  inferior (`remote`; `ai::done` exige gate local o pipeline verde). `--ref <rama>` para el sello (mismo vector §5).
- `doctor`: check `control` (`no configurado` sin el bloque, sin degradar) y, con `--online`, `tracker:scope`
  (aviso si el token puede hacer push o caduca en < 14 días). `SECURITY.md`: rotación de las tres credenciales.
- Specs: capability nueva `hermes-control` (23 requisitos) y 4 deltas en `spec-kit-pipeline` (1 modificado,
  3 añadidos).
- `npm test` del paquete pasa a ser serial (`vitest run --maxWorkers=1`, el mismo comando que el gate de
  publicación); `npm run test:fast` queda para iterar.

### Sin cambios en los caminos sin Hermes

Sin `manifest.control`, `init` y `control tick --dry-run --json` dan la misma salida que 0.11.0 y `doctor` el mismo
código; solo gana la línea `[OK] control: no configurado`. La regla `ai-hub-speckit` incluye el marcador
`ai-hub:feature=`: un consumidor de 0.11.0 ve 5 destinos desactualizados hasta su próximo `sync`.

### Cifras medidas

Re-medidas con el CLI compilado de 0.12.0 en copias temporales (`--no-speckit`); idénticas a 0.11.0:

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.872 |
| `init --yes --preset-only` | 66 |
| `init --yes --exclude rule:skill-quality` | 6.852 |
| `init --yes --preset angular-express` | 6.887 |

`full` instala 262 skills de proyecto + 17 comandos Spec Kit, 40 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.12.0`. Tarball: **1.956 → 1.981 entradas** (+25: `dist/control/{apply,cli,decide,
  doctor,enroll,hermes,ingest,ledger,render,reply,tracker}` × 2 y `engine/templates/hermes/{control-poll.sh,
  gitlab-route.sh,SKILL.md}`).

### Pendiente del propietario

Verificación en vivo, fuera de los fixtures: entrega real a Discord, webhook alcanzable desde GitLab (VPS o túnel)
y `hermes cron run` del sondeo. Publicar (`npm publish --access public` desde `core/`) es del propietario.

## 0.11.0 — factory-evolution: credenciales, guardias reales, persistencia, contrato del bucle, adopción e inventario (2026-11-08)

Seis lotes aplicados en orden (D → B → C → A → E → F), con la suite en verde entre lotes. Sin breaking
(PD-4): los caminos válidos en 0.10.0 dan las mismas salidas y códigos; un `install` de 0.11.0 sobre una
instalación de 0.10.0 deja `drift` y `doctor` en verde.

### Lote D — credenciales y tracker (cierra la fuga)

- `init` ignora `.ai-hub/.env` y `.ai-hub/runs/` antes de que existan y materializa solo
  `.ai-hub/.env.example` con `CHANGEME`. **El paquete nunca escribe credenciales** (PD-1).
- `ai-hub env exec -- <cmd>` carga `.ai-hub/.env` sin bash ni PowerShell (exit 7 sin `.env`, 2 sin `--`).
- `manifest.tracker` cerrado; `doctor` gana `env:ignored`, `env:keys` y, con `--online`, `tracker:token`
  (identidad redactada). Ningún check ni test lee valores de token.
- Paso opt-in del asistente (último, saltable con Enter, enmascarado, nunca con `--yes`; el hash del plan
  no cambia).
- `gitlab-auth` reescrita sin host de cliente ni `load-env.sh`; `ai-hub ci gitlab` y `ai-hub hooks install`
  (fallan abiertos sin `npx`).

### Lote B — integridad, gate y hooks reales

- `catalog:references` (taller y `doctor`): rutas `.ai-hub/**`, comandos, `subagent_type`, enlaces,
  `.planning/` y `route_to` de los evals; línea base fechada de deuda heredada.
- `ai-hub gate` (`verify` es alias): artefactos por feature, WIP ≤ `policy.wip`, `--seal` fail-closed y los
  comandos del manifiesto con el shell resuelto (nunca `bash` del PATH).
- Hooks ejecutables `ai-hub hook pre|post|stop`: Claude (`.claude/settings.json` mezclado por clave, fuera
  del lock) y OpenCode (plugin); Cursor, Copilot y Pi declaran solo regla. `doctor` comprueba hooks reales.
- Preflight con `ask` y guardia de alcance post-paso contra `can_modify`; `list --collisions`.

### Lote C — persistencia, telemetría y control

- PD-2: `.ai-hub/work/<feature>/` y `.ai-hub/lessons.md` versionados; `.ai-hub/runs/` ignorado con
  retención `policy.runs.keep` (50). `can_modify` de los revisores pasa a `.ai-hub/work/**`.
- `ai-hub runs start|event|note|end|list` con esquema cerrado (nunca prompts, contenido, tokens ni entorno).
- `ai-hub control tick --dry-run`: propone transiciones por `exit_effects`, revalida el sello, aplica
  `max_rounds` y lista lo pendiente de OK humano. No escribe, no mueve etiquetas, no comenta.
- Agente `narrator`, regla `ai-hub-lessons` en los 5 destinos y skill `improve-from-runs`.

### Lote A — comunicación y contrato del bucle

- Línea de cierre `AI-HUB-STATUS: <STATE> | artifact=<ruta|-> | reason=<código>[: <frase>]` generada desde
  `engine.yaml` y proyectada en `ai-hub-speckit`; `loop.converge.max_rounds: 3`.
- Cabeceras abstractas de agentes (`capabilities`, `max_turns`, `tier`) traducidas por destino; modelo por
  `manifest.agentModels`; `agents:capabilities` en `doctor`.
- `ai-hub review consolidate` (solo stdout) y el panel de refutación en el preset `base`.

### Lote E — adopción, áreas y refresco

- `ai-hub adopt` por fases F0–F4 con snapshot previo (probado solo con fixtures sintéticos).
- Región gestionada de `AGENTS.md` (`agentsMd: true`), `paths.areas` y políticas que solo endurecen.
- Refresco de tres vías del scaffold (ver "Hallazgos y resoluciones").

### Hallazgos cerrados

G-01 (guardias no conectadas → hooks reales), G-02 (fuga del token y host de cliente en el catálogo),
G-03 (`.planning/` en el catálogo publicado), G-04 (skills que invocaban comandos inexistentes; la última
excepción fechada, `sello`, se cierra con `seal review`), G-05 (`can_modify` no mecánicos), F-03
(`gitlab-auth`/`load-env.sh`), F-04 + F-15 fase (a) (`control tick` en observación), F-12 (`verify` con
bash crudo), F-17b (barrido de rutas), F-16 (adopción diseñada y probada con fixtures; ningún repositorio
de cliente se tocó).

### Fuera de este release

`hermes-control` (plano de control que aplica etiquetas), cualquier cambio en repositorios de clientes,
el destino Codex completo (P4), ampliar Spec Kit a 1.3.x (v1.3.2 existe; otro change) y la publicación en
npm (paso del propietario).

### Cifras medidas

Medidas con el CLI compilado en copias temporales (`core/tests/fixtures/install-counts.json`, con
`--no-speckit`):

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.872 |
| `init --yes --preset-only` | 66 |
| `init --yes --exclude rule:skill-quality` | 6.852 |
| `init --yes --preset angular-express` | 6.887 |

`full` instala 262 skills de proyecto + 17 comandos Spec Kit, 40 agentes y 6 reglas universales.
Suite: 36 archivos, 495 tests y 2 omitidos (enlaces simbólicos en Windows y, hasta este ritual, la
comprobación de cifras del release).

### Empaquetado

- `core/package.json` en `0.11.0`. Tarball real: **1.956 entradas** (0.10.0: 1.890; +66 —
  D +14, B +14, C +9, A +8, E +10, F +11), 4.574.861 bytes empaquetado / 12.775.773 desempaquetado. El
  diseño estimaba ≈1.932 (rango 1.920–1.945); la diferencia son módulos `.js`/`.d.ts` de `dist` que la
  estimación no contaba. `pack.test` fija la cifra medida.
- No viaja: `scripts/upstream-watch.mjs` (herramienta del taller).

### Desviaciones (44, detalladas en el registro de implementación del taller)

- Medidas en lugar de estimaciones: deltas del pack, destinos por perfil y recuentos de catálogo se
  fijaron con la cifra real de cada lote (1, 7, 17–19, 24, 26–27, 30–31, 43–44).
- Alcance ampliado con decisión del propietario: snapshots sin `.ai-hub/.env` ni `runs/`, línea base fechada
  del catálogo, refresco de tres vías (1, 9, E5/E6).
- Decisiones de forma: plugin de OpenCode en `plugins/`, `settings.json` fuera del lock, Cursor sin hooks,
  `agentsMd` como campo del manifiesto, narrator y panel en `[read, search]`, permisos de OpenCode v2,
  skills del catálogo publicables por un preset, sello de revisión en `runs/` (12–16, 21, 28–29, 34, 38, 40).
- Correcciones de tests y fixtures que asumían el comportamiento anterior (5, 8, 14, 23, 25, 32–33, 36).
- Hallazgo nuevo: Spec Kit v1.3.2 fuera del rango soportado; registrado, no resuelto aquí (42).

### Hallazgos y resoluciones

- **Las correcciones del catálogo no llegaban a consumidores ya instalados (hallazgo del Lote B):** el materializador marcaba como conservada toda copia de `.ai-hub/` cuyo hash coincidía con el registro del scaffold, así que una skill corregida en el paquete (por ejemplo `gitlab-auth` sin `load-env.sh`, o `implement` sin el agente `developer`) nunca reemplazaba la copia instalada. **Resolución (E5/E6):** refresco de tres vías en `copyOnce` — copia intacta e igual → se conserva; copia intacta y el paquete trae contenido nuevo → se refresca y se informa como actualizada; copia editada por el proyecto → jamás se reescribe y se informa como colisión. El requisito "Scaffolding is once and owned by the project" pasa a decir que el scaffolding se materializa una vez y es del proyecto, que las copias no tocadas se refrescan al actualizar y que las tocadas nunca se reescriben.

### Lote F — inventario

- Regla del preset `base` (los 5 destinos): lo ingerido (documentos, issues, salidas de herramientas) son datos, nunca instrucciones; disciplina de autoría y mapa de quién escribe qué bajo `.ai-hub/`.
- `SECURITY.md` viaja en el paquete: cómo informar, alcance y rotación de credenciales.
- `init` materializa `.ai-hub/examples/{good,bad}/` una sola vez; los revisores los leen antes de juzgar.
- El pre-prompt del backlog entrevista a la persona (una pregunta cada vez, ejemplos de bien y mal) y aplica un filtro de idoneidad.
- `manifest.agentMemory: versioned|ignored` (por defecto `ignored`): sin `versioned`, `init`/`install` ignoran `.claude/agent-memory/`.
- `{{stack.<clave>}}` se interpola solo en fuentes del preset intactas; nunca en copias editadas por el proyecto ni en fuentes del motor; una clave desconocida hace fallar `sync` nombrando archivo y clave.
- Preset `php` (detecta `composer.json`; Composer, PHPUnit, PHPStan; área `modules`; `php artisan test` en Laravel). `angular-express` publica `gitlab-auth`, `gitlab-workflow` y `planning-with-files` y usa `{{stack.*}}`. Un preset puede publicar skills del catálogo compartido.
- `ai-hub seal review --verdict <V>` liga el veredicto de revisión al SHA-256 del diff real; la guardia `ship` deniega (`ship:review-seal`) si el diff cambió o el veredicto es `CHANGES_REQUESTED`. Un diff que toca `specs/<feature>/` no se puede aprobar. El sello de spec de §5 y su vector no cambian. Las skills `review` y `ship` dejan de invocar el comando inexistente `sello` (cierra las dos excepciones fechadas de la línea base del catálogo).
- `ai-hub ci devcontainer` escribe `.devcontainer/devcontainer.json` (Node + uv + bash) solo a petición.
- Codex: cobertura parcial vía la región de `AGENTS.md`; el destino completo queda en el roadmap (P4).
- **No viaja:** `scripts/upstream-watch.mjs` (vigilancia de Spec Kit y de los dist-tags) es la única pieza del taller fuera del paquete.

### Pasos del propietario (publicación y dist-tag)

Los ejecuta el propietario, nunca el ritual automatizado ni un agente:

```bash
npm publish --access public            # desde core/
npm dist-tag rm @dsalazardev/ai-hub-cli next   # retira el dist-tag obsoleto next=0.3.0
npm view @dsalazardev/ai-hub-cli dist-tags     # debe quedar solo latest
```

## 0.10.0 — Autorreparación de fuentes de `.ai-hub/` (2026-11-06)

### Cambio

- **`install` y `repair` restauran fuentes borradas (F-01, único P1):** borrar una skill o regla fuente de `.ai-hub/` dejaba el arnés sin salida — `install`, `install --full` y `repair` abortaban con "manifiesto inválido" ANTES de que `materializeSelection` (que la restauraría) pudiera correr. La validación del manifiesto pasa a **dos capas**: la de carga (schema ajv, roles, Spec Kit, targets, ids desconocidos en `publish`) sigue siempre fail-closed, y la de activos (existencia y frontmatter de las fuentes) es estricta por defecto y tolerante sólo cuando `install`/`repair` cargan para autorreparar: `loadManifestContext(root, { assets: 'strict' | 'tolerant' })`, default `'strict'` — ningún lector (doctor, list, sync, add, context) cambia.
- **Tolerante = restaurable, nunca más:** una fuente ausente se tolera sólo si su id existe en el catálogo del motor, resuelto por la misma vía que `materializeSelection` (skills por catálogo del motor o preset; rules por rúbricas universales, preset o cadena — el fallback que los agentes ya tenían). Un id ausente de `.ai-hub/` Y del catálogo produce el mismo `ManifestError` de antes, antes de escribir, en ambos modos — el fail-closed del consumidor queda intacto (sonda: `skill-inexistente-xyz` → exit 1 sin escrituras en strict y en tolerant).
- **Revalidación estricta post-materialización:** tras `materializeSelection`, `install` revalida el manifiesto nuevo con la validación estricta completa antes de escribirlo y antes de `runSync` — nunca se proyecta un arnés incompleto a los destinos. El frontmatter corrupto de una fuente PRESENTE sigue fallando en ambos modos: la tolerancia cubre ausencia, no corrupción.
- **`--dry-run` sin falsos negativos:** el dry-run carga en modo tolerante, imprime el plan (`"dryRun": true`) y no escribe nada ni revalida — antes abortaba en la carga con una fuente borrada, impidiendo planificar la reparación.
- **Hueco de test cerrado (F-17):** el único test de repair borraba un destino generado, no una fuente; ahora hay sondas de fuente borrada → repair/install exit 0 con la skill restaurada byte a byte desde el catálogo, id desconocido → exit 1 sin escrituras, doctor/sync estrictos nombrando la ausencia, y tests unitarios de los modos de `validateManifestData`. `restore` y el check `manifest` del doctor no se tocan.

### Cifras medidas

Sin cambios respecto a 0.9.0 — la recuperación no añade destinos y toda invocación existente queda igual (los lectores siguen estrictos byte a byte); la fórmula del plan las sigue reproduciendo (`core/tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.853 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.833 |
| `init --yes --preset angular-express` | 6.868 |

`full` instala 261 skills de proyecto + 17 comandos Spec Kit, 39 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.10.0`. Tarball: 1.890 entradas, sin cambios (el código nuevo vive en `dist/manifest/manifest.js` y `dist/cli/onboarding.js`, archivos ya empaquetados); unpacked 12.539.116 → 12.541.894 bytes (+2.778, sólo `dist`). No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.9.0 — Banner neón del CLI (2026-11-04)

### Cambio

- **Banner de identidad neón:** el asistente de `init` abre con el arte slant de "AI-HUB" (render canónico verificado contra `slant.flf` oficial: 5 líneas de 42/43/43/42/40 columnas) con gradiente vertical cian `#00F2FE` → azul `#0072FF` construido a mano en ANSI puro — interpolación RGB por línea en truecolor (`\x1b[38;2;R;G;Bm`), degradación al cubo 6×6×6 en 256 colores (`\x1b[38;5;Nm`) y modo sin escapes con `NO_COLOR`. Debajo, `» Autonomous Software Factory` (» en cian neón, texto en blanco brillante) y la versión del paquete en gris alineada al ancho — resuelta en runtime por `cliVersion()` y pasada por parámetro, jamás una constante (sonda anti-hardcode que lee el fuente del módulo). **Cero dependencias nuevas**: el gradiente es interpolación pura; la cláusula "pure ANSI escapes… no new dependencies" del spec y la decisión D8 de `script-choice` se conservan intactas.
- **Fallback de ancho:** por debajo de 60 columnas el banner es una línea minimalista (`AI-HUB · Autonomous Software Factory · vX.Y.Z`) sin arte — deformar un ASCII art no tiene sentido — que degrada a `AI-HUB · vX.Y.Z` antes del clamp. Con 60 columnas o más, el arte se centra y el separador escala al ancho completo.
- **Contratos intactos:** `renderBanner(width, mode, version)` sigue siendo una función pura (sin `process`, sin `fs`, sin clack); la detección de `COLORTERM`/`NO_COLOR` y la resolución de la versión viven en el adaptador clack, que se sigue cargando sólo tras el gate de TTY. La salida pipeada es byte a byte la de 0.8.0 (sonda de diff vacío en los cinco comandos de la línea base: bare init, `--dry-run`, `--preset`, `--yes --no-speckit` y `--dry-run` en el checkout del motor).

### Cifras medidas

Sin cambios respecto a 0.8.0 — el banner vive tras el gate de TTY y toda invocación existente queda byte a byte igual (diff pipeado vacío contra la línea base); la fórmula del plan las sigue reproduciendo (`core/tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.853 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.833 |
| `init --yes --preset angular-express` | 6.868 |

`full` instala 261 skills de proyecto + 17 comandos Spec Kit, 39 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.9.0`. Tarball: 1.890 entradas, sin cambios (todo vive en `dist/cli/banner.js` y `dist/cli/assistant-clack.js`, archivos ya empaquetados); unpacked 12.535.153 → 12.539.116 bytes (+3.963, sólo `dist`). No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.8.0 — Conjunto de scripts de Spec Kit elegible, `py` como activo y banner de identidad (2026-10-30)

### Cambio

- **Conjunto de scripts elegible (`--scripts`):** `init`/`install` aceptan `--scripts` con una lista comma-separated de `sh`, `ps`, `py` (mínimo un valor, sin duplicados) y materializan exactamente ese conjunto: `--scripts py` instala sólo `.specify/scripts/python` (6 archivos más su manifiesto de integridad); los `specify init` van tipo por tipo con el activo al final. **Esto revierte parcialmente, de forma deliberada y documentada, la decisión ratificada en `speckit-latest` (0.4.0)** de que los tres tipos se instalan siempre, obligatorio y sin opt-out: el conjunto pasa a ser elegido por el instalador. La compatibilidad es byte a byte: un manifest sin `speckit.scripts` y una invocación sin `--scripts` siguen instalando los tres tipos exactamente como en 0.4–0.7 (sonda de diff pipeado vacía contra la línea base de 0.7.0).
- **`py` como activo:** `--script` acepta `py` además de `sh`/`ps`. La sonda del intérprete es `python -c "print('ok')"` con candidatos `python`, `python3`, `py` en ese orden en toda plataforma, reutilizando el contrato `stdout.trim() === 'ok'` existente; el preflight nombra Python como instalación faltante con sus alternativas exactas (`--script sh`, `--script ps`) y `doctor` reporta `speckit:shell` con el intérprete resuelto.
- **Activo dentro del conjunto (fail-closed):** el activo resuelto por precedencia (flag → manifest) no puede caer fuera del conjunto efectivo (flag → manifest → los tres): la contradicción explícita sale con código 2 antes de escribir, nombrando ambos campos. Un `--script` explícito pisa al `speckit.script` del manifest (la migración procede); el default del engine coacciona dentro del conjunto. `speckit.scripts` se persiste en el manifest sólo con flag explícito.
- **Plan body condicional:** el plan hasheado incluye `speckit.scripts` sólo cuando el conjunto difiere de los tres por defecto en orden y miembros: `--scripts sh,ps,py` explícito produce el mismo hash que la invocación sin flags; una permutación u otro conjunto sí lo cambia.
- **TUI:** el paso de scripts del asistente pasa a ser un multi-select del conjunto (Python/Shell/PowerShell preseleccionado con los tres, mínimo uno — cero no deja continuar) más un select del activo sólo cuando elige más de un tipo, con notas del shell resuelto para `sh` y del intérprete para `py`. El asistente abre con un **banner de identidad** ("AI-HUB — Autonomous Software Factory"): bloque azul ANSI puro con letter-spacing, función pura en `core/src/cli/banner.ts`, sin dependencias nuevas, apagado por `NO_COLOR` y ausente de toda salida pipeada porque el adaptador clack sólo se carga tras el gate de TTY.
- **Extensiones de Spec Kit por rango (`extension-ranges`):** `speckit.extensions.assess` y `bug` pasan del pin exacto `1.0.1` al rango `>=1.0.1 <1.1.0` en el engine data, y la verificación post-instalación y el check `speckit:extensions` del doctor validan la versión instalada con `satisfiesRange` contra el rango, con mensaje que nombra la instalada y el admitido. Mismo patrón y mismo precedente que `speckit-latest` (0.4.0) aplicó a `specify-cli`: un pin exacto de un paquete vivo se pudre con cada publicación del upstream — el disparador fue `1.0.2` publicado por el upstream, que ponía los dos tests de instalación real en rojo determinista (el instalador siempre instala la última porque pasa `--extension` sin versión; el pin sólo verificaba). El engine data ahora rechaza un pin exacto de extensión igual que rechaza el de `specify-cli`. El instalador no cambia; el rango excluye a propósito un minor nuevo (1.1.0), como el rango de `specify-cli` excluye 1.3.0.

### Cifras medidas

Sin cambios respecto a 0.7.0 — el conjunto por defecto y toda invocación existente quedan byte a byte iguales (diff pipeado vacío contra la línea base); la fórmula del plan las sigue reproduciendo (`core/tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.853 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.833 |
| `init --yes --preset angular-express` | 6.868 |

`full` instala 261 skills de proyecto + 17 comandos Spec Kit, 39 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.8.0`. Tarball: 1.888 → 1.890 entradas (`dist/cli/banner.js` + `dist/cli/banner.d.ts`); unpacked 12.520.573 → 12.535.153 bytes (+14.580, sólo `dist`). No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

## 0.7.0 — Asistente de onboarding interactivo y semilla de backlog (2026-10-30)

### Añadido

- **Asistente TUI de `ai-hub init`:** `init` sin flags en una terminal real (TTY en stdout y stdin, fuera del checkout del motor) abre un asistente de `@clack/prompts`. El gate vive al inicio de `cmdInit`, antes de `resolveSelection`: con cualquier flag, pipe o CI ni una línea del asistente se ejecuta y la salida pipeada es byte a byte la de 0.6.0. El asistente es una generadora de flags, no un camino paralelo: cada decisión se resuelve a los flags existentes (`--targets`, `--preset`, `--full`/`--preset-only`/`--exclude`, `--script`) y el plan lo construye el mismo `planBodyFor` — el mismo input por asistente y por flags da el mismo plan y el mismo hash (sonda permanente en `core/tests/assistant.test.ts`). Pasos: (1) destinos multi-select con preselección por detección (`<comando> --version`), (2) preset detectado con empate→elección explícita, (3) perfil full/preset-only/custom con excludes guiados, (4) script sh/ps informando el shell resuelto, (5) entorno + verificación de herramientas (informativa: el login jamás se verifica; el preflight de Spec Kit sigue fail-closed con exit 2 antes de escribir), (6) idea del proyecto opcional, (7) plan — el mismo JSON de `--dry-run` — y confirmación. Cancelar en cualquier paso no escribe un byte.
- **Semilla de backlog y pre-prompt:** con idea, la confirmación escribe `backlog/seed.md` (idea textual + fecha + apuntador) y `backlog/pre-prompt.md` (plantilla bilingüe del motor que instruye al agente del cliente — no al CLI — a convertir la idea en items con criterio de aceptación verificable, priorizarlos y arrancar con `/speckit.constitution` y `/speckit-assess-intake`). La semilla es un activo versionable del proyecto: fuera del plan body (el hash no cambia con la idea), fuera del lock, `sync` no la toca y el `.gitignore` generado no la ignora.
- **Aviso de doctor:** en instalación, `doctor` informa si la semilla está presente (`[OK] backlog: semilla presente…`) o ausente; informativo como el aviso de la constitución, nunca un gate.

### Dependencia

- `@clack/prompts` ^1.8.1, única dependencia nueva: JS puro sin binarios nativos. Su árbol en `node_modules` mide **170.333 bytes (166,3 KB)** (`@clack/prompts` 93.683 + `@clack/core` 55.634 + `sisteransi`, `fast-wrap-ansi`, `fast-string-width`); la estimación «~200 KB unpacked» de la propuesta quedó en 166,3 KB medidos. El tarball publicado no incluye `node_modules`: crece sólo por los 6 archivos nuevos de `dist` (`assistant`, `assistant-clack`, `preprompt` × `.js`/`.d.ts`).

### Cifras medidas

Sin cambios respecto a 0.6.0 — la semilla y el pre-prompt no son destinos ni entran al lock; la fórmula del plan las sigue reproduciendo (`core/tests/fixtures/install-counts.json`):

| Instalación | Destinos en `sync.lock.json` |
|---|---|
| `init --yes` (`generic-ts`, full) | 6.853 |
| `init --yes --preset-only` | 40 |
| `init --yes --exclude rule:skill-quality` | 6.833 |
| `init --yes --preset angular-express` | 6.868 |

`full` instala 261 skills de proyecto + 17 comandos Spec Kit, 39 agentes y 6 reglas universales.

### Empaquetado

- `core/package.json` en `0.7.0`. Tarball: 1.882 → 1.888 entradas; unpacked 12.490.323 → 12.520.573 bytes (+30.250, sólo `dist`). No se publica en npm desde esta sesión; el release queda condicionado a la revisión del diff.

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

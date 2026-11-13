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
| `init` | Detecta el repo, elige preset e imprime el plan; `--yes` lo aplica, `--preset <id>`, `--preset-only`, `--targets`, `--no-speckit`, `--dir <ruta>` (destino explícito; si `AI_HUB_DIR` también está definido, deben coincidir o sale 2). Nunca escribe en un ancestro con `manifest.yaml` por su cuenta: en interactivo pregunta, y con `--yes` sale 2 pidiendo `--dir`. El destino debe existir y admitir escritura. La ruta absoluta va a stderr (`ai-hub: destino <ruta>`) y el resumen termina con `init: instalado en <ruta>` |
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

**Integraciones opcionales y código de salida.** Con la instalación base verificada, el tracker y el plano de control
corren aislados: su fallo no cambia el código de salida de `init`, que sale con 0. Si algo queda a medias, `init`
escribe un aviso en stderr (la etapa, lo que está listo, lo que falta y cómo seguir) y termina stdout con una línea
por integración ofrecida o pedida:

```text
ai-hub-integration: name=<tracker|control> state=<no-solicitada|completada|pendiente|fallida|no-verificable> stage=<etapa|-> action=<comando|->
```

Un script la lee con `^ai-hub-integration: name=(\S+) state=(\S+) stage=(\S+) action=(.*)$`; `action` ocupa el resto
de la línea. Migración desde 0.14.0: un fallo de Hermes ya no sale con 1. Trata `fallida` y `pendiente` como «no
conectado». Los argumentos inválidos de `--connect-hermes` salen con 2 antes de escribir nada, y un fallo de la base
sigue saliendo con un código distinto de 0, sin líneas de estado.

La acción depende de lo que quedó guardado:

- **Sin guardar.** Si el token del perfil o `manifest.control` faltan, la acción es retomar la conexión con
  `ai-hub init --yes --connect-hermes --discord-channel <id> --approver <id> --discord-token-stdin` (o `ai-hub init`
  en una terminal), aportando de nuevo el token, el canal y el aprobador.
- **Guardada.** `ai-hub control enroll --yes`.

`ai-hub help` lista los 28 comandos. `verify` es alias de `gate`.

### Idea del proyecto

La idea alimenta `backlog/seed.md` y nunca entra al plan, al lock, al manifiesto ni a `.ai-hub/runs/`. Hay cuatro
fuentes, con un solo contrato:

| Fuente | Cómo | Cuándo usarla |
|---|---|---|
| Pegado en el asistente | `npx ai-hub init` (sin flags), paso de la idea | Textos cortos o pegados en Windows Terminal, iTerm, GNOME… |
| Tu editor | **Ctrl+E** dentro de la entrada, o `init --yes --idea-editor` | Textos largos; usa `$VISUAL`, luego `$EDITOR`, luego `code --wait` o Notepad/`vi` |
| Archivo | `init --yes --idea-file idea.md` | La vía canónica no interactiva |
| Entrada estándar | `cat idea.md \| npx ai-hub init --yes --idea-stdin` | Tuberías y CI |

En la entrada del asistente **Enter no envía**: termina con **Ctrl+D** o con una línea que contenga solo `.`.
Con la entrada vacía, cualquiera de los dos salta el paso; **Esc** o **Ctrl+C** cancelan el init entero sin
escribir nada. La entrada activa *bracketed paste*, consume todo el pegado antes de devolver y no reimprime el
texto: muestra un contador y las últimas tres líneas.

Si se dan varias fuentes se usa una sola, en el orden `--idea-file` > `--idea-stdin` > `--idea-editor`, y una
línea dice cuál se ignoró. `--idea-stdin` no se combina con `--discord-token-stdin` (el token es lo único que viaja
por esa entrada). Todas normalizan igual: fuera el BOM, CRLF/CR → LF, fuera los saltos finales; el byte NUL o el
UTF-8 inválido salen con 2. El límite es 4 MiB, ajustable en bytes con `AI_HUB_MAX_IDEA`; nunca se trunca.

`backlog/seed.md` guarda la idea en un fence más largo que cualquier racha de backticks que contenga, con la fecha
y la fuente. Si ya existe con otra idea, no se sobrescribe y se informa la colisión; uno de 0.13.0 (idea sin fence)
migra solo si su texto coincide. `backlog/pre-prompt.md` es plantilla del motor: se refresca si no la editaste.

> **Windows:** la consola entrega un pegado a unos 15 KB/s (medido sobre ConPTY, con el render activado o no), así
> que para textos de más de ~64 KiB usa **Ctrl+E** o `--idea-file`. El límite de 4 MiB es de memoria, no de pegado.
> En conhost (la consola clásica de Windows 10) además no hay *bracketed paste*: también ahí, Ctrl+E o `--idea-file`.
> Detalle del fallo que esto corrige en [SECURITY.md](SECURITY.md#known-vulnerabilities).

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

## Plano de control (hermes-control)

Opcional: sin `manifest.control` nada cambia. El arnés **verifica y redacta** cada decisión; una persona
**aprueba por Discord**; Hermes solo transporta el mensaje y la respuesta. El tablero es GitLab: las
7 etiquetas `ai::*`.

```yaml
# manifest.yaml
tracker: { kind: gitlab, urlEnv: GITLAB_URL, tokenEnv: GITLAB_TOKEN }
control:
  approvers: ["<id de usuario de Discord>"]   # sin aprobadores no se aplica nada
  ttlHours: 24                               # caducidad de cada decisión
  expire: block                              # block -> ai::blocked (approval_expired) | notify
```

`.ai-hub/.env` (nunca versionado) lleva `GITLAB_URL`, `GITLAB_TOKEN` y `GITLAB_PROJECT_PATH`. Cada issue
de feature lleva en su descripción `ai-hub:feature=<NNN-slug>`.

- `ai-hub control tick --dry-run --online` lista el tablero (solo GET), liga issues y features por el
  marcador e informa las issues sin él.
- `ai-hub control decide --online [--format discord|json]` publica las decisiones nuevas en
  `.ai-hub/runs/control/decisions.jsonl` (ignorado) e imprime **una por ejecución** en formato Discord:
  transición, resumen, impacto, evidencia con su fuente, `aprobar <iid> <hash>` / `rechazar <iid> <motivo>` /
  `detalle <iid>` y caducidad. Repetir sin cambios no imprime nada. Una spec completa se publica para
  aprobación con su sello como hash (§5).
- Sondeo sin agente: `engine/templates/hermes/control-poll.sh`, que `ai-hub control enroll` instala en el
  perfil de Hermes y programa con `hermes -p hermes-control cron create "every 15m" --no-agent --script
  control-poll.sh --deliver discord`. Su salida es un mensaje de Discord o nada.

### Webhook de GitLab → Discord

`ai-hub control ingest` recibe el payload por stdin desde la ruta de Hermes (sin agente: un script), acepta
solo eventos de issues y merge requests del proyecto de `GITLAB_PROJECT_PATH`, descarta duplicados por
contenido y, si una persona movió la etiqueta a mano, anula lo pendiente de esa issue: manda GitLab.

- Habilitación: el bloque `platforms.webhook` (`enabled: true`, `extra.port`) del `config.yaml` del perfil dueño
  del listener. Es el único archivo que leen a la vez el CLI de rutas y el gateway: `WEBHOOK_ENABLED` en el `.env`
  arranca el listener pero deja `webhook list`/`subscribe` fuera de servicio, así que `enroll` no lo escribe.
- Dueño del listener: con gateway propio, el perfil `hermes-control`. Bajo el multiplexor (`gateway status` dice
  `via the default-profile multiplexer`) es el perfil `default`: el bloque va en su `config.yaml`, la ruta se crea
  en su store con `--route-profile hermes-control` y la URL es `/p/hermes-control/webhooks/ai-hub-gitlab`.
- Ruta en Hermes: `webhook subscribe ai-hub-gitlab --events "Issue Hook,Merge Request Hook" --script
  gitlab-route.sh --prompt "{script_output}" --deliver discord --deliver-only` (plantilla
  `engine/templates/hermes/gitlab-route.sh`), contra el dueño del listener. Un stdout vacío descarta el evento.
- En GitLab (Settings > Webhooks del proyecto): la URL que imprime `enroll`
  (`https://<host-de-hermes>:8644/webhooks/ai-hub-gitlab` o, bajo el multiplexor,
  `https://<host-de-hermes>:8644/p/hermes-control/webhooks/ai-hub-gitlab`), eventos **Issues events** (work
  items) y **Merge request events**, y el secreto en **Secret token**: GitLab lo envía en `X-Gitlab-Token` y
  Hermes lo compara.
- El secreto lo genera Hermes al suscribir la ruta y lo guarda en `webhook_subscriptions.json` (permisos
  0600) del dueño del listener; `ai-hub` nunca lo imprime ni lo guarda. Cópialo de ahí a GitLab. `ai-hub` no
  genera ni escribe ningún secreto global; si el `.env` del dueño tiene `WEBHOOK_SECRET`, el gateway lo usa como
  secreto global y pisa `platforms.webhook.extra.secret` al arrancar (`gateway/config_env.py:141`): `enroll` lo
  avisa por presencia y no lo toca. Rotación sin `--secret` en `core/SECURITY.md`.
- «Escuchando» se comprueba con `GET http://127.0.0.1:<puerto>/health`, que debe responder
  `{"status":"ok","platform":"webhook"}`; la salida de `webhook list` solo prueba que la clave existe. El sondeo
  local demuestra que el listener está levantado, no que GitLab llegue al host: eso se prueba con una entrega
  de prueba desde GitLab.
- Sin webhook alcanzable (sin VPS ni túnel), el cron de sondeo hace el mismo trabajo cada `pollMinutes`.

### Aprobaciones por Discord

Gramática estricta (cualquier otro texto se ignora):

| Respuesta | Efecto |
|---|---|
| `aprobar <iid> <hash>` | ≥ 8 hex del hash de la decisión (en una spec, su sello); aplica la transición |
| `rechazar <iid> <motivo>` | cierra la decisión; la etiqueta no cambia |
| `detalle <iid>` | devuelve la evidencia completa |

- Solo cuentan los ids de `manifest.control.approvers`; con la lista vacía, `apply` sale 2.
- `ai-hub control apply --approver <id> -- aprobar 42 3f9c2a71` (la skill de Hermes pasa las palabras tras
  `--`, sin comillas) o `--reply "<texto>"` a mano. Antes de escribir relee la etiqueta (si cambió, la
  decisión se anula), revalida el sello y el WIP, y hace **un** `PUT` que añade el destino y retira las demás
  `ai::` (correcto con o sin etiquetas con alcance de GitLab Premium). Un 429 (con `Retry-After`) o una caída
  dejan la decisión pendiente, sin escritura parcial.
- Aprobar una spec deja la nota `ai-hub:approved-hash=<sello>`; el paso a `ai::in-dev` queda **preaprobado**
  por ese hash y lo ejecuta `apply --preapproved` (desde el cron) tras revalidar sello y WIP.
- Caducidad: `ttlHours` (24). `ai-hub control expire` (desde el cron): con `expire: block`, la issue pasa a
  `ai::blocked` con `approval_expired` y una nota; con `notify`, solo un aviso.
- Plantilla de la skill de respuestas: `engine/templates/hermes/SKILL.md` (solo ejecuta `apply` y devuelve su
  salida sin parafrasear).

### Evidencia, sello y endurecimiento

- **Rango de la evidencia.** Un run local (`.ai-hub/runs`) manda. Si no hay, el tick lee la última línea
  `AI-HUB-STATUS` válida de las notas de la issue o de sus MR (motor en otro host) y la marca `remote`:
  el mensaje dice "declarado por el motor, no verificado por el arnés". Un `VERIFIED` remoto no propone
  `ai::done` hasta que el pipeline del MR está en `success` (rango `pipeline`). Una línea mal formada se ignora.
- **`--ref <rama>`** (`tick`, `decide`, `apply`): el sello se calcula con `git show <rama>:specs/<feature>/…` en el
  espejo, sin checkout; mismo algoritmo y mismo vector de §5.
- **`doctor --online`** añade `tracker:scope`: avisa si el token tiene `write_repository`, un rol Developer o
  superior (puede hacer push) o caduca en menos de 14 días; sin endpoint de introspección lo dice y no supone.
- **`apply --verify-message`** no está disponible: releer el mensaje en Discord exige un endpoint que no se ha
  verificado (PENDIENTE). La aprobación se valida con la gramática, el hash y `manifest.control.approvers`.
- Rotación de las tres credenciales del plano de control: `SECURITY.md`.

### Enrolar Hermes

`ai-hub control enroll` instala el lado operativo en Hermes (≥ 0.23.0). Sin `--yes` ni `--check` solo imprime
el plan. Busca el CLI en este orden: `--hermes <ruta>` (exclusivo), `HERMES_BIN`, el `PATH` (en Windows también
`.exe`, `.cmd`, `.bat`) y las ubicaciones de instalación (instalador nativo `%LOCALAPPDATA%\hermes\bin\hermes.exe`
o `~/.hermes/bin/hermes`, pipx, pip `--user`, npm). Si no lo encuentra, sale 2 listando todas las rutas
probadas; con una versión más antigua, sale 1 nombrando la encontrada y la mínima.

```bash
npx ai-hub control enroll              # plan, sin cambios
npx ai-hub control enroll --yes        # crea solo lo que falta: perfil, skill, scripts, cron, webhook
npx ai-hub control enroll --yes --webhook-owner default   # consiente escribir el config.yaml del perfil default
npx ai-hub control enroll --check      # solo lectura: perfil, credenciales por presencia, webhook escuchando
```

- Perfil propio: `hermes profile create hermes-control --no-skills`, con su propio bot de Discord. `enroll`
  se niega si el perfil comparte `DISCORD_BOT_TOKEN` con otro perfil (dos perfiles con un mismo bot colisionan).
- Imprime la ruta del `.env` del perfil (`<hogar de Hermes>/profiles/hermes-control/.env`), nunca su contenido.
- Nunca pasa `--secret` ni imprime la salida de `webhook subscribe`: el secreto lo genera Hermes.
- **Orden:** perfil, identidad, skill, scripts y cron primero; después el webhook. Si el webhook falla, el plano
  de control ya funciona por el tick.
- **Webhook:** escribe `platforms.webhook` (`enabled: true`, `extra.port`, 8644 por defecto) en el `config.yaml`
  del dueño del listener, conservando claves y comentarios; nunca escribe un secreto, `INSECURE_NO_AUTH` ni
  `extra.host`. Un perfil con `WEBHOOK_ENABLED`/`WEBHOOK_PORT` en el `.env` (versiones anteriores) los migra al
  bloque tras copiar el `.env` a `.env.pre-ai-hub[.n]` y retira solo esas dos líneas; un `WEBHOOK_SECRET` queda
  intacto. `platforms.webhook.enabled: false` se respeta como exclusión. Después suscribe la ruta, reinicia el
  gateway si hace falta y espera a que `GET /health` responda. Re-ejecutarlo deja el archivo byte a byte igual.
- **Dueño compartido:** si el listener es del perfil `default`, escribir su `config.yaml` activa la plataforma
  para todos los perfiles que sirve su gateway. `--yes` solo no lo hace: el webhook queda `pendiente` con la
  acción `ai-hub control enroll --yes --webhook-owner default`. Con `--webhook-owner default` (o aceptando la
  pregunta interactiva que lo nombra) se copia su `config.yaml` a `config.yaml.pre-ai-hub[.n]` antes de escribir.
  Un `--webhook-owner` que no coincide con el dueño detectado no escribe nada.
- **Reinicio compartido:** reiniciar el gateway del perfil `default` corta las sesiones activas de todos los
  perfiles que sirve. `enroll` lo avisa antes del único reinicio; `--dry-run` y `--check` muestran el aviso y el
  comando sin reiniciar. Sin nada que recargar, no reinicia ni avisa.
- **Sin gateway instalado:** el webhook es «no verificable»: sale 0, instala el cron, no escribe el bloque ni la
  ruta y propone `hermes gateway install`. Un gateway instalado y parado se reinicia una vez, avisando; si no
  levanta, sale 1 con `hermes gateway restart`.
- **Identidad:** el perfil recibe un bloque gestionado en `SOUL.md` entre
  `<!-- ai-hub:soul:begin v=1 sha256=… -->` y `<!-- ai-hub:soul:end -->`. El perfil que crea esta misma
  ejecución se adopta sin preguntar, también sin terminal; un perfil existente sin marcas solo se adopta en el
  paso interactivo. La primera adopción guarda el original en `SOUL.md.pre-ai-hub`; si ese nombre ya tiene otro
  contenido, usa `SOUL.md.pre-ai-hub.<n>`. Las copias nunca se sobrescriben. Un bloque editado no se toca: queda
  `pendiente` y la acción empieza por apartar el archivo.
- **Comprobación:** `enroll --check` verifica perfil, `.env`, claves de Discord, canal y aprobadores frente a
  `manifest.control`, skill, scripts, identidad, plataforma webhook, ruta, cron, modelo y gateway. El webhook
  cuenta como presente solo si el `config.yaml` del dueño lo habilita y el puerto responde a `GET /health`;
  «declarado pero no escucha» falla con la acción de reinicio. Es de solo lectura: únicamente ejecuta
  `--version`, `webhook list`, `cron list` y `gateway status`, y sondea el puerto local. Sale 0 si el perfil
  está completo, 1 si falta algo y 2 sin Hermes. El modelo y un gateway no instalado se muestran como
  «no verificable» y no fallan; un gateway instalado y parado sí, con `hermes gateway restart` como acción.
- **`manifest.control.channelId`** guarda el canal de control y debe coincidir con `DISCORD_HOME_CHANNEL`; el
  canal también debe estar en `DISCORD_ALLOWED_CHANNELS`. Los aprobadores de `manifest.control` se comparan con
  `DISCORD_ALLOWED_USERS`.

**Recuperación.** La conexión queda guardada cuando el `.env` del perfil tiene `DISCORD_BOT_TOKEN` y existe
`manifest.control`. Antes de ese punto se retoma con `init`; después, con `control enroll --yes`.

| Punto de interrupción | Acción |
|---|---|
| Perfil creado, sin copia de identidad | Aparta `SOUL.md` y retoma la conexión con `init`. |
| Copia escrita, sin bloque | Retoma la conexión: la copia idéntica completa la adopción sin preguntar. |
| Bloque escrito, Discord sin guardar | Retoma la conexión. |
| Discord guardado, `manifest.control` ausente | Retoma con el mismo token; la línea del token no cambia. |
| Ruta o cron fallaron | `ai-hub control enroll --yes`; solo crea lo que falte. |
| `profile create` falló | Retoma la conexión: no hay nada persistido. |
| Identidad editada o sin adoptar | Aparta `SOUL.md` y ejecuta la acción del punto de guardado. |
| Gateway instalado y parado | `hermes gateway restart`. |

**Recuperación del webhook.** El tick sigue ingiriendo mientras el webhook está caído.

| Síntoma | Acción |
|---|---|
| Puerto ocupado por otro proceso (`/health` responde con otro documento) | Libera el puerto o cambia `platforms.webhook.extra.port` en el `config.yaml` del dueño y repite `enroll --yes`. |
| Declarado pero no escucha | `hermes gateway restart` (o `hermes -p hermes-control gateway restart` con gateway propio) y revisa el log del gateway. |
| Gateway parado | `hermes gateway restart`; `enroll --yes` lo intenta una vez avisando antes. |
| Sin gateway instalado | `hermes gateway install`; el webhook queda «no verificable» hasta entonces. |
| Webhook `pendiente` por el dueño compartido | `ai-hub control enroll --yes --webhook-owner default`, sabiendo que activa la plataforma y reinicia el gateway de todos los perfiles. |
| GitLab no llega (firewall, NAT o sin túnel) | El sondeo local no lo detecta: abre el puerto o usa un túnel y envía una entrega de prueba desde GitLab. |

Cada acción termina en `ai-hub control enroll --check` = 0.

### Provisión de Discord

El paquete **no** crea aplicaciones, bots ni canales: los provisiona la persona. El único token que escribe es el
que la persona teclea en el paso de conexión de `init` (abajo), y solo en el `.env` del perfil `hermes-control`.

1. **Aplicación:** en el portal de desarrolladores de Discord (`discord.com/developers/applications`), *New
   Application* (por ejemplo, "ai-hub control").
2. **Bot:** pestaña *Bot*; activa *Message Content Intent* (Hermes lee el texto de las respuestas).
3. **Token:** *Reset Token* y cópialo una sola vez a `DISCORD_BOT_TOKEN` en el `.env` del perfil. No lo pegues
   en el chat, en issues ni en `.ai-hub/.env`.
4. **Invitar el bot:** *OAuth2 → URL Generator* con el scope `bot` y los permisos *View Channels*, *Send
   Messages* y *Read Message History*; abre la URL e invítalo al servidor. Crea un canal solo para el control.
5. **Ids:** activa el *Modo desarrollador* de Discord (Ajustes → Avanzado). Clic derecho en el canal → *Copiar
   ID* → `DISCORD_ALLOWED_CHANNELS`. Clic derecho en cada aprobador → *Copiar ID de usuario* →
   `DISCORD_ALLOWED_USERS` y, con los mismos ids, `manifest.control.approvers`.

| Variable | Dónde va | Quién la escribe |
|---|---|---|
| `DISCORD_BOT_TOKEN` | `.env` del perfil `hermes-control` | la persona (paso 3) |
| `DISCORD_ALLOWED_USERS` | `.env` del perfil `hermes-control` | la persona (paso 5) |
| `DISCORD_ALLOWED_CHANNELS` | `.env` del perfil `hermes-control` | la persona (pasos 4 y 5) |
| `manifest.control.approvers` | `manifest.yaml` del proyecto (versionado; no es secreto) | la persona |
| `GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_PROJECT_PATH` | `.ai-hub/.env` (ignorado) | la persona |

Las variables de Discord **nunca** van en `.ai-hub/.env`, y las de GitLab nunca en el `.env` del perfil.
Después: `npx ai-hub control enroll --check`.

**Canal de control.** Crea un canal de texto para el control o usa `#general`, que existe en todo servidor
nuevo. Copia el id del **canal**, no el del servidor ni el de tu usuario: *Modo desarrollador* → clic derecho
en el canal → *Copiar ID*. El paso acepta también el nombre con o sin `#`, sin distinguir mayúsculas. Si el
mismo nombre existe en varios servidores, muestra servidor, canal e id y pide el id; si solo hay un canal de
voz con ese nombre, lo declara incompatible.

**Si Discord rechaza una comprobación**, el paso muestra un diagnóstico por campos
(`operation`, `status`, `class`, `code`) y nunca el cuerpo, las cabeceras ni el token. Qué hacer según la clase:

| Respuesta | Qué se sabe | Acción |
|---|---|---|
| 401 | El token no autentica | Copia uno nuevo con *Reset Token*. |
| 403 | Discord niega al bot el acceso a ese id; la causa exacta no se determina con esta respuesta | Revisa la invitación y los permisos; corrige el id si procede. |
| 404 | Ningún canal con ese id es visible para el bot | Comprueba que copiaste el id del canal; si el diagnóstico identifica un servidor o el propio bot, usa el id del canal. |
| 429 | La consulta está limitada; el dato puede ser correcto | Reintenta más tarde; no cambies una respuesta correcta. |
| 5xx | Discord falla temporalmente | Reintenta; no cambies una respuesta correcta. |
| timeout o red | No se pudo comprobar | Reintenta; con un id numérico el paso ofrece guardarlo sin validar. |

La lista de servidores vacía prueba que el bot no está en ningún servidor; el paso lo dice y enlaza la
invitación. Los mensajes basados en el `code` concreto de Discord no se implementaron: no había una sonda
autorizada que registrara esa combinación de operación, estado y código.

### Conectar desde `init`

Si `init` (asistente interactivo) detecta Hermes ≥ 0.23, su última pregunta ofrece conectar el plano de control.
Vacío = saltar, sin escribir nada. Si aceptas, todo es obligatorio y en este orden: el **token de TU bot** (entrada
enmascarada; Discord lo valida antes de guardarlo y un token rechazado nunca se guarda), el **canal** de control
(id o nombre; el bot tiene que verlo), **tu id de usuario** como aprobador y el TTL y la expiración (24 h y
`block` por defecto). Cancelar en cualquier momento no deja nada escrito.

Después, sin pasos manuales: crea el perfil `hermes-control` (`hermes profile create … --no-skills`, nunca un
clon), escribe el token y las listas de canal y aprobador en el `.env` del perfil, escribe `manifest.control`,
ejecuta `control enroll --yes`, reinicia el gateway de Hermes si está instalado y termina con un resumen de 5
líneas. Un token que ya usa otro perfil se rechaza (el gateway no puede servir dos perfiles con el mismo bot); un
perfil con otro bot no se sobrescribe sin tu confirmación. Si diste una idea en el asistente y no existe
`IDEA.md`, la deja en la raíz enlazada a `backlog/seed.md`.

Sin terminal, `--yes` no pregunta. Para conectar sin preguntas, el token entra **solo por stdin**:

```bash
npx ai-hub init --yes --connect-hermes --discord-channel <id> --approver <id-de-usuario> --discord-token-stdin < token.txt
```

`--discord-token <valor>` se rechaza (exit 2). Sin red para validar el token hace falta `--allow-unvalidated`;
para sustituir otro bot del perfil, `--reconfigure-hermes`.

## Codex

Cobertura parcial: con `agentsMd: true`, `sync` mantiene la región gestionada del `AGENTS.md`
raíz, que Codex lee. Skills, agentes, hooks y comandos de Spec Kit no llegan a Codex; el destino
completo está en el roadmap (P4).

## Verificación (taller)

- `npm test` es el gate: `vitest run --maxWorkers=1`, el mismo comando que corre `prepublishOnly`
  (`build` + `manifest:build` + `npm test`). Serial a propósito: la verificación no depende de la carga de la
  máquina.
- En un checkout dentro de OneDrive el gate completo tarda **~20 min**. No lo lances en paralelo con otra suite
  (ni con otra copia del gate): los tests que hacen `init` de un consumidor y un `doctor` completo compiten por
  disco y memoria y expiran.
- `npm run test:fast` (`vitest run`, en paralelo) es solo para iterar en local; no sustituye al gate.
- **Sondas de terminal real (Windows).** `tests/idea-input-pty.test.ts` (proyecto `integration`) usa `node-pty`,
  que **no se declara en `package.json`**: en `devDependencies` un fallo de node-gyp abortaría `npm install`, y
  en `optionalDependencies` viajaría al consumidor. Para habilitar la cobertura de ConPTY:
  `npm install --no-save node-pty` (no toca `package.json` ni `package-lock.json`). Sin el módulo, esas sondas se
  saltan con el motivo exacto. Toda sonda PTY pasa por `withPty` (`tests/pty-harness.ts`): timeout de 45 s, kill
  del hijo y comprobación de que no queda proceso vivo (`taskkill /F /T` en Windows).

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

# Changelog

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

# Archivo upstream — ai-hub

Material histórico incorporado desde `ai-hub`. No es documentación vigente de ai-hub.

## Origen

- Repositorio de origen: https://github.com/dsalazardev/ai-hub
- Licencia: MIT, Copyright (c) 2026 Daner Alejandro Salazar Colorado (ver `NOTICE.md` en la raíz)
- Fecha de importación: 2026-10-25
- Commit de referencia en ai-hub: el que acompaña a este archivo en el historial del repositorio

## Contenido

| Ruta | Archivos | Origen |
|---|---|---|
| `agents/` | 4 | `archive/upstream/ai-hub/agents/` de ai-hub, heredado de `ai-hub` |
| `prompts/` | 10 | `archive/upstream/ai-hub/prompts/` de ai-hub, heredado de `ai-hub` |
| `rules/frontmatter.schema.json` | 1 | `rules/skill-quality/frontmatter.schema.json` de ai-hub |

Los archivos se movieron sin reescribir su contenido. Cualquier referencia a comandos, rutas o
estado de `ai-hub` que aparezca dentro de ellos describe el producto de origen, no ai-hub.

## Motivo de conservación

Se conservan como evidencia de procedencia, para que `NOTICE.md` pueda apuntar al material
original, y para que la retirada de estas piezas del runtime sea auditable y reversible. No se
borraron porque la trazabilidad de la licencia y de las decisiones de adaptación sigue siendo
necesaria.

## No proyección

`ai-hub sync` no lee ni proyecta este directorio. Tampoco está incluido en `manifest.yaml`
(`agents.source`, `skills.source`, `rules.source`) ni en `core/package.json` (`files`). Este
material no llega a los proyectos gestionados por ai-hub.

## Sin mantenimiento

Este archivo es histórico y no recibe mantenimiento. No debe citarse como contrato vigente ni
usarse para autorizar comandos. La fuente de verdad operativa es `AGENTS.md`, `manifest.yaml` y
`core/engine/engine.yaml`.

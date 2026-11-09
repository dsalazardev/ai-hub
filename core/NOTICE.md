# NOTICE

Este paquete incluye activos de procedencia mixta. Se conserva su origen para que
la atribución y la trazabilidad no se pierdan al distribuir.

## Originales de AI Hub

- `core/src/`, `core/engine/`, `core/schema/`: motor, invariantes y validación.
- `core/agents/`: agentes del catálogo publicados con la plataforma.
- `core/skills/shared/`: skills Spec Kit y de dominio del motor.
- `core/presets/`: presets de detección y stack.

Autor de la plataforma: Daner Alejandro Salazar Colorado.

## Heredados o adaptados

Parte del catálogo de skills proviene de arneses previos del mismo autor
(incluido `rsc-harness`) y fue adaptada para el contrato de este motor. Los
archivos conservan su contenido y su intención original; las adaptaciones se
limitan a frontmatter, rutas y referencias internas.

### Procedencia fijada

- Catálogo compartido: `rsc-harness` **3.3.0 @886ef8c** (2026-10-23), licencia MIT.
- `design`: motor de taste-skill (MIT) y textos de impeccable (Apache-2.0); sus avisos viajan en
  `core/skills/shared/design/` (`engine/LICENSE`, `IMPECCABLE-LICENSE.txt`, `THIRD_PARTY.md`).

### Adaptaciones de rsc-harness (MIT) en el motor

Copyright de rsc-harness: sus autores, bajo licencia MIT. Ideas y criterios adaptados (código
reescrito para este motor):

- `scripts/eval-lint.sh` → mínimos de evals y `route_to` válido (test del taller del catálogo).
- `scripts/drift-check.js` → enlaces relativos que resuelven (`core/src/engine/references.ts`).
- `scripts/reviewer-guard.sh` → doctrina mínima de revisores y refuters (test del taller).
- `targets/opencode-memory-plugin.js` → patrón de plugin con las dos APIs de OpenCode
  (`core/engine/templates/opencode-plugin.js`).
- `lib/review-findings.js` → consolidación del panel: unir hallazgos a ±3 líneas o con la misma
  evidencia y degradar a pregunta lo que no trae archivo, línea o escenario
  (`core/src/review/consolidate.ts`, `ai-hub review consolidate`).
- `targets/agents.js` → idea de capacidades abstractas por agente proyectadas por destino
  (`core/src/agents/header.ts`), corrigiendo que allí los alias se escribían como nombres de
  herramienta de Claude.

## Dependencias de terceros

- `ajv` — MIT
- `yaml` — ISC

Las licencias de las dependencias se resuelven en la instalación y no se
reempaquetan aquí.

## Marcas

Los nombres de productos, frameworks y empresas mencionados en presets o
referencias pertenecen a sus respectivos titulares y se usan solo de forma
descriptiva.

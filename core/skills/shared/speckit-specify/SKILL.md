---
name: speckit-specify
description: Write the behavioral specification of a feature with EARS requirements and testable scenarios. Use after the constitution and before planning.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/ and specs/.
metadata:
  author: onna
  version: "1.0"
---

Describe what the system must do, not how it will do it.

**Input**: the approved assessment or feature request and the project constitution.

**Steps**

1. Choose a kebab-case feature id and create `specs/<feature>/`.
2. Write `spec.md`:
   - `## Purpose` — one paragraph, user-visible outcome.
   - `## Requisitos` — EARS statements using `MUST`, `MUST NOT`, `WHEN`, `IF`.
   - `## Escenarios` — one block per requirement with exactly `#### Scenario:` and WHEN/THEN.
   - `## Fuera de alcance` — what this feature deliberately excludes.
   - `## Preguntas abiertas` — numbered; none may remain before approval.
3. Give every requirement at least one scenario and a stable identifier (`R1`, `R2`, ...).
4. Keep each requirement to one behavior; split compound requirements.

**Artifacts**: `specs/<feature>/spec.md`

**Exit states**
- `DRAFT` — requirements exist but open questions remain.
- `READY` — no open questions and every requirement has a scenario.

**Guardrails**
- No architecture, library choices or file paths in `spec.md`.
- Never mark `READY` with an untestable requirement.
- Do not modify the constitution from this skill.

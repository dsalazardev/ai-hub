---
name: speckit-assess-shape
description: Compare solution shapes and choose an appetite before committing to a feature specification. Use after assess-define fixed the problem and metrics.
license: MIT
compatibility: Requires the Spec Kit layout under `.specify/assessments/`.
metadata:
  author: onna
  version: "1.0"
---

Explore two or three viable shapes, then choose one to carry into the feature lane.

**Input**: `problem.md` and `research.md` for the same slug.

**Steps**

1. Describe at least two options in `concept.md`:
   - `## Opción A/B/C` — approach, affected modules, data changes, risks.
   - `## Esfuerzo` — appetite in days, not a detailed estimate.
   - `## Coste de mantenimiento` — what the team must keep working.
   - `## Reversibilidad` — how to undo it if the metrics do not move.
2. Recommend one option and state the trade-off accepted.
3. Define the smallest version that can validate the main metric.
4. Record explicitly what is deferred to a later change.

**Artifacts**: `.specify/assessments/<slug>/concept.md`

**Exit states**
- `GO` — one option fits the appetite and validates the metric.
- `NEEDS_CLARIFICATION` — the options differ only in cost and a human must choose.
- `KILL` — no option fits the appetite or every option is irreversible.

**Guardrails**
- Do not write file-level plans, schemas or code; `design.md` owns that.
- Never present one option as the only possibility without comparing it.
- The appetite is a constraint, not a promise: do not expand it silently.

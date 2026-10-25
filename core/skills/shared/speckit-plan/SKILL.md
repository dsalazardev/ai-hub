---
name: speckit-plan
description: Produce the technical plan that implements an approved specification. Use after the spec is READY and before writing tasks.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/ and specs/.
metadata:
  author: onna
  version: "1.0"
---

Translate requirements into a design without changing them.

**Input**: `specs/<feature>/spec.md` in state `READY` and the project constitution.

**Steps**

1. Read every requirement and scenario. Map each to a design element.
2. Write `plan.md`:
   - `## Contexto` — current behavior and constraints.
   - `## Decisiones` — numbered, each with rationale and rejected alternatives.
   - `## Componentes` — modules, responsibilities and data flow.
   - `## Contratos` — APIs, schemas, events and error cases.
   - `## Trazabilidad` — requirement id → component → test.
   - `## Riesgos` — mitigation per risk.
   - `## Migración` — rollout, rollback and compatibility.
3. Verify every requirement has at least one component and one test.
4. Keep the plan implementable in one change; split otherwise.

**Artifacts**: `specs/<feature>/plan.md`

**Exit states**
- `READY` — every requirement is covered and no design decision is open.

**Guardrails**
- Never add a requirement that the spec does not contain.
- Do not write task lists here; `tasks.md` owns sequencing.
- Name the trade-off of every significant decision.

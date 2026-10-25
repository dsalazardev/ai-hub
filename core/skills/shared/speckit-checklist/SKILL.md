---
name: speckit-checklist
description: Build and run the quality gate for a feature plan before implementation. Use after speckit-plan and before speckit-tasks.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/ and specs/.
metadata:
  author: onna
  version: "1.0"
---

Decide whether the plan is safe to implement.

**Input**: `spec.md`, `plan.md` and the project constitution.

**Steps**

1. Create `checklist.md` with one section per gate:
   - `## Constitución` — every principle checked.
   - `## Cobertura` — every requirement mapped to a component and test.
   - `## Seguridad` — secrets, permissions, input validation, destructive operations.
   - `## Compatibilidad` — platforms, data migration, rollback.
   - `## Observabilidad` — logs, metrics and failure signals.
2. Mark each item `PASS`, `FAIL` or `N/A` with one line of evidence.
3. A single `FAIL` blocks implementation; return to `plan` or `specify`.

**Artifacts**: `specs/<feature>/checklist.md`

**Exit states**
- `PASS` — no blocking findings.
- `NEEDS_FIX` — at least one `FAIL`; name the artifact to revise.

**Guardrails**
- Do not mark `PASS` from intention; cite the plan or test that proves it.
- Do not add new requirements in the checklist.
- Never waive a security or data-loss finding without a human decision.

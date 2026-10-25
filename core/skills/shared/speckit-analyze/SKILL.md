---
name: speckit-analyze
description: Check consistency, coverage and traceability across spec, plan, checklist and tasks before implementation. Use after speckit-tasks.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/ and specs/.
metadata:
  author: onna
  version: "1.0"
---

Find contradictions before code makes them expensive.

**Input**: `spec.md`, `plan.md`, `checklist.md` and `tasks.md` for the same feature.

**Steps**

1. Build a matrix: requirement → plan component → checklist gate → task.
2. Report every gap, orphan and contradiction in `analysis.md`:
   - `## Cobertura` — requirements without a task or test.
   - `## Contradicciones` — spec vs plan vs checklist.
   - `## Duplicados` — tasks or components that solve the same thing.
   - `## Ambigüedades` — language that still admits two implementations.
   - `## Veredicto` — `PASS` or `NEEDS_FIX` with the exact artifact to edit.
3. Fix nothing in this phase; return findings to the owning artifact.

**Artifacts**: `specs/<feature>/analysis.md`

**Exit states**
- `PASS` — full coverage and no contradiction.
- `NEEDS_FIX` — at least one gap or contradiction; name the artifact.

**Guardrails**
- Never edit the spec or plan from this skill.
- A requirement covered only by a "misc" task is not covered.
- Do not silence a finding because implementation is already underway.

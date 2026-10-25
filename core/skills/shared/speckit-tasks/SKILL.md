---
name: speckit-tasks
description: Break an approved plan into atomic, ordered, verifiable implementation tasks. Use after the checklist passes.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/ and specs/.
metadata:
  author: onna
  version: "1.0"
---

Produce the executable sequence the implementers will follow.

**Input**: `spec.md`, `plan.md` and `checklist.md` in state `PASS`.

**Steps**

1. Create `tasks.md` grouped by phase (foundation, core, integration, release).
2. Each task MUST be one checkbox with:
   - a concrete action,
   - the files or modules it touches,
   - an explicit verification criterion.
3. Order tasks by dependency; a task may only depend on earlier tasks.
4. Map every requirement to at least one task; add a traceability table.
5. Estimate nothing; split any task that cannot be verified in one run.

**Artifacts**: `specs/<feature>/tasks.md`

**Exit states**
- `READY` — every task has a verification criterion and every requirement is covered.

**Guardrails**
- No `TODO`, "investigar" or unverifiable tasks.
- Do not include implementation code in the task list.
- Do not mark a task complete from this skill.

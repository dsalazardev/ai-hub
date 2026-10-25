---
name: speckit-converge
description: Verify that the implemented codebase satisfies every requirement before archiving the change. Use after speckit-implement reports DONE.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/, specs/ and the project test commands.
metadata:
  author: onna
  version: "1.0"
---

Close the loop between what was specified and what exists.

**Input**: `spec.md`, `plan.md`, `tasks.md`, `analysis.md` and the implemented code.

**Steps**

1. Read every requirement and locate its implementation and test.
2. Run the full verification commands from the plan and record the result.
3. Write `convergence.md`:
   - `## Requisito → evidencia` — table with requirement, code path, test.
   - `## Tareas` — every task checked; list any unchecked.
   - `## Deriva` — behavior implemented but not specified.
   - `## Veredicto` — `CONVERGED` or `NEEDS_WORK` with the exact gap.
4. If `NEEDS_WORK`, return to `implement` or `specify`; do not patch here.
5. On `CONVERGED`, hand off to the human approval gate and then archive.

**Artifacts**: `specs/<feature>/convergence.md`

**Exit states**
- `CONVERGED` — every requirement proven and every task complete.
- `NEEDS_WORK` — a requirement lacks evidence or unspecced behavior exists.

**Guardrails**
- Never mark `CONVERGED` from a summary; cite code and test output.
- Never delete or archive the feature while a task is open.
- Do not rewrite the spec to match the implementation.

---
name: speckit-implement
description: Execute the approved task list in an isolated worktree and produce verified code. Use only after analysis passes and a human approved the spec hash.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/, specs/ and a Git repository.
metadata:
  author: onna
  version: "1.0"
---

Implement the tasks exactly as approved, with evidence.

**Input**: `specs/<feature>/tasks.md`, `plan.md` and the approved SHA-256 of `spec.md + plan.md + tasks.md`.

**Steps**

1. Verify the approval hash still matches the three artifacts. If not, stop: the approval is invalid.
2. Work in the assigned worktree or feature branch. Never implement on the trunk.
3. For each task in order: make the smallest change, run its verification, and only then mark it `[x]`.
4. Keep a trace in `.planning/impl_<feature>.md`: task, files, command, result.
5. If a task needs scope beyond the spec, stop and return to `specify` or `plan`.

**Artifacts**: source code, tests, `.planning/impl_<feature>.md` and updated `tasks.md`.

**Exit states**
- `DONE` — every task verified and the full suite is green.
- `BLOCKED` — a task needs a design or scope decision; record why and stop.

**Guardrails**
- Never weaken a test to pass.
- Never edit `spec.md`, `plan.md` or `tasks.md` to match what was built.
- No `TODO`, placeholder or commented-out code.

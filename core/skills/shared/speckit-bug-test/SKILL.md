---
name: speckit-bug-test
description: Verify a bug fix against reproduction, regression and adjacent behavior, then issue a verdict. Use after speckit-bug-fix produced FIXED.
license: MIT
compatibility: Requires the project test commands.
metadata:
  author: onna
  version: "1.0"
---

Independently verify the repair; do not trust the implementer's summary.

**Input**: `assessment.md`, `fix.md` and the changed files.

**Steps**

1. Reproduce the original defect with the pre-fix revision or a fixture that simulates it.
2. Run the regression test and confirm it fails without the patch and passes with it.
3. Run the package suite and record the command, duration and result.
4. Write `test.md`:
   - `## Reproducción original` — pass/fail with evidence.
   - `## Regresión` — test name and result.
   - `## Suite` — command and totals.
   - `## Riesgo residual` — areas not covered.
   - `## Veredicto` — `VERIFIED`, `PARTIAL` or `FAILED`.
5. If `FAILED`, return to `bug-assess` with the new evidence; do not patch the code here.

**Artifacts**: `.specify/bugs/<slug>/test.md`

**Exit states**
- `VERIFIED` — original defect gone, regression test proven, suite green.
- `PARTIAL` — fix works but evidence or environment is incomplete; list the gap.
- `FAILED` — the defect persists or a new regression appears; reopen the diagnosis.

**Guardrails**
- Never edit the fix or the tests in this phase.
- Never issue `VERIFIED` from a skipped or flaky test without saying so.

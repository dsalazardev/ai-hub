---
name: speckit-bug-fix
description: Apply a scoped repair for a diagnosed bug and document the change. Use after speckit-bug-assess produced ROOT_CAUSE.
license: MIT
compatibility: Requires a workspace with tests.
metadata:
  author: onna
  version: "1.0"
---

Fix only what the diagnosis proved, and leave the evidence behind.

**Input**: `.specify/bugs/<slug>/assessment.md` with exit state `ROOT_CAUSE`.

**Steps**

1. Re-read the root cause and the declared scope. If the scope must grow, stop and return to `bug-assess`.
2. Write the smallest change that removes the cause; do not refactor adjacent code.
3. Add or update a regression test that fails before the fix and passes after it.
4. Write `fix.md`:
   - `## Causa corregida` — one sentence tied to the diagnosis.
   - `## Archivos` — path and purpose of every touched file.
   - `## Prueba de regresión` — test name and command.
   - `## Fuera de alcance` — what was deliberately not touched.
   - `## Riesgos` — remaining uncertainty.
5. Run the narrow test suite and the package typecheck.

**Artifacts**: `.specify/bugs/<slug>/fix.md` plus the code and test changes.

**Exit states**
- `FIXED` — regression test green and typecheck clean; continue to `bug-test`.
- `BLOCKED` — the fix requires a scope or design change; record why and stop.

**Guardrails**
- Never weaken an existing test to make the suite pass.
- Never include unrelated formatting or dependency updates.
- No `TODO`, `FIXME` or placeholder code.

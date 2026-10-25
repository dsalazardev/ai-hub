---
name: speckit-bug-assess
description: Diagnose a bug without editing code. Use when a defect needs a reproducible root cause before any fix is authorized.
license: MIT
compatibility: Requires access to logs, tests and the repository.
metadata:
  author: onna
  version: "1.0"
---

Produce a diagnosis that another engineer could reproduce.

**Input**: the failing report, logs, and the affected route or component.

**Steps**

1. Reproduce the defect or record why it cannot be reproduced.
2. Write `assessment.md`:
   - `## Síntoma` — observed vs expected, with the exact request or action.
   - `## Reproducción` — numbered steps and environment.
   - `## Evidencia` — logs, stack traces, failing test names.
   - `## Causa raíz` — the smallest code path or data state that explains it.
   - `## Alcance` — modules affected and modules explicitly not affected.
   - `## Fix propuesto` — approach only, no patch.
   - `## Riesgo de regresión` — tests that must stay green.
3. Point to file and line for the root cause; if unknown, say `NO DETERMINADA`.
4. Do not edit source, tests or configuration in this phase.

**Artifacts**: `.specify/bugs/<slug>/assessment.md`

**Exit states**
- `ROOT_CAUSE` — diagnosis complete; continue to `bug-fix`.
- `NEEDS_DATA` — reproduction or evidence is missing; list exactly what is needed.

**Guardrails**
- Never guess a root cause from a stack trace alone.
- Do not propose a fix that changes architecture; that requires a feature change.
- Never mark a bug fixed from this phase.

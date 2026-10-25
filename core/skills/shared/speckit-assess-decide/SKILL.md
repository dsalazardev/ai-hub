---
name: speckit-assess-decide
description: Score the assessment and produce a GO, KILL or NEEDS_CLARIFICATION decision. Use when intake, research, problem and concept are complete.
license: MIT
compatibility: Requires the Spec Kit layout under `.specify/assessments/`.
metadata:
  author: onna
  version: "1.0"
---

Close the assessment lane with an explicit, auditable decision.

**Input**: `intake.md`, `research.md`, `problem.md` and `concept.md` for the same slug.

**Steps**

1. Score each dimension from 1 to 5 in `decision.md`:
   - `## Scorecard` — problema, evidencia, impacto, esfuerzo, reversibilidad.
   - `## Decisión` — `GO`, `KILL` or `NEEDS_CLARIFICATION`.
   - `## Justificación` — two paragraphs tied to the scorecard.
   - `## Condiciones` — what must remain true for the decision to hold.
   - `## Siguiente paso` — the exact change name for the feature lane, or the archive path.
2. Apply the thresholds: `GO` requires evidence >= 3, impacto >= 3 and reversibilidad >= 3.
3. If the decision is `KILL`, state what would have to change to reopen it.
4. Hand off to the feature lane only with a human acknowledgment when the issue is `ai::spec-ready`.

**Artifacts**: `.specify/assessments/<slug>/decision.md`

**Exit states**
- `GO` — proceed to `/speckit.constitution` and `/speckit.specify`.
- `KILL` — archive the assessment directory with the decision.
- `NEEDS_CLARIFICATION` — return to `assess-define` with the open question.

**Guardrails**
- Never approve your own `ai::spec-ready`; the human gate is mandatory.
- Do not hide a low score behind optimistic prose.

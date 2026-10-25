---
name: speckit-assess-define
description: Define the problem, users, goals and success metrics of an idea with evidence. Use after assess-research confirmed the assumptions.
license: MIT
compatibility: Requires the Spec Kit layout under `.specify/assessments/`.
metadata:
  author: onna
  version: "1.0"
---

Write the problem definition that the rest of the assessment will be judged against.

**Input**: `intake.md` and `research.md` for the same slug.

**Steps**

1. Write `problem.md`:
   - `## Problema` — one paragraph, present tense, no solution.
   - `## Usuarios` — primary and secondary, with frequency and context.
   - `## Objetivos` — numbered, each measurable.
   - `## No objetivos` — what this change deliberately excludes.
   - `## Métricas` — baseline, target and how each is collected.
   - `## Restricciones` — technical, legal or operational limits found in research.
2. Check that every objective maps to at least one metric and one user.
3. Remove adjectives that cannot be measured ("rápido", "fácil", "robusto").

**Artifacts**: `.specify/assessments/<slug>/problem.md`

**Exit states**
- `GO` — problem, users, objectives and metrics are complete and consistent.
- `NEEDS_CLARIFICATION` — an objective has no metric or an affected user is unknown.
- `KILL` — the problem is real but the cost or constraints make it unviable now.

**Guardrails**
- Do not write requirements, user stories or acceptance criteria yet; that belongs to `spec.md`.
- Never set a target without a baseline.

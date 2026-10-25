---
name: speckit-assess-intake
description: Capture and normalize a raw idea before investing in research. Use when an issue or request arrives without a clear problem statement, owner or success signal.
license: MIT
compatibility: Requires the Spec Kit layout under `.specify/assessments/`.
metadata:
  author: onna
  version: "1.0"
---

Capture the idea exactly as it arrived, then normalize it without judging it yet.

**Input**: the raw request (issue, message or note) and an optional slug.

**Steps**

1. Read the request and separate facts from assumptions. Do not research solutions yet.
2. Assign a kebab-case slug and create `.specify/assessments/<slug>/`.
3. Write `intake.md` with these headings only:
   - `## Petición original` — verbatim, quoted.
   - `## Problema observado` — one paragraph, no solution language.
   - `## Afectados` — who suffers the problem and how often.
   - `## Señal de éxito` — observable metric or event.
   - `## Supuestos` — numbered, each falsifiable.
   - `## Preguntas abiertas` — numbered, each answerable by research.
4. Reject ideas that cannot name an affected user or a success signal: record why.

**Artifacts**: `.specify/assessments/<slug>/intake.md`

**Exit states**
- `GO` — problem, users and success signal exist; continue to `assess-research`.
- `NEEDS_CLARIFICATION` — a question blocks research; ask the human and stop.
- `KILL` — no affected user or no observable outcome; archive with the reason.

**Guardrails**
- Never propose architecture, libraries or estimates in this phase.
- Never invent quotes, metrics or owners.
- Keep every assumption falsifiable; vague language such as "mejorar" is not a success signal.

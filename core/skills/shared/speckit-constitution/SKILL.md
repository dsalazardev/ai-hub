---
name: speckit-constitution
description: Create or update the project constitution that every Spec Kit artifact must obey. Use before specifying a feature, or when the team ratifies a new non-negotiable rule.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/.
metadata:
  author: onna
  version: "1.0"
---

Establish the rules that outrank every feature decision.

**Input**: the project's values, non-negotiables and any existing `.specify/memory/constitution.md`.

**Steps**

1. Read the current constitution and the repository conventions. Do not invent rules the team has not accepted.
2. Write or update `.specify/memory/constitution.md`:
   - `## Principios` — numbered, each with a one-line rationale.
   - `## Restricciones técnicas` — stack, compatibility, security, data handling.
   - `## Calidad` — test thresholds, review gates, definition of done.
   - `## Gobierno` — who can change the constitution and how.
3. Mark every principle as `MUST`, `MUST NOT` or `SHOULD`; avoid vague language.
4. Record the version and the date of ratification.

**Artifacts**: `.specify/memory/constitution.md`

**Exit states**
- `CREATED` — first constitution written.
- `UPDATED` — existing constitution amended with a recorded reason.

**Guardrails**
- Never overwrite a ratified principle without an explicit human decision.
- Do not encode feature-specific requirements here; those belong to `spec.md`.
- A constitution change invalidates prior approvals bound to it.

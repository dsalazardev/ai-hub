---
name: speckit-assess-research
description: Gather evidence for and against an idea before shaping a solution. Use after assess-intake produced a problem statement with falsifiable assumptions.
license: MIT
compatibility: Requires the Spec Kit layout under `.specify/assessments/`.
metadata:
  author: onna
  version: "1.0"
---

Turn the intake assumptions into evidence, not opinions.

**Input**: `.specify/assessments/<slug>/intake.md`.

**Steps**

1. For each assumption, search the repository, the GitLab issues and the public documentation.
2. Record evidence in `research.md`:
   - `## Evidencia a favor` — claim, source, date and how it was verified.
   - `## Evidencia en contra` — same shape; do not omit inconvenient findings.
   - `## Precedentes` — existing modules or issues that already solved part of this.
   - `## Coste de oportunidad` — what the team stops doing if this proceeds.
   - `## Supuestos refutados` — the intake assumptions that did not survive.
3. Prefer primary sources (code, API docs, telemetry) over blog posts.
4. Mark every unverifiable claim as `NO VERIFICADO`; never present it as fact.

**Artifacts**: `.specify/assessments/<slug>/research.md`

**Exit states**
- `GO` — at least one assumption confirmed and none refuted fatally.
- `NEEDS_CLARIFICATION` — the evidence is insufficient and a human can unblock it.
- `KILL` — the evidence refutes the core problem or a cheaper precedent already exists.

**Guardrails**
- Cite sources with paths or URLs; an uncited claim is not evidence.
- Do not design the solution, estimate effort or choose libraries.

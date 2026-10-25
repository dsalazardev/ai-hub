# Spec Kit proposal template

Use this template when the orchestrator needs a feature specification.

## Context

- TASK: {{TASK}}
- LANE: assessment | feature | bug

## Structure

1. **Title** — short and descriptive.
2. **Problem** — one paragraph, no solution language.
3. **Requirements** — EARS statements with `MUST` / `MUST NOT`.
4. **Scenarios** — `#### Scenario:` blocks with WHEN/THEN.
5. **Plan** — components, contracts, data flow and risks.
6. **Tasks** — atomic checklist with a verification criterion per task.
7. **Out of scope** — what this change deliberately excludes.

## Artifacts

- `.specify/memory/constitution.md`
- `specs/<feature>/spec.md`
- `specs/<feature>/plan.md`
- `specs/<feature>/tasks.md`

## Placeholders

- `{{TASK}}` — high-level task name.
- `<feature>` — kebab-case feature id.

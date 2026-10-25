# Spec Kit exploration template

Use this template when the orchestrator needs to investigate before a spec.

## Context

- QUESTION: {{QUESTION}}

## Structure

1. **Question** — what exactly must be answered.
2. **Evidence** — file path or command per claim.
3. **Facts vs assumptions** — mark assumptions `NO VERIFICADO`.
4. **Affected paths** — source, tests and configuration.
5. **Open questions** — what still blocks a specification.
6. **Recommendation** — investigate further, specify, or kill.

## Artifact

`.planning/findings.md`

## Rules

- Never modify code to answer a question.
- Never invent an endpoint, schema or behavior.
- Prefer code and tests over prose.

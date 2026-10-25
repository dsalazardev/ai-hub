# Core rules — any project

> This file is scaffolded by `ai-hub init` and belongs to the project after that.
> The engine never overwrites it.

## Source of truth

- `manifest.yaml` describes the project: preset, stack, commands, paths and targets.
- `.ai-hubrc.json` records the machine-local choices (`dir`, `preset`, `targets`, `guardMode`).
- `.ai-hub/` owns the editable rules, agents and extra skills.
- `.planning/` owns session state and the decision ledger.

## Active methodology: Spec Kit

Only the 17 Spec Kit commands run the development pipeline:

- Assessment: `assess-intake`, `assess-research`, `assess-define`, `assess-shape`, `assess-decide`.
- Feature: `constitution`, `specify`, `clarify`, `plan`, `checklist`, `tasks`, `analyze`, `implement`, `converge`.
- Bug: `bug-assess`, `bug-fix`, `bug-test`.

Artifacts live under `specs/<feature>/` and `.specify/`. No other methodology is active at runtime.

## Non-negotiables

- A change needs an approved spec before implementation.
- `ai::spec-ready` is approved by a human bound to the artifact hash; agents never self-approve.
- Work happens on a feature branch or worktree, never directly on a closed trunk.
- Tests and typecheck must pass before a task is marked complete.
- No `TODO`, `FIXME`, placeholder code or secrets in the repository.

## Memory

- `.planning/state.json` holds the active change, phase and task counts.
- `.planning/memory.jsonl` holds decisions and checkpoints; prompts and file contents are never written.
- `ai-hub context` regenerates `.planning/context-next.md`.

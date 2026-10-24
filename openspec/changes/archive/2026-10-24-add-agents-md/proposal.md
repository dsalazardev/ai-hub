# Proposal

## Why

The repository has no root `AGENTS.md`. The rules an agent must follow are spread across `README.md`, `manifest.yaml`, `rules/core.md`, `orchestrator/*.md`, the OpenSpec/Spec Kit trees and the Lucid/Mermaid architecture, and they disagree on basics: the manifest and CLI assume a `.ai-hub/` folder while the checkout is `ai-hub`, the README still presents OpenSpec as the primary workflow while the target architecture uses Spec Kit, and the human-approval/hash rule exists only in design material. Every new session re-derives a different subset, which is exactly the drift this harness was meant to remove.

A single, short, normative file at the repository root gives every agent one entry point before it runs a command, and gives reviewers a fixed contract to audit against.

## What Changes

- Add `/AGENTS.md` at the repository root as the single source of truth for agent operation.
- Make reading it mandatory before any task, command or file edit, with an explicit precedence order against the other documents.
- Document the reference sources an agent must consult: `rsc-harness` (packaging, manifest hashing, CLI, worktree isolation, guards), `REPO-BETTATECH` (architecture and integration patterns), the Lucid master diagram and `architecture/` views 00–24.
- Describe the target system: `hermes-control` (HMAC webhooks, dedupe, state machine, policy A0–A5, PostgreSQL `SKIP LOCKED` queue, runner coordinator, evidence publisher), `hermes-agent` (Telegram/Slack/Discord/WhatsApp, push with SHA-256, pull commands) and the seven GitLab labels.
- Declare **Spec Kit** as the active methodology and OpenSpec as legacy reference only, and enumerate the 17 commands across the three lanes with their artifacts and verdicts.
- Add an 8-role agent matrix with explicit write boundaries, mapping the role names used by the product to the canonical agent files that exist today.
- State the non-negotiable gates: no self-approval of `ai::spec-ready`, approval bound to the SHA-256 of `spec.md + plan.md + tasks.md`, dynamic harness path resolution, and `.planning/` as the only session-state store.
- **BREAKING** for agent behavior: after this change, an agent that has not read `AGENTS.md` is considered non-compliant, and the root document wins over `README.md` and per-tool files when they disagree.

## Capabilities

### New Capabilities

None. This is a documentation and governance change: it adds an instruction file, not runtime behavior, so no spec delta is created and the change declares `skip_specs: true`.

### Modified Capabilities

None.

## Impact

- New tracked file: `AGENTS.md` (root). No source code, tests, schemas or dependencies change.
- Affects every agent session, the orchestrator startup protocol, and the review checklist; complements `README.md`, `manifest.yaml`, `rules/core.md` and `orchestrator/PROMPT.md` without replacing them.
- References machine-specific paths (`rsc-harness`, `REPO-BETTATECH`), a Lucid URL and `architecture/`; the document must degrade gracefully when a reference is unavailable.
- Documents a `resolveAiHubDir()` contract. Implementing that helper is explicitly out of scope for this change and must be planned separately.

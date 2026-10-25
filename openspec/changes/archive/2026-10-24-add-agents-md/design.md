# Design

## Context

See `proposal.md — Why` for motivation. Relevant current state:

- `README.md` describes AI Hub 2.0 with OpenSpec as the primary flow and uses `.ai-hub/…` paths.
- `manifest.yaml` registers 6 agents and points every definition at `.ai-hub/…`; the checkout is `ai-hub`, so those paths do not resolve.
- `rules/core.md` holds the non-negotiable coding conventions; `orchestrator/PROMPT.md` holds the state machine and the human gate.
- `architecture/` contains 25 Mermaid views plus the master; they are untracked today.
- `AGENTS.md` does not exist at the root.

The root document therefore has to do three jobs at once: be the first thing an agent reads, arbitrate between documents that disagree, and point to the deeper material instead of duplicating it.

## Goals / Non-Goals

**Goals**

- One mandatory entry point at `/AGENTS.md`, short enough to be read in full before every task.
- A precedence rule that resolves conflicts between this file, `README.md`, `manifest.yaml`, `rules/` and per-tool copies.
- A precise, checkable agent/write-boundary table.
- A stable statement of the Spec Kit lanes, gates, hash and state-on-disk rules.
- References that degrade gracefully when a local path does not exist on the current machine.

**Non-Goals**

- Implementing `resolveAiHubDir()`, the HMAC gateway, the queue, the state machine or `hermes-agent`. This change only writes the contract.
- Replacing `rules/core.md`, `manifest.yaml` or the orchestration prompts; they remain the detailed sources.
- Creating per-tool copies (`.claude/`, `.opencode/`, `.pi/`); generation stays with `ai-hub sync`.
- Restructuring `architecture/` or versioning it in this change.

## Decisions

### D1 — One root file, normative and link-first

`AGENTS.md` is a single ~250–350 line document with numbered sections (`1.`–`5.`) matching the requested structure, plus a short preamble and a precedence table. It uses MUST/SHOULD language and links to deeper files rather than copying their bodies.

*Alternative:* extend `README.md`. Rejected: the README is descriptive and tool-facing; a normative file needs different review and precedence.

### D2 — Precedence order

1. Explicit user instruction in the current session.
2. `AGENTS.md` (this file).
3. `manifest.yaml` (agent registry and write scopes).
4. `rules/core.md`, `orchestrator/PROMPT.md`, `architecture/` decisions.
5. `README.md` and per-tool generated copies.

A lower layer may add detail but MUST NOT contradict a higher one. If it does, the agent records the conflict in `.planning/` and follows the higher layer.

### D3 — References with explicit unavailability handling

The document names the four sources by role and path:

| Source | Use | If unavailable |
|---|---|---|
| `…\PROYECTOS_INTERESANTES\ai-hub` | packaging, manifest hashing, CLI, worktrees, guards | Skip; do not invent patterns |
| `…\ESCRITORIO\REPO-BETTATECH` | architecture and integration patterns | Skip; state the limitation |
| Lucid master URL | visual target architecture | Use `architecture/master-agentic-architecture.mmd` |
| `architecture/` (00–24) | component topology | Use the master file and README index |

Paths are machine-specific; the file says so and requires the agent to announce when a reference is missing instead of silently proceeding.

### D4 — Eight operational roles over six canonical files

The product matrix names eight roles; the repository ships six agent definitions. The document presents eight rows and maps each to its canonical implementation:

| Role | Canonical source | Writes |
|---|---|---|
| Prompt-Explorer | orchestrator (derived role, no agent file) | nothing (read-only prompt builder) |
| Spec-Explorer | `agents/explorer-domain.md` | `.planning/findings.md`, `.specify/assessments/**` |
| Reviewer-Exploration | orchestrator + human gate (derived) | nothing |
| Spec-Author | `agents/spec-author.md` | `.specify/**`, `specs/**`, `.planning/**` |
| Implementer-Frontend | `agents/implementer-frontend.md` | `frontend/src/**`, `frontend/src/app/**` |
| Implementer-Backend | `agents/implementer-backend.md` | `backend/src/**`, `backend/src/services/**` |
| Reviewer-Architecture | `agents/reviewer-architecture.md` | `.planning/review_arch_*.md` |
| Reviewer-Tests | `agents/reviewer-tests.md` | `.planning/review_tests_*.md` |

Derived roles are labelled as such so nobody looks for a non-existent file. `manifest.yaml` remains authoritative for machine-readable scopes; the table is the human summary and the strictest rule wins.

### D5 — Spec Kit is active, OpenSpec is legacy

The document states Spec Kit (`specify-cli`, `.specify/`) as the only active methodology and enumerates 17 commands in three lanes: Assessment (5), Core SDD (9), Bug Fix (3), with their artifacts and terminal verdicts. OpenSpec stays visible as historical reference under `openspec/` and MUST NOT be used for new work unless a human explicitly reopens it.

*Alternative:* leave both as equal options. Rejected: it keeps the current ambiguity and makes the 17-command contract unenforceable.

### D6 — Harness path contract

`resolveAiHubDir()` resolves, in order: `AI_HUB_DIR` env var → `ai_hub.dir` in local config → `./.ai-hub` if present → `./ai-hub` if present → repository root containing `manifest.yaml`. Consumers MUST use the resolver and MUST NOT hardcode either name. The document marks the helper as **normative but not yet implemented**; until it exists, the repository-root fallback applies.

### D7 — Approval is bound to content

The approvable set is exactly `spec.md`, `plan.md`, `tasks.md` of the change, hashed with SHA-256 over a canonical byte stream: paths sorted lexicographically, `/` separators, LF line endings, no BOM. The approval record stores `issue_iid`, `change_id`, `hash`, `approver`, `timestamp`. Any later change to the set invalidates the approval and forces a new one. `ai::spec-ready` is never self-approved; the only valid approvers are a human in GitLab or via `hermes-agent`.

*Alternative:* hash the whole `.specify/` tree. Rejected: too noisy (constitution and unrelated specs would invalidate approvals).

### D8 — State on disk

Session state lives in `.planning/` (`findings.md`, `impl_<name>.md`, `review_arch_<name>.md`, `review_tests_<name>.md`, `current.md`, `history.md`). Chat is not a store. If `.planning/` does not exist, the agent creates it on first write and records the decision in `history.md`.

### D9 — Document shape

| Section | Content |
|---|---|
| Preamble | Mandatory reading, precedence, conflict handling |
| 1. Sources | ai-hub, REPO-BETTATECH, Lucid, architecture/ with purpose and fallback |
| 2. Target architecture | `hermes-control` (8 components), `hermes-agent` (channels, push, pull), 7 GitLab labels |
| 3. Methodology | Spec Kit active; 17 commands in 3 tables; artifacts and verdicts |
| 4. Agents | 8-role matrix, canonical mapping, write scopes, prohibitions |
| 5. Security/gates | Approval + hash, path resolver, disk persistence, blocked/error routes |

## Risks / Trade-offs

- **Documentation rot** (the file drifts from `manifest.yaml`) → keep it short, link instead of copy, and add a review checklist item to update it whenever an agent or label changes.
- **False authority** (agents treat it as runtime enforcement) → state explicitly that it is policy, not a hook; enforcement belongs to the future `hermes-control`.
- **Machine-specific paths** → require announcing a missing reference and continuing with the local fallback; never fabricate content from an unavailable source.
- **Role aliases without files** → label the three derived roles and point to the orchestrator.
- **Hash canonicalization disputes** → fix the canonicalization in D7 and record it in the doc; if a tool computes it differently, the approval fails closed.
- **Contradiction with README** → precedence section D2; README is lower priority until it is updated in a later change.

## Migration Plan

1. Add `AGENTS.md` at the root (single commit).
2. Link it from the top of `README.md` in a follow-up change (not this one).
3. Rollback: delete the file; no runtime depends on it yet.

## Open Questions

- Whether `resolveAiHubDir()` should live in `core/src/context.ts` or a new `core/src/paths.ts` — deferred to the implementation change that adds the helper.
- Whether `specs/` or `.specify/specs/` becomes the canonical Spec Kit spec root for this monorepo — deferred; the document names both and lets the active `specify` layout decide at runtime.

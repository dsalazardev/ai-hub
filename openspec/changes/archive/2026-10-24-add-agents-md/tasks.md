# Tasks

## 1. Document skeleton and precedence

- [x] 1.1 Create `/AGENTS.md` with the title, a one-paragraph mandatory-reading preamble and a table of contents for the five numbered sections; verify the file exists and `Select-String -Path AGENTS.md -Pattern '^## [1-5]\.'` returns five headings.
- [x] 1.2 Add the precedence block (user instruction → AGENTS.md → manifest.yaml → rules/orchestrator/architecture → README) and the conflict rule that requires recording disagreements in `.planning/`; verify all five levels and the word "MUST" appear in the section.

## 2. Section 1 — Sources of truth

- [x] 2.1 Write the four-row reference table (rsc-harness, REPO-BETTATECH, Lucid URL, `architecture/` 00–24) with the intended use of each; verify all four names and the Lucid URL are present.
- [x] 2.2 Add the unavailability rule: if a local path does not exist, stop using that source, state the limitation and fall back to `architecture/master-agentic-architecture.mmd`; verify the sentence exists and no source is presented as guaranteed.
- [x] 2.3 Add the rule that reference material informs patterns but does not override this document or `rules/core.md`; verify the precedence sentence is present.

## 3. Section 2 — Target architecture

- [x] 3.1 Describe `hermes-control` with its eight components (HMAC webhook ingestion, dedupe/router, state machine, policy engine A0–A5, PostgreSQL `SKIP LOCKED` queue, prompt compiler, runner coordinator, evidence collector/publisher); verify all eight component names appear.
- [x] 3.2 Describe `hermes-agent` with the four channels (Telegram, Slack, Discord, WhatsApp), the Push list including `ai::spec-ready` with SHA-256 and the Pull commands (`aprobar <iid> <hash>`, `cambios <iid>`, `status <iid>`, `mover <iid>`); verify the four channels and four commands appear.
- [x] 3.3 List the seven canonical labels (`ai::todo`, `ai::in-spec`, `ai::spec-ready`, `ai::in-dev`, `ai::in-review`, `ai::done`, `ai::blocked`) and state that label changes emit events rather than running agents; verify a count of seven distinct `ai::` tokens.

## 4. Section 3 — Spec Kit methodology

- [x] 4.1 Declare Spec Kit (`specify-cli`, `.specify/`) as the only active methodology and OpenSpec as legacy reference; verify both statements are explicit and no wording presents OpenSpec as an alternative for new work.
- [x] 4.2 Add the Assessment lane with its five commands and the GO / KILL / NEEDS_CLARIFICATION outcomes; verify the five command tokens and the three outcomes.
- [x] 4.3 Add the Core SDD lane with its nine commands plus `constitution.md`, `spec.md`, `plan.md`, `tasks.md`, `Codebase` and `CONVERGED`; verify nine command tokens and the five artifacts.
- [x] 4.4 Add the Bug Fix lane with its three commands, `assessment.md`, `fix.md`, `test.md` and VERIFIED / PARTIAL / FAILED; verify the three commands and three verdicts.
- [x] 4.5 Add a single summary table with 17 rows or three tables totalling 17 commands; verify the total is exactly 17 and the split is 5 / 9 / 3.

## 5. Section 4 — Agent matrix and write limits

- [x] 5.1 Add the eight-role matrix (Prompt-Explorer, Spec-Explorer, Reviewer-Exploration, Spec-Author, Implementer-Frontend, Implementer-Backend, Reviewer-Architecture, Reviewer-Tests); verify eight rows.
- [x] 5.2 Map each role to its canonical agent file (`agents/*.md`) and its writable paths, and state that `manifest.yaml` is authoritative when the two disagree; verify each row names a file or is explicitly marked as a derived role.
- [x] 5.3 State the prohibitions: reviewers never write source, implementers never cross frontend/backend, spec-author never implements, nobody approves their own work; verify the four prohibitions are present.

## 6. Section 5 — Security contracts and gates

- [x] 6.1 Document the spec-ready gate: never self-approved, approver identity required, approval bound to the SHA-256 of `spec.md + plan.md + tasks.md`, canonicalization rules (sorted paths, `/`, LF, no BOM) and invalidation on change; verify all five elements appear.
- [x] 6.2 Document `resolveAiHubDir()` with the resolution order (`AI_HUB_DIR` → local config → `./.ai-hub` → `./ai-hub` → repo root with `manifest.yaml`) and the ban on hardcoding either name; verify the function name and the five-step order.
- [x] 6.3 Document `.planning/` as the only session-state store with the file list (`findings.md`, `impl_<name>.md`, `review_arch_<name>.md`, `review_tests_<name>.md`, `current.md`, `history.md`); verify all six names.

## 7. Consistency and delivery checks

- [x] 7.1 Cross-check the document against `manifest.yaml` and `rules/core.md`; record every intentional divergence in `.planning/findings.md`; verify no agent scope in the doc is wider than the manifest without a note.
- [x] 7.2 Validate Markdown structure: one H1, five H2 sections, no broken relative links to `architecture/`, `agents/`, `rules/`; verify with a link check over the referenced paths.
- [x] 7.3 Confirm the change touched no code or configuration other than `AGENTS.md`: run `git status --porcelain` and verify only `AGENTS.md` plus the change directory appear.

## Workflow follow-up

- Link `AGENTS.md` from the top of `README.md` in a separate documentation change.
- Plan the `resolveAiHubDir()` helper as its own change; this change only writes the contract.
- Archive this change after review.

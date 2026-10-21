---
name: openspec-workflow
description: Unified OpenSpec workflow skill. Replaces openspec-explore, openspec-propose, openspec-apply-change, and openspec-archive-change with a single tool-agnostic skill. Handles exploration, proposal, implementation, and archiving using the OpenSpec framework.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: Doligestion AI Hub
  version: "2.0"
  unifiedFrom:
    - openspec-explore
    - openspec-propose
    - openspec-apply-change
    - openspec-archive-change
---

# OpenSpec Workflow — Unified Skill

This skill consolidates the four OpenSpec lifecycle commands into a single tool-agnostic skill.

**Command syntax** (replaced by adapter at runtime):
- `{{OPSX_PREFIX}}explore` — Exploration mode
- `{{OPSX_PREFIX}}propose` — Create proposal + design + tasks
- `{{OPSX_PREFIX}}apply` — Implement tasks
- `{{OPSX_PREFIX}}archive` — Finalize and archive change

---

## {{OPSX_PREFIX}}explore — Exploration Mode

Enter explore mode. Think deeply. Visualize freely. Follow the conversation wherever it goes.

**IMPORTANT: Explore mode is for thinking, not implementing.** You may read files, search code, and investigate the codebase, but you must NEVER write code or implement features. If the user asks you to implement something, remind them to exit explore mode first and create a change proposal.

### The Stance

- **Curious, not prescriptive** — Ask questions that emerge naturally
- **Open threads, not interrogations** — Surface multiple directions
- **Visual** — Use ASCII diagrams liberally
- **Adaptive** — Follow interesting threads, pivot when needed
- **Patient** — Don't rush to conclusions
- **Grounded** — Explore the actual codebase

### What You Might Do

**Explore the problem space**
- Ask clarifying questions
- Challenge assumptions
- Reframe the problem
- Find analogies

**Investigate the codebase**
- Map existing architecture
- Find integration points
- Identify patterns
- Surface hidden complexity

**Compare options**
- Brainstorm multiple approaches
- Build comparison tables
- Sketch tradeoffs

### OpenSpec Awareness

At the start, check what exists:
```bash
openspec list --json
```

When no change exists: think freely, offer to create proposal when ready.

When a change exists: read `openspec/changes/<name>/{proposal,design,tasks}.md` for context.

### Guardrails

- **Don't implement** — Never write application code in explore mode
- **Don't fake understanding** — Dig deeper when unclear
- **Do visualize** — ASCII diagrams clarify thinking
- **Do question assumptions** — Including your own

---

## {{OPSX_PREFIX}}propose — Proposal Mode

Create a new change with all artifacts generated in one step.

**Input**: The user's request should include a change name (kebab-case) OR a description of what they want to build.

### Steps

1. **If no clear input provided, ask what they want to build**

   Ask: "What change do you want to work on? Describe what you want to build or fix."

   Derive a kebab-case name (e.g., "add user authentication" -> `add-user-auth`).

2. **Create the change directory**
   ```bash
   openspec new change "<name>"
   ```
   This creates `openspec/changes/<name>/` with `.openspec.yaml`.

3. **Get the artifact build order**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse JSON for:
   - `applyRequires`: artifacts needed before implementation
   - `artifacts`: list with status and dependencies

4. **Create artifacts in sequence**

   Loop through artifacts in dependency order:
   
   a. For each artifact that is `ready`:
      - Get instructions: `openspec instructions <artifact-id> --change "<name>" --json`
      - Read completed dependencies for context
      - Create artifact using `template` as structure
      - Apply `context` and `rules` as constraints (do NOT copy into file)
      - Show brief progress: "Created <artifact-id>"
   
   b. Continue until all `applyRequires` artifacts are complete
   
   c. If artifact requires user input, clarify with AskUserQuestion

5. **Show final status**
   ```bash
   openspec status --change "<name>"
   ```

### Output

After completing all artifacts:
- Change name and location
- List of artifacts created
- "All artifacts created! Ready for implementation."
- Prompt: "Run `{{OPSX_PREFIX}}apply` or ask me to implement to start working on the tasks."

### Guardrails

- Create ALL artifacts needed for implementation
- Always read dependency artifacts before creating new ones
- If context is critically unclear, ask the user
- If change already exists, ask if continuing or creating new
- Verify each artifact file exists after writing

---

## {{OPSX_PREFIX}}apply — Implementation Mode

Implement tasks from an OpenSpec change.

**Input**: Optionally specify a change name. If omitted, infer from conversation context. If ambiguous, prompt for selection.

### Steps

1. **Select the change**
   
   If name provided, use it. Otherwise infer from context or use AskUserQuestion to select.
   
   Announce: "Using change: <name>"

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse for `schemaName` and artifact dependencies.

3. **Get apply instructions**
   ```bash
   openspec instructions apply --change "<name>" --json
   ```
   This returns:
   - `contextFiles`: artifact paths
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction

   Handle states:
   - `blocked`: missing artifacts → suggest using explore/propose first
   - `all_done`: congratulate, suggest archive
   - Otherwise: proceed to implementation

4. **Read context files**
   
   Read every file path listed under `contextFiles`.

5. **Show current progress**
   
   Display: schema, progress "N/M tasks complete", remaining tasks overview.

6. **Implement tasks (loop until done or blocked)**
   
   For each pending task:
   - Show which task is being worked on
   - Make code changes required
   - Keep changes minimal and focused
   - Mark task complete: `- [ ]` -> `- [x]`
   - Continue to next task
   
   Pause if:
   - Task is unclear → ask for clarification
   - Implementation reveals design issue → suggest updating artifacts
   - Error or blocker encountered → report and wait
   - User interrupts

7. **On completion or pause, show status**
   
   Display: tasks completed, overall progress, suggestions for next steps.

### Output During Implementation

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation...]
✓ Task complete
```

### Output On Completion

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

All tasks complete! Ready to archive this change.
Run: {{OPSX_PREFIX}}archive
```

### Guardrails

- Read context files before starting
- If task is ambiguous, pause and ask
- If implementation reveals issues, suggest artifact updates
- Keep code changes minimal and scoped
- Update task checkbox immediately after completing
- Pause on errors, blockers, or unclear requirements

---

## {{OPSX_PREFIX}}archive — Archive Mode

Archive a completed change in the experimental workflow.

**Input**: Optionally specify a change name. If omitted, infer from context. If ambiguous, prompt for selection.

### Steps

1. **If no change name provided, prompt for selection**
   
   Run `openspec list --json` and use AskUserQuestion to let user select.
   Show only active changes (not archived).

2. **Check artifact completion status**
   ```bash
   openspec status --change "<name>" --json
   ```
   
   If any artifacts not `done`: warn, ask for confirmation.

3. **Check task completion status**
   
   Read `tasks.md`, count `- [ ]` vs `- [x]`.
   
   If incomplete tasks found: warn, ask for confirmation.

4. **Assess delta spec sync state**
   
   Check `openspec/changes/<name>/specs/`. If none exist, proceed.
   
   If delta specs exist:
   - Compare with main specs at `openspec/specs/<capability>/spec.md`
   - Show summary of changes
   - Prompt: "Sync now (recommended)", "Archive without syncing"
   - If sync requested, use subagent to perform sync

5. **Perform the archive**
   ```bash
   mkdir -p openspec/changes/archive
   mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-DD-<name>
   ```

6. **Display summary**
   
   Show: change name, schema, archive location, sync status, warnings.

### Output On Success

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** openspec/changes/archive/YYYY-MM-DD-<name>/
**Specs:** ✓ Synced (or "No delta specs" or "Sync skipped")
```

### Guardrails

- Always prompt for change selection if not provided
- Use artifact graph for completion checking
- Don't block archive on warnings — inform and confirm
- Preserve `.openspec.yaml` when moving
- Show clear summary

---

## Tool-Agnostic Command Reference

The following table shows how commands map across tools:

| Operation | Claude Code | OpenCode | Generic |
|-----------|-------------|----------|---------|
| Explore | `/opsx:explore` | `/opsx-explore` | `{{OPSX_PREFIX}}explore` |
| Propose | `/opsx:propose` | `/opsx-propose` | `{{OPSX_PREFIX}}propose` |
| Apply | `/opsx:apply` | `/opsx-apply` | `{{OPSX_PREFIX}}apply` |
| Archive | `/opsx:archive` | `/opsx-archive` | `{{OPSX_PREFIX}}archive` |

The adapter file (`.ai-hub/skills/adapters/{claude,opencode}-commands.yaml`) replaces `{{OPSX_PREFIX}}` with the appropriate prefix at load time.

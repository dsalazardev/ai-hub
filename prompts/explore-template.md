Explore Prompt Template

Use this template when running exploratory investigations (`/opsx-explore` semantics).

Context:
- TASK: {{TASK}}
- OPSX_PREFIX: {{OPSX_PREFIX}}

Instructions:
1. Read the repository files related to the task and report findings concisely.
2. List assumptions, unknowns, and one recommended next step.
3. If a code change is required, produce a minimal patch to implement it and include verification steps.

Output format (Markdown):
- Findings (short bullets)
- Assumptions (short)
- Proposed next step (one-line)
- Files to change (if any)

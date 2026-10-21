Propose Prompt Template

Use this template when generating an OpenSpec proposal (`/opsx-propose` semantics).

Context:
- TASK: {{TASK}}
- OPSX_PREFIX: {{OPSX_PREFIX}}

Template structure:
1. Title: short descriptive title
2. Problem statement: 1-2 paragraphs
3. Proposal: what will be implemented (files, routes, APIs)
4. Design summary: important decisions and security considerations
5. Tasks: checklist of implementation steps

Placeholders:
- {{TASK}} - high-level task name
- {{OPSX_PREFIX}} - CLI prefix used by orchestrator for commands

# rsc-harness agent assets

The installable agent definitions live in `core/agents/` and are registered in
`manifest.yaml` (`agents.publish`). This directory keeps the upstream catalog and
research provenance:

| File | Source |
|---|---|
| `agent-catalog.js` | `rsc-harness/targets/agent-catalog.js` |
| `agents.js` | `rsc-harness/targets/agents.js` |
| `agent-sources.json` | `rsc-harness/targets/agent-sources.json` |

Generated agents: 29 stack reviewers/build resolvers from `agent-catalog.js`.
Generic engine agents: 6. Total published: 35.

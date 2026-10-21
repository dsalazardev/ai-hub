# AI Hub 2.0 — Multi-Agent Orchestration for Doligestion

> **Single Source of Truth for AI Skills, Agents, and Orchestration Rules**
> 
> This directory implements the Harness + Subagents pattern (adapted from BettaTech) to eliminate skill duplication, context loss, and configuration drift across OpenCode and Claude Code.

---

## Quick Start

```bash
# 0. Create your local AI credentials file (never committed)
cp .ai-hub/.env.example .ai-hub/.env   # set GITLAB_TOKEN (see skills/shared/gitlab-auth)

# 1. Prepare the environment (once per clone; the devcontainer does it)
npm ci && npm run ai:setup

# 2. Regenerate the tool copies after editing .ai-hub/
npm run ai:sync

# 3. Verify the environment
./.ai-hub/bootstrap/verify.sh

# 4. Install planning skill for session persistence
./.ai-hub/bootstrap/install-planning-skill.sh
```

---

## Architecture Overview

```
User Input
    │
    ▼
┌─────────────────────────────────────┐
│  ORCHESTRATOR (Leader)              │
│  - Reads manifest.yaml              │
│  - Detects workspace (root/fe/be)   │
│  - Delegates to subagents           │
└─────────────────────────────────────┘
    │
    ├── /opsx:propose ──► Agent(spec-author)
    │
    ├── /opsx:apply ────► Agent(implementer-frontend)
    │                 └──► Agent(implementer-backend)
    │
    └── Review ─────────► Agent(reviewer-architecture)
                      └──► Agent(reviewer-tests)
```

---

## Directory Structure

| Directory | Purpose |
|-----------|---------|
| `orchestrator/` | Central coordinator prompt, workflow rules, delegation logic |
| `agents/` | Subagent definitions (spec-author, implementer-*, reviewer-*) |
| `skills/shared/` | Consolidated skills (one copy each, tool-agnostic) |
| `skills/adapters/` | Tool-specific command mappings (OpenCode vs Claude) |
| `mcp-local/` | Setup scripts for local MCP servers |
| `prompts/` | Reusable prompt templates |
| `bootstrap/` | Environment setup scripts |

---

## Key Principles

1. **Single Source of Truth**: Every skill exists exactly once in `skills/shared/`. Legacy locations (`.claude/`, `.opencode/`, `.agents/`) contain only symlinks.

2. **Tool Agnosticism**: Skills use `{{OPSX_PREFIX}}` tokens. Adapters replace them with tool-specific prefixes (`/opsx:` for Claude, `/opsx-` for OpenCode).

3. **State on Disk**: Following BettaTech's anti-broken-telephone rule, subagents write results to files (`.planning/impl_*.md`, `.planning/review_*.md`) instead of chat.

4. **Workspace Awareness**: `detect-workspace.sh` determines whether the developer opened the monorepo root, `/frontend`, or `/backend`, loading the appropriate skill set.

5. **Human Approval Gate**: The orchestrator pauses after `spec-author` completes. A human must approve the spec before implementation begins.

---

## Workflow

### 1. Exploration (`/opsx:explore` or `/opsx-explore`)
```
User: "How does the invoice approval flow work?"
Orchestrator: Launches explorer-domain
Output: .planning/findings.md
```

### 2. Proposal (`/opsx:propose` or `/opsx-propose`)
```
User: "Add recurring invoices"
Orchestrator: Launches spec-author
Output: openspec/changes/recurring-invoices/{proposal,design,tasks}.md
Status: spec_ready
⏸ HUMAN APPROVAL REQUIRED
```

### 3. Implementation (`/opsx:apply` or `/opsx-apply`)
```
User: "approved"
Orchestrator: Launches implementer-frontend + implementer-backend (parallel)
Output: frontend/src/**, backend/src/**, .planning/impl_*.md
```

### 4. Review
```
Orchestrator: Launches reviewer-architecture + reviewer-tests
Output: .planning/review_arch_*.md, .planning/review_tests_*.md
```

### 5. Archive (`/opsx:archive` or `/opsx-archive`)
```
Orchestrator: Moves change to openspec/changes/archive/
Updates: .planning/history.md
```

---

## Agent Registry

See `.ai-hub/manifest.yaml` for the complete registry.

| Agent | Role | Can Modify | Cannot Modify |
|-------|------|------------|---------------|
| **spec-author** | Writes OpenSpec specs | `openspec/**`, `.planning/**` | `frontend/**`, `backend/**` |
| **implementer-frontend** | Angular 22 code | `frontend/**` | `backend/**` |
| **implementer-backend** | Node.js BFF code | `backend/**` | `frontend/**` |
| **reviewer-architecture** | Validates conventions | `.planning/review_arch_*.md` | All source code |
| **reviewer-tests** | Validates coverage | `.planning/review_tests_*.md` | All source code |
| **explorer-domain** | Investigates before spec | `.planning/findings.md` | All source code |

---

## Skill Inventory

### Shared Skills (all workspaces)
- `openspec-workflow` — Unified propose/explore/apply/archive
- `angular-developer` — Angular 22 standalone, Signals, inject()
- `onna-architecture-common` — Domain models, DTOs, enums, Zero-Any policy

### Frontend-Only Skills
- `onna-architecture-angular` — Components, DALs, Services, Tailwind CSS 4
- `onna-design-system` — Glassmorphism, responsive design, Material patterns

### Backend-Only Skills
- `onna-architecture-bff` — Express routes, DolibarrDal composition, ErrorResult

---

## Compatibility

| Feature | OpenCode | Claude Code |
|---------|----------|-------------|
| Command syntax | `/opsx-explore` | `/opsx:explore` |
| Subagent launch | `Task` tool | `Task` tool (universal!) |
| File ops | `Read/Write/Edit` | `Read/Write/Edit` |
| Bash | Supported | Supported |

**Note**: We use `Task` tool (not `Agent`) for subagent launch because `Agent` is Claude-only.

---

## Troubleshooting

### verify.sh fails with "copias generadas desactualizadas"
Run `npm run ai:sync`. If it still fails, `npm run ai:check` shows which copy differs and which source to edit. Never edit the generated copies by hand.

### verify.sh fails with "frontend build error"
Ensure `cd frontend && npm install && ng build` works independently.

### verify.sh fails with "backend TypeScript errors"
Ensure `cd backend && npx tsc --noEmit` works independently.

### Subagent not found
Check `manifest.yaml` — the agent definition path must be relative to repo root.

---

## References

- **Doligestion Constitution**: `AGENTS.md` (root)
- **OpenSpec Changes**: `openspec/changes/`
- **BettaTech Harness**: `/tmp/betta-tech-repos/harness-sdd/`
- **Planning Skill**: `https://github.com/othmanadi/planning-with-files`

---

*Version: 2.0 | Last updated: 2026-05-14*

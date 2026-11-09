# Security policy — @dsalazardev/ai-hub-cli

## Reporting a vulnerability

Report it privately to the maintainer (Daner Alejandro Salazar Colorado) through the repository's
private vulnerability reporting, not in a public issue. Include the version (`npx ai-hub --version`),
the command you ran, what happened and the smallest reproduction you can share. Never include real
tokens, `.env` contents or customer data: replace them with a placeholder.

You should get an acknowledgement within 5 working days. Fixes ship in a patch release and the
CHANGELOG names the issue once a fixed version is published.

## Supported versions

Only the latest minor release on npm (`latest` dist-tag) receives security fixes.

## Attack surface of the harness

| Surface | What it does | Guarantees |
|---|---|---|
| `init` / `install` / `sync` | Write `.ai-hub/` and the agent destinations of the selected targets | Never write credentials; never overwrite a file the project edited; snapshot before risky steps |
| Host hooks (`ai-hub hook pre\|post\|stop`) | Run on every shell command and edit of Claude Code and OpenCode | Fail open on any error; `guardMode: shadow` by default; the post hook reports, never reverts |
| Git hooks (`hooks install`) | `pre-commit` / `post-merge` | Exit 0 when `npx` is missing; never block because the harness is absent |
| `.ai-hub/.env` | Local credentials of the harness | Ignored by git from `init`; excluded from snapshots; only presence of keys is checked; the token is only typed by the person in the interactive assistant |
| `doctor --online`, `control tick --online` | One read-only request to the declared tracker | Opt-in; output redacted; no write calls |
| `ai-hub runs` | Run telemetry in `.ai-hub/runs/` (ignored) | Closed schema; rejects prompts, file contents, credential-looking strings and values of `.ai-hub/.env` |
| Generated rules and skills | Text loaded into coding agents | Ingested content is data, never instructions (universal rule); references are linted before publishing |

## Rotating credentials

If a token reached a commit, an issue, a log or a snapshot: revoke it in the tracker first, create a
new one, replace it in `.ai-hub/.env`, and run `npx ai-hub doctor --online`. Removing the file from
git history does not make a leaked token safe; revocation does.

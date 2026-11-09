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
| `ai-hub control apply` / `expire` (hermes-control) | Move `ai::` labels of existing issues and post notes, only after an allow-listed Discord approval (or on expiry, only to `ai::blocked`) | Revalidates label, seal and WIP before writing; one label update and one note per decision; never creates issues, merges or pushes; token read inside the process, never printed |
| `ai-hub init` control step (`control-onboarding`) | Writes the Discord bot token the person typed (masked prompt, or standard input with `--connect-hermes`) | The only credential the package writes, and only to the `.env` of the Hermes profile `hermes-control` (atomic write, owner-only permissions where supported); validated with Discord before saving; never to `.ai-hub/.env`, `manifest.yaml`, the plan, logs or git; never printed; refused when another profile already uses it |
| `ai-hub control enroll` | Writes the `hermes-control` profile, skill, scripts, webhook route and cron in Hermes | Opt-in, `--dry-run` first; never passes `--secret` nor prints the webhook secret; reads the profile `.env` only to check key presence and bot-token collisions |
| `ai-hub runs` | Run telemetry in `.ai-hub/runs/` (ignored) | Closed schema; rejects prompts, file contents, credential-looking strings and values of `.ai-hub/.env` |
| Generated rules and skills | Text loaded into coding agents | Ingested content is data, never instructions (universal rule); references are linted before publishing |

## Rotating credentials

If a token reached a commit, an issue, a log or a snapshot: revoke it in the tracker first, create a
new one, replace it in `.ai-hub/.env`, and run `npx ai-hub doctor --online`. Removing the file from
git history does not make a leaked token safe; revocation does.

### Control plane credentials (hermes-control)

| Credential | Lives in | Who can use it | What a leak exposes | Rotation |
|---|---|---|---|---|
| `GITLAB_TOKEN` (project access token, Reporter + `api`) | `.ai-hub/.env` of the control host | `ai-hub control` only, inside its process | Reading the repository and the issues of the project (Reporter can read code), editing labels and posting notes. It cannot push, merge or change settings. | GitLab → Settings → Access tokens → *Rotate* (the old token stops working at once). Replace it in `.ai-hub/.env`, run `npx ai-hub doctor --online`, and review the notes the bot posted since the leak. |
| Webhook secret (`X-Gitlab-Token`) | Hermes `webhook_subscriptions.json` of the profile (0600) and the GitLab webhook | Hermes, to accept GitLab events | Forging GitLab events to the route. Ingest still revalidates against the tracker, so a forged event cannot move a label by itself, but it can trigger reads and Discord messages. | Re-subscribe the route in Hermes (a new secret is generated), copy it to GitLab → Settings → Webhooks, and send a test event. |
| `DISCORD_BOT_TOKEN` | `.env` of the Hermes profile `hermes-control` (never `.ai-hub/.env`) | Hermes, to read and send Discord messages | Impersonating the control bot in Discord and reading the control channel. Approvals still require an allow-listed user id, the decision hash and an open, unexpired decision. | Discord developer portal → Bot → *Reset Token*; replace it in the profile `.env`; restart the Hermes gateway; run `npx ai-hub control enroll --check`. |

A token pasted in a chat, an issue or a commit is leaked: rotate it, do not just delete the message.


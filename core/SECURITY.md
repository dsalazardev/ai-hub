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

## Known vulnerabilities

### Input of the idea step of the init assistant (since 0.7.0)

**Affected versions:** 0.7.0–0.13.0, every published version with the interactive assistant.

**What happens.** Pasting multi-line text into «¿Cuál es la idea del proyecto?» resolves the prompt at the first
line break. The rest of the paste stays in the terminal input buffer. It can answer the plan confirmation without
the person confirming: a `y` before any `n` in the remaining text answers «Sí» and applies the plan. When the process
exits, the shell runs the rest as commands.

**Measured** in Windows PowerShell 5.1 under ConPTY with 400 pasted lines:

- the plan confirmation was answered «No» with no human input;
- pasted lines 19–399 reached the shell after `init` exited, producing 42 PowerShell errors.

**Mitigation until the fix ships:** type the idea by hand, as one sentence; do not paste it.

**Residual risk after the fix (cancelling a paste mid-way).** If Ctrl+C or Esc cancels while a bracketed paste is
still arriving, the entry keeps consuming input until the paste-end marker (`\x1b[201~`), with a 1 s quiet window and
a 5 s cap, so pauses in the delivery do not let bytes through. If the cap is reached first, it prints
`quedan bytes del pegado en la terminal` and exits anyway: the rest of the paste may then reach the shell. The cap
exists because draining a 1 MiB paste cancelled half-way would block the person for about 70 s on Windows. At the
measured ~15 KB/s of the Windows console this affects only pastes whose remaining part exceeds roughly 75 KB when
cancelled; if you see the warning, clear the line in your shell before pressing Enter.

**Fix:** the multi-line idea entry, in the next release. It enables bracketed paste, consumes every pasted byte and
never lets a line break submit. For non-interactive runs, `--idea-file` is the safe path.

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
| Idea step of `init` (assistant entry, `--idea-file`, `--idea-stdin`, `--idea-editor`) | Reads the project idea and writes it to `backlog/seed.md` (and `IDEA.md` with the control step) | Bracketed paste is enabled and every pasted byte is consumed before returning, so nothing reaches a later prompt or the shell; raw mode is restored on every exit; a line break never submits; 4 MiB limit (`AI_HUB_MAX_IDEA`), never truncated; the idea never enters the plan, lock, manifest, runs or any message; an existing seed is never overwritten. In conhost without bracketed paste a 30 ms quiet window and a final drain apply. On Windows the console delivers a paste at about 15 KB/s, so for texts above ~64 KiB use Ctrl+E or `--idea-file`; the 4 MiB limit is a memory limit, not a paste limit |
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


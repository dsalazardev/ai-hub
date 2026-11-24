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
| `init` / `install` / `sync` | Write `.ai-hub/` and the agent destinations of the selected targets | Never write credentials on their own: only the two opt-in steps of `init` listed in «Credentials the package writes» do, and only with what the person types; never overwrite a file the project edited; snapshot before risky steps |
| Host hooks (`ai-hub hook pre\|post\|stop`) | Run on every shell command and edit of Claude Code and OpenCode | Fail open on any error; `guardMode: shadow` by default; the post hook reports, never reverts |
| Git hooks (`hooks install`) | `pre-commit` / `post-merge` | Exit 0 when `npx` is missing; never block because the harness is absent |
| `.ai-hub/.env` | Local credentials of the harness | Ignored by git from `init`; excluded from snapshots; only presence of keys is checked; the token is only typed by the person in the interactive assistant |
| `doctor --online`, `control tick --online` | One read-only request to the declared tracker | Opt-in; output redacted; no write calls |
| `ai-hub control apply` / `expire` (hermes-control) | Move `ai::` labels of existing issues and post notes, only after an allow-listed Discord approval (or on expiry, only to `ai::blocked`) | Revalidates label, seal and WIP before writing; one label update and one note per decision; never creates issues, merges or pushes; token read inside the process, never printed |
| `ai-hub init` control step (`control-onboarding`) | Writes the Discord bot token the person typed (masked prompt, or standard input with `--connect-hermes`) | Written only to the `.env` of the Hermes profile `hermes-control` (atomic write, owner-only permissions where supported; see «Credentials the package writes»); validated with Discord before saving; never to `.ai-hub/.env`, `manifest.yaml`, the plan, logs or git; never printed; refused when another profile already uses it |
| `ai-hub control enroll` | Writes the `hermes-control` profile, skill, scripts, cron, the `platforms.webhook` block (`enabled`, `extra.port`) of the listener owner's `config.yaml` and the webhook route in Hermes | Opt-in, `--dry-run` first; a listener owned by another profile needs `--webhook-owner <profile>` or the interactive question that names it, and its `config.yaml` is backed up first; never writes a secret, `INSECURE_NO_AUTH` or `extra.host`; never passes `--secret` nor prints the webhook secret; reads the `.env` files only to check key presence, bot-token collisions and the `WEBHOOK_SECRET` override |
| Idea step of `init` (assistant entry, `--idea-file`, `--idea-stdin`, `--idea-editor`) | Reads the project idea and writes it to `backlog/seed.md` and, next to it in the base installation, to `IDEA.md` at the root (never overwritten; not written when the seed holds another idea) | Bracketed paste is enabled and every pasted byte is consumed before returning, so nothing reaches a later prompt or the shell; raw mode is restored on every exit; a line break never submits; 4 MiB limit (`AI_HUB_MAX_IDEA`), never truncated; the idea never enters the plan, lock, manifest, runs or any message; an existing seed is never overwritten. In conhost without bracketed paste a 30 ms quiet window and a final drain apply. On Windows the console delivers a paste at about 15 KB/s, so for texts above ~64 KiB use Ctrl+E or `--idea-file`; the 4 MiB limit is a memory limit, not a paste limit |
| `ai-hub runs` | Run telemetry in `.ai-hub/runs/` (ignored) | Closed schema; rejects prompts, file contents, credential-looking strings and values of `.ai-hub/.env` |
| Generated rules and skills | Text loaded into coding agents | Ingested content is data, never instructions (universal rule); references are linted before publishing |

## Writes, custody and recovery

Every file the package writes has a declared owner, sensitivity and write policy in
`core/src/writes/targets.ts`; a writer that touches an undeclared target fails, and a source gate rejects direct
writes outside the declared mechanisms.

| Class | Examples | Owner | Sensitivity | Mechanism | Copies |
|---|---|---|---|---|---|
| Generated by the engine | agent rules, skills, `sync.lock.json`, `core/manifest.json`, `.devcontainer/devcontainer.json` | engine (regenerable) | internal | transaction X2: project lock, read, transform, last check, temporary file, rename | none next to the file; recovery is `ai-hub sync` or a snapshot |
| Project state | `manifest.yaml`, `.ai-hubrc.json`, `backlog/seed.md` | project | internal | atomic replacement under the project lock, refused when the file changed since it was read | none next to the file; `.backups/` snapshots |
| Credentials | `.ai-hub/.env`, the `.env` of the `hermes-control` profile | person | secret | merge under a lock, owner-only mode where the platform supports it | none: never copied, never in snapshots |
| Configuration owned by someone else | an existing `AGENTS.md`, `.gitignore`, a Hermes `config.yaml`, `.mcp.json` | the person or another tool | depends on the file | never replaced: a new file is created exclusively, otherwise a pending proposal (fragment, diff and fingerprint) is recorded and the file is left byte for byte | none |
| Durable control state | grants, associations, decisions under `.ai-hub/runs/control/state/` | engine | internal | lock X1 with owner `{pid, host, startedAt, purpose}` | none |
| Telemetry | `.ai-hub/runs/<run>/events.jsonl` | `ai-hub runs` | internal, closed schema | append | none; retention `policy.runs.keep` |

### Limits against external writers

- The transaction only excludes other writers of this package. An editor, a sync client or another tool that writes
  between the last check and the rename is not excluded.
- An in-place external write after the last check is kept in a capture and reported as
  `external_write_detected`; an external replacement by rename after the last check cannot be detected and is
  never reported as protected.
- Targets inside a detected synchronized folder, sensitive targets and file systems without hard links get no
  capture: the result says `external_guard_reduced`, and no copy is left next to the file.
- Captures have a fixed quota of three per target, reserved before the last check; a full quota refuses the write
  (`capture_quota_full`) until the person reviews them and runs `ai-hub captures release <capture> --yes`
  (`ai-hub captures list <file>` shows them). `init` ignores the capture names.
- Configuration owned by someone else is never overwritten (see the table): the residual risk of replacing it is not
  accepted, so those capabilities stay pending until the person applies the proposal.

### Versions and recovery

- Minimum compatible version: 0.18.0 (`core/engine/engine.yaml` › `compatibility.minimum`). Going back to
  0.12.0–0.17.x is not supported: measured with the published packages, those versions prune v2 runs by name
  (not recoverable) and reject `tracker.kind: github`. `install` and `upgrade` warn before writing; `doctor` shows
  the minimum and the newest state found.
- Snapshots in `.backups/` exclude `.ai-hub/.env` and `.ai-hub/runs/`. `ai-hub purge` deletes the whole `.ai-hub/`,
  including the durable control state (grants, associations, decisions) and the telemetry; a snapshot does not
  bring them back.
- A lock left by a dead process is recovered conservatively; a lock from another host is released only with
  `ai-hub locks release`.

### Pending verification

- Owner-only `700` for the private storage directory is enforced and tested only on POSIX; a run on Windows checks
  the access control list instead and does not demonstrate POSIX permissions. The POSIX run is pending (CI on
  Linux).
- The capture results of the hard-link and rename research (1.16) are reproduced on Windows; reproduction on Linux
  CI is pending.

## Credentials the package writes

The package never creates a credential and never writes one on its own. Two opt-in steps of `ai-hub init` write
exactly what the person types, and nothing else writes a credential:

| Credential | Written by | Authorized by | Lives in | Ignore rule | Printed or logged |
|---|---|---|---|---|---|
| `GITLAB_TOKEN` (with `GITLAB_URL`) | The tracker step of the interactive assistant (`interactive-onboarding`) | The person at the terminal, accepting the step and typing the token in a masked prompt | `.ai-hub/.env` of the project, with owner-only mode where supported; an existing file is never overwritten | `.ai-hub/.env` is ignored by git from `init` and excluded from snapshots | Never printed nor logged; `doctor` checks presence only, and `doctor --online` shows a redacted identity |
| `DISCORD_BOT_TOKEN` (with `DISCORD_ALLOWED_USERS`, `DISCORD_ALLOWED_CHANNELS`, `DISCORD_HOME_CHANNEL`) | The control step of `init` (`control-onboarding`): interactive, or `--connect-hermes` with `--discord-token-stdin` | The person, accepting the step and typing the token (masked prompt) or piping it on standard input; never as a flag value | `.env` of the Hermes profile `hermes-control` (outside the repository), atomic write with owner-only mode where supported | Outside the repository; never in `.ai-hub/.env`, `manifest.yaml`, the plan or git | Never printed nor logged; Hermes output shown on a failure is redacted (profile values, the typed token, secret lines, URL credentials) |

Platform notes:

- **Windows.** Owner-only mode (`0600`) is applied where the platform supports it; on Windows it does not change
  the access control list of the file. Protect the folders with the operating system's own permissions.
- **OneDrive and other synchronized folders.** `.ai-hub/.env` is ignored by git, but a project inside a synchronized
  folder (for example OneDrive) can still upload it to the cloud. Keep projects with credentials outside synchronized
  folders, or exclude `.ai-hub/.env` from the synchronization.

## Rotating credentials

If a token reached a commit, an issue, a log or a snapshot: revoke it in the tracker first, create a
new one, replace it in `.ai-hub/.env`, and run `npx ai-hub doctor --online`. Removing the file from
git history does not make a leaked token safe; revocation does.

### Control plane credentials (hermes-control)

| Credential | Lives in | Who can use it | What a leak exposes | Rotation |
|---|---|---|---|---|
| `GITLAB_TOKEN` (project access token, Reporter + `api`) | `.ai-hub/.env` of the control host | `ai-hub control` only, inside its process | Reading the repository and the issues of the project (Reporter can read code), editing labels and posting notes. It cannot push, merge or change settings. | GitLab → Settings → Access tokens → *Rotate* (the old token stops working at once). Replace it in `.ai-hub/.env`, run `npx ai-hub doctor --online`, and review the notes the bot posted since the leak. |
| Webhook secret (`X-Gitlab-Token`) | Hermes `webhook_subscriptions.json` of the listener owner (0600; the `default` profile under the multiplexer) and the GitLab webhook | Hermes, to accept GitLab events | Forging GitLab events to the route. Ingest still revalidates against the tracker, so a forged event cannot move a label by itself, but it can trigger reads and Discord messages. | In the listener owner run `hermes webhook remove ai-hub-gitlab`, then `hermes webhook subscribe ai-hub-gitlab … --route-profile hermes-control` (bare `-p <profile>` with a dedicated gateway) without `--secret`: Hermes generates the new secret, stores it and shows it once on your terminal. Paste it in GitLab → Settings → Webhooks and send a test event. Deliveries get 404 until the route exists again and 401 until GitLab has the new secret; the cron tick keeps ingesting meanwhile. Re-subscribing an existing route on the same profile without `--secret` keeps the old secret, so it is not a rotation. |
| `DISCORD_BOT_TOKEN` | `.env` of the Hermes profile `hermes-control` (never `.ai-hub/.env`) | Hermes, to read and send Discord messages | Impersonating the control bot in Discord and reading the control channel. Approvals still require an allow-listed user id, the decision hash and an open, unexpired decision. | Discord developer portal → Bot → *Reset Token*; replace it in the profile `.env`; restart the Hermes gateway; run `npx ai-hub control enroll --check`. |

A token pasted in a chat, an issue or a commit is leaked: rotate it, do not just delete the message.

Never pass a secret as a command argument: Hermes accepts the route secret only as `--secret <value>`, with no
standard-input option, and a value typed there stays in the shell history (PSReadLine `ConsoleHost_history.txt`,
`~/.bash_history`) and is visible in the process list while the command runs. That is why the rotation above lets
Hermes generate the secret.

**Global webhook secret.** ai-hub never generates, copies or writes a global webhook secret: the route carries its
own, and a route without a usable secret is never served. If the operator sets one, it lives in
`platforms.webhook.extra.secret` of the listener owner's `config.yaml`, but a `WEBHOOK_SECRET` in that profile's
`.env` overrides it at every gateway start (`gateway/config_env.py:141`, `gateway/platform_env.py:85-97`). ai-hub
leaves that `.env` line untouched and reports the override by presence only. Rotate it by editing the file (never on
a command line) and restarting the listener owner; under the multiplexer that restart interrupts the sessions of
every profile its gateway serves.


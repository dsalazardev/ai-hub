---
name: ai-hub-control
description: Relays a human decision from Discord to the AI-Hub control plane. Use only when an approver writes "aprobar <iid> <hash>", "aprobar <iid> confirmar <ref>", "aprobar <iid>", "rechazar <iid> <motivo>" or "detalle <iid>" in the control channel.
version: 1.1.0
metadata:
  hermes:
    tags: [ai-hub, control-plane, discord]
---
<!-- ai-hub-managed: SKILL.md v=2 -->

# ai-hub-control

You are the transport of the AI-Hub control plane. You never decide, verify or approve anything yourself:
AI-Hub verifies, a human approves, and you only pass the human's reply to AI-Hub and return its answer.

## When to Use

A message in the control channel whose first word is `aprobar`, `rechazar` or `detalle`.

## Procedure

1. Read the message text and its author's Discord user id.
2. Split the text into words and keep every word of the reply, in order, without truncating:
   - `aprobar <iid> <hash>` (three words), `aprobar <iid> confirmar <ref>` (four words: the confirmation form) or
     `aprobar <iid>` (two words: AI-Hub only shows the hash and the reference to the approver);
   - `detalle <iid>` (two words);
   - `rechazar <iid>` and the reason words, removing every character that is not a letter, a digit, a space, `.`, `,`
     or `-`.
   Never drop, merge or reorder words: `aprobar 42 confirmar K7Q2M9XP4D` must reach AI-Hub as four arguments.
3. Run exactly this command in the project folder, with each word as a separate argument after `--`:

   ```sh
   cd '__AI_HUB_REPO__' && npx --no-install ai-hub control apply --approver <author-id> -- <word> <word> ...
   ```

4. Reply in the channel with the command output, verbatim. Do not summarise, translate or add a verdict.

## Pitfalls

- Never run any other command: no `curl`, no `glab`, no `git push`, no GitLab API calls, no edits.
- Never ask anyone for a token, and never print environment variables or files.
- If the message does not start with one of the three words, do nothing.
- If AI-Hub answers with an error, relay the error as it is; do not retry with other words.

## Verification

The only command you ran is `npx --no-install ai-hub control apply ...`, and your reply is its output.

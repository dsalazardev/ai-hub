---
name: ai-hub-control
description: Relays a human decision from Discord to the AI-Hub control plane. Use only when an approver writes "aprobar <iid> <hash>", "rechazar <iid> <motivo>" or "detalle <iid>" in the control channel.
version: 1.0.0
metadata:
  hermes:
    tags: [ai-hub, control-plane, discord]
---

# ai-hub-control

You are the transport of the AI-Hub control plane. You never decide, verify or approve anything yourself:
AI-Hub verifies, a human approves, and you only pass the human's reply to AI-Hub and return its answer.

## When to Use

A message in the control channel whose first word is `aprobar`, `rechazar` or `detalle`.

## Procedure

1. Read the message text and its author's Discord user id.
2. Split the text into words. Keep only the first three words for `aprobar` and `detalle`
   (`aprobar <iid> <hash>`, `detalle <iid>`). For `rechazar`, keep `rechazar <iid>` and the reason words, removing
   every character that is not a letter, a digit, a space, `.`, `,` or `-`.
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

---
name: speckit-clarify
description: Resolve ambiguities in an existing specification by asking targeted questions and encoding the answers. Use when speckit-specify left open questions or inconsistent requirements.
license: MIT
compatibility: Requires the Spec Kit layout under .specify/ and specs/.
metadata:
  author: onna
  version: "1.0"
---

Turn ambiguity into a decision the implementation can follow.

**Input**: `specs/<feature>/spec.md` with open questions or disputed requirements.

**Steps**

1. List every ambiguity as a question with the requirement it affects.
2. Ask at most five questions per round, each answerable with a fact or a choice.
3. For each answer, update the requirement and its scenario; do not append a parallel note.
4. Record the decision and the discarded alternative in `## Decisiones`.
5. Remove the resolved question from `## Preguntas abiertas`.

**Artifacts**: `specs/<feature>/spec.md`

**Exit states**
- `RESOLVED` — no open questions remain and requirements are consistent.
- `OPEN` — a question still needs a human decision; list the blocker.

**Guardrails**
- Do not answer a product question on the user's behalf.
- Do not change scope silently while clarifying; surface any new behavior.
- Every answer must land in the spec, not only in the conversation.

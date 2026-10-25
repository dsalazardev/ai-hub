# Preflight guard

Before running a shell command, check it against these rules. They are the deterministic floor; the project may add stricter patterns in `manifest.yaml`.

- Recursive forced deletion, hard reset, forced push, destructive SQL and pipe-to-shell require explicit human confirmation.
- `mkfs`, raw-device writes, partition tools and fork bombs are denied.
- Never commit, merge or push on a closed trunk. Create a feature branch or a worktree and name the one you use.
- Do not switch to a branch that another worktree already has checked out.
- Do not move to the trunk while the current branch has uncommitted changes or commits without push. Run `ship`: commit, push and open the PR.
- If a project opts out of a rule, say so and continue; never silence a rule by guessing.
- When a command is denied, the denial names the rule and the way out. Follow the way out; do not rephrase the same destructive command.

#!/usr/bin/env bash
# AI Hub environment verification.
# Checks the engine, the project manifest and the Spec Kit inventory.
# It never requires a methodology-specific CLI other than the engine itself.

set -u

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

ok() { printf "${GREEN}[OK]${NC}    %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC}  %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC}  %s\n" "$1"; }

EXIT_CODE=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

echo ""
echo "AI Hub - environment verification"
echo ""

if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed"
  EXIT_CODE=1
else
  ok "node $(node --version)"
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not installed"
  EXIT_CODE=1
else
  ok "npm $(npm --version)"
fi

if ! command -v git >/dev/null 2>&1; then
  warn "git is not installed"
else
  ok "git $(git --version | head -1)"
fi

if [ ! -f core/dist/bin/ai-hub.js ]; then
  fail "core/dist is missing; run npm run ai:build"
  EXIT_CODE=1
else
  ok "ai-hub CLI compiled"
fi

if [ ! -f manifest.yaml ]; then
  fail "manifest.yaml is missing; run ai-hub init"
  EXIT_CODE=1
else
  ok "manifest.yaml present"
fi

if command -v node >/dev/null 2>&1 && [ -f core/dist/bin/ai-hub.js ]; then
  if npm run manifest:check >/dev/null 2>&1; then
    ok "manifest inventory is current"
  else
    fail "manifest inventory is stale; run npm run manifest:build"
    EXIT_CODE=1
  fi

  missing=0
  for skill in \
    speckit-assess-intake speckit-assess-research speckit-assess-define speckit-assess-shape speckit-assess-decide \
    speckit-constitution speckit-specify speckit-clarify speckit-plan speckit-checklist speckit-tasks speckit-analyze speckit-implement speckit-converge \
    speckit-bug-assess speckit-bug-fix speckit-bug-test; do
    if [ ! -f "core/skills/shared/$skill/SKILL.md" ]; then
      fail "missing Spec Kit skill: $skill"
      missing=1
    fi
  done
  if [ "$missing" -eq 0 ]; then
    ok "17 Spec Kit skills present"
  else
    EXIT_CODE=1
  fi

  if node core/dist/bin/ai-hub.js drift >/dev/null 2>&1; then
    ok "generated copies have no drift"
  else
    warn "generated copies drifted; run node core/dist/bin/ai-hub.js sync"
  fi

  if node core/dist/bin/ai-hub.js doctor >/dev/null 2>&1; then
    ok "doctor reports a healthy harness"
  else
    fail "doctor reported failed checks; run node core/dist/bin/ai-hub.js doctor"
    EXIT_CODE=1
  fi
fi

if [ ! -s .planning/current.md ]; then
  warn "no active session in .planning/current.md"
else
  ok ".planning/current.md present"
fi

if [ -f .ai-hub/.env ]; then
  ok ".ai-hub/.env present"
  if grep -qE "^GITLAB_TOKEN=.+" .ai-hub/.env 2>/dev/null; then
    ok "GITLAB_TOKEN configured (not shown)"
  else
    warn "GITLAB_TOKEN empty or missing"
  fi
else
  warn ".ai-hub/.env not present (only needed for GitLab skills)"
fi

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
  ok "Environment ready."
else
  fail "Environment is not ready. Resolve the failures above."
fi
echo ""

exit "$EXIT_CODE"

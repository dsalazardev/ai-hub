#!/usr/bin/env bash
set -euo pipefail

echo "[ai-hub] setup-playwright.sh - verifying Playwright environment"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node is not installed. Please install Node.js (v16+)." >&2
  exit 2
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "[ERROR] npx not found. Ensure npm is installed." >&2
  exit 3
fi

echo "Running: npx playwright install-deps"
if npx playwright install-deps; then
  echo "[OK] Playwright dependencies installed"
else
  echo "[WARN] playwright install-deps failed. If running in CI without display, ensure run with '--no-sandbox' or use official Playwright docker images." >&2
  exit 4
fi

echo "[OK] Playwright setup complete"
exit 0

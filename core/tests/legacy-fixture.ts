import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Consumidor heredado SINTÉTICO (factory-evolution E1, tarea 6.2): un arnés copiado dentro del
 * repositorio con manifiesto y lock v1, MCP dentro de `.ai-hub/`, metodología anterior y scripts
 * `ai:*`. Construido a mano a partir de los requisitos R1..R16 de la exploración; no copia nada de
 * ningún repositorio real ni contiene nombres o hosts de clientes.
 */
export const LEGACY_SENTINEL = 'AIHUB_TEST_SENTINEL_legacy_7c1d';

export const LEGACY_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'legacy-app',
      version: '1.0.0',
      scripts: {
        build: 'tsc',
        'ai:setup': 'node .ai-hub/core/dist/cli.js setup',
        'ai:sync': 'node .ai-hub/core/dist/cli.js sync',
        'ai:check': 'node .ai-hub/core/dist/cli.js sync --check',
        'ai:custom': 'echo custom',
      },
      devDependencies: { typescript: '^5.0.0' },
    },
    null,
    2,
  )}\n`,
  'tsconfig.json': '{}\n',
  '.ai-hub/core/package.json': `${JSON.stringify({ name: '@legacy/ai-hub-core', version: '0.1.0' }, null, 2)}\n`,
  '.ai-hub/core/dist/cli.js': 'console.log("legacy core");\n',
  '.ai-hub/core/src/index.ts': 'export const legacy = true;\n',
  '.ai-hub/manifest.yaml': [
    'schema: ai-hub-manifest',
    'version: 1',
    'project: legacy-app',
    'agents:',
    '  can_modify:',
    '    implementer-frontend: [frontend/src/**]',
    '    implementer-backend: [backend/src/**]',
    'rule_sources:',
    '  - .ai-hub/rules/frontend.md',
    '  - .ai-hub/rules/backend.md',
    'references:',
    '  - .ai-hub/references/flow.md',
    'legacy_paths:',
    '  - .claude/commands/opsx',
    'migration:',
    '  status: in_progress',
    'sync:',
    '  targets: [claude, opencode]',
    '',
  ].join('\n'),
  '.ai-hub/rules/frontend.md': '# Frontend rules\n\n- Components are standalone.\n',
  '.ai-hub/rules/backend.md': '# Backend rules\n\n- Handlers validate input at the boundary.\n',
  '.ai-hub/references/flow.md': '# Module flow\n\nRead the spec, then the plan.\n',
  '.ai-hub/sync.lock.json': `${JSON.stringify({ version: 1, sources: {}, files: {} }, null, 2)}\n`,
  '.ai-hub/mcp-manifest.yaml': [
    'required_mcps:',
    '  - name: browser',
    '    command: npx',
    '    args: ["-y", "@playwright/mcp@0.0.83"]',
    'integrations:',
    '  - name: tracker',
    '    type: skill',
    '    skill: gitlab-workflow',
    'prompts:',
    '  - name: issue-explore',
    '',
  ].join('\n'),
  '.ai-hub/.env': `GITLAB_URL=https://tracker.example.test\nGITLAB_TOKEN=${LEGACY_SENTINEL}\n`,
  'openspec/state.json': `${JSON.stringify({ version: 3, active_change: null }, null, 2)}\n`,
  'openspec/specs/billing/spec.md': '# Billing\n\n### Requirement: Invoices are numbered\n',
  '.planning/findings.md': '# Findings\n\n- legacy note\n',
  '.githooks/pre-commit': '#!/bin/sh\nnode .ai-hub/core/dist/cli.js sync --check\n',
  '.claude/commands/opsx/apply.md': '# opsx apply (legacy command)\n',
  'AGENTS.md': '# Legacy agents guide\n\nHand-written instructions owned by the team.\n',
};

export async function seedLegacyV1(root: string): Promise<void> {
  for (const [rel, content] of Object.entries(LEGACY_FILES)) {
    const file = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  }
}

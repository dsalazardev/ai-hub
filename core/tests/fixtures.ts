import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadEngine } from '../src/engine/engine.js';
import { speckitSequence } from '../src/speckit/commands.js';
import { effectiveSpeckit } from '../src/speckit/settings.js';
import { fakeRunner } from './speckit-fake.js';

export const AGENT_IDS = [
  'spec-author',
  'implementer-frontend',
  'implementer-backend',
  'reviewer-architecture',
  'reviewer-tests',
  'explorer-domain',
];

export const FIXTURE_TARGETS = ['claude', 'opencode', 'pi', 'cursor', 'copilot'];

export const MCP_FIXTURE = `required_mcps:
  - id: demo
    type: remote
    client:
      url: https://example.com/mcp
`;

export function fixtureManifest(): string {
  return stringify({
    version: 2,
    project: { id: 'fixture', name: 'Fixture' },
    preset: { id: 'generic-ts', version: 1, source: 'package' },
    stack: { languages: ['typescript'], packageManager: 'npm' },
    commands: {
      install: 'npm ci',
      build: 'npm run build',
      test: 'npm test',
      typecheck: 'npx tsc --noEmit',
    },
    paths: { source: ['src'], tests: ['tests'], docs: ['docs'] },
    targets: FIXTURE_TARGETS,
    policy: {
      trunk: 'auto',
      guardMode: 'shadow',
      worktrees: true,
      optOuts: [],
    },
    skills: { source: '.ai-hub/skills', publish: [] },
    agents: { source: '.ai-hub/agents', publish: AGENT_IDS },
    rules: { source: '.ai-hub/rules', publish: ['core'] },
    mcp: { source: 'mcp-manifest.yaml' },
  });
}

/** Reproduce sobre `root` la instalación de Spec Kit 1.2.3 para los destinos dados (sin uvx real). */
export async function seedSpeckit(root: string, targets: string[] = FIXTURE_TARGETS): Promise<void> {
  const settings = effectiveSpeckit({ targets }, await loadEngine());
  const fake = fakeRunner();
  for (const step of speckitSequence(settings)) {
    await fake.run('uvx', step, { cwd: root });
  }
}

export async function seedFixture(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', devDependencies: { typescript: '^5.0.0' } }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(root, 'manifest.yaml'), fixtureManifest(), 'utf8');
  await fs.writeFile(path.join(root, 'mcp-manifest.yaml'), MCP_FIXTURE, 'utf8');
  await fs.mkdir(path.join(root, '.ai-hub', 'rules'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.ai-hub', 'rules', 'core.md'),
    '# Fixture core rules\n\n- No implementation without a spec.\n',
    'utf8',
  );
  await fs.mkdir(path.join(root, '.ai-hub', 'agents'), { recursive: true });
  for (const id of AGENT_IDS) {
    await fs.writeFile(
      path.join(root, '.ai-hub', 'agents', `${id}.md`),
      `---\nname: ${id}\ndescription: fixture agent ${id}\n---\n\n# ${id}\n`,
      'utf8',
    );
  }
  await fs.mkdir(path.join(root, '.ai-hub', 'skills'), { recursive: true });
  await seedSpeckit(root);
}

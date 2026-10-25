import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from '../src/package-info.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCoupling, scanLegacyArtifacts } from '../src/engine/gates.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function write(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

describe('legacy artifact gate', () => {
  it('keeps the source checkout clean', async () => {
    expect(await scanLegacyArtifacts(REPO_ROOT)).toEqual([]);
  }, 20000);

  it('detects legacy names and content in the motor and generated destinations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-legacy-'));
    try {
      await write(root, 'core/presets/foo/legacy.md', 'run /opsx apply\n');
      await write(root, 'core/agents/legacy.md', 'Requires openspec CLI\n');
      await write(root, '.claude/commands/opsx-explore.md', '# command\n');
      await write(root, '.opencode/skills/openspec-explore/SKILL.md', '# skill\n');

      const findings = await scanLegacyArtifacts(root);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('core/presets/foo/legacy.md'),
          expect.stringContaining('core/agents/legacy.md'),
          expect.stringContaining('.claude/commands/opsx-explore.md'),
          expect.stringContaining('.opencode/skills/openspec-explore'),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('ignores benign mentions, the historical archive and workflows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-legacy-clean-'));
    try {
      await write(root, 'core/skills/shared/sdd-init/SKILL.md', 'Do not create an openspec/ tree.\n');
      await write(root, 'openspec/changes/archive/legacy.md', 'run /opsx apply\n');
      await write(root, '.github/workflows/legacy.yml', 'run: /opsx apply\n');

      expect(await scanLegacyArtifacts(root)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('in an engine checkout scans the catalog and ignores workshop destinations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-legacy-engine-'));
    try {
      await write(root, 'core/package.json', JSON.stringify({ name: PACKAGE_NAME }));
      await write(root, 'core/src/paths.ts', 'export {};\n');
      await write(root, 'core/skills/shared/foo/SKILL.md', 'run /opsx apply\n');
      await write(root, '.claude/commands/opsx-explore.md', '# command\n');

      const findings = await scanLegacyArtifacts(root);
      expect(findings.join('\n')).toContain('core/skills/shared/foo/SKILL.md');
      expect(findings.join('\n')).not.toContain('.claude/');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('coupling gate', () => {
  const terms = ['dolibarr', 'doligestion', 'onna-architecture'];

  it('keeps the motor free of domain terms', async () => {
    expect(await scanCoupling(REPO_ROOT, terms)).toEqual([]);
  });

  it('detects terms in motor surfaces and ignores presets, destinations and the rule list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-coupling-'));
    try {
      await write(root, 'core/src/domain.ts', 'export const name = "dolibarr";\n');
      await write(root, 'core/agents/domain.md', 'description: doligestion\n');
      await write(root, 'core/skills/shared/domain/SKILL.md', 'onna-architecture\n');
      await write(root, 'core/engine/engine.yaml', 'name: dolibarr\n');
      await write(root, 'core/engine/coupling.json', '{"terms":["dolibarr"]}\n');
      await write(root, 'core/presets/angular-express/domain.md', 'dolibarr\n');
      await write(root, '.claude/skills/domain/SKILL.md', 'dolibarr\n');

      const findings = await scanCoupling(root, terms);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('core/src/domain.ts'),
          expect.stringContaining('core/agents/domain.md'),
          expect.stringContaining('core/skills/shared/domain/SKILL.md'),
          expect.stringContaining('core/engine/engine.yaml'),
        ]),
      );
      expect(findings.join('\n')).not.toContain('core/engine/coupling.json');
      expect(findings.join('\n')).not.toContain('core/presets/');
      expect(findings.join('\n')).not.toContain('.claude/');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

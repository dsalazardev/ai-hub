import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

describe('engine coupling gate', () => {
  it('contains no domain terms in core/src', async () => {
    const rules = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'core', 'engine', 'coupling.json'), 'utf8'),
    ) as { terms: string[] };
    const files = await walk(path.join(REPO_ROOT, 'core', 'src'));
    const findings: string[] = [];
    for (const file of files) {
      if (!/\.(ts|js|mjs|md|yaml|json)$/.test(file)) {
        continue;
      }
      const text = (await fs.readFile(file, 'utf8')).toLowerCase();
      for (const term of rules.terms) {
        if (text.includes(term)) {
          findings.push(`${path.relative(REPO_ROOT, file)}: ${term}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('contains no legacy command prefix in presets or skills', async () => {
    const dirs = ['core/presets', 'core/skills'];
    const findings: string[] = [];
    for (const dir of dirs) {
      for (const file of await walk(path.join(REPO_ROOT, ...dir.split('/')))) {
        if (!/\.(md|yaml|yml)$/.test(file)) {
          continue;
        }
        const text = await fs.readFile(file, 'utf8');
        if (text.includes('/opsx') || text.includes('opsx:')) {
          findings.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('contains no legacy methodology name in any preset', async () => {
    const findings: string[] = [];
    for (const file of await walk(path.join(REPO_ROOT, 'core', 'presets'))) {
      if (!/\.(md|yaml|yml|json)$/.test(file)) {
        continue;
      }
      const text = await fs.readFile(file, 'utf8');
      if (text.toLowerCase().includes('openspec')) {
        findings.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(findings).toEqual([]);
  });

  it('documents Spec Kit as the only active methodology', async () => {
    for (const file of ['AGENTS.md', 'README.md', 'rules/engine-core.md']) {
      const text = await fs.readFile(path.join(REPO_ROOT, file), 'utf8');
      expect(text).toContain('Spec Kit');
      expect(text).not.toContain('/opsx');
    }
    const verify = await fs.readFile(path.join(REPO_ROOT, 'bootstrap', 'verify.sh'), 'utf8');
    expect(verify).not.toContain('openspec');
  });

  it('ships no legacy methodology skills', async () => {
    const rules = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'core', 'engine', 'coupling.json'), 'utf8'),
    ) as { legacySkillPrefix: string };
    const entries = await fs.readdir(path.join(REPO_ROOT, 'core', 'skills', 'shared'));
    const legacy = entries.filter((entry) => entry.startsWith(rules.legacySkillPrefix));
    expect(legacy).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(17);
  });
});

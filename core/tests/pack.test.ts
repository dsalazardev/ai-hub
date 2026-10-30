import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUBRICS = [
  'skill-rubric.md',
  'skill-behavior-rubric.md',
  'skill-harden-rubric.md',
  'skill-migration-brief.md',
];

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

describe('published package', () => {
  it('contains the four skill-quality rubrics and they match the workshop copy', async () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: CORE_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const data = JSON.parse(raw) as Record<
      string,
      { files: Array<{ path: string }>; entryCount: number }
    >;
    const pkg = data['@dsalazardev/ai-hub-cli'];
    expect(pkg).toBeDefined();
    const paths = pkg.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(RUBRICS.map((file) => `rules/skill-quality/${file}`)),
    );
    expect(pkg.entryCount).toBe(1878);
    expect(paths.filter((file) => file.startsWith('skills/shared/speckit-'))).toEqual([]);

    for (const file of RUBRICS) {
      const packaged = path.join(CORE_ROOT, 'rules', 'skill-quality', file);
      const workshop = path.join(REPO_ROOT, 'rules', 'skill-quality', file);
      await expect(fs.access(packaged)).resolves.toBeUndefined();
      expect(await sha256(packaged)).toBe(await sha256(workshop));
    }
  });
});

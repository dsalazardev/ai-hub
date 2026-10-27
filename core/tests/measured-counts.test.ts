import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { MEASURED } from './measured.js';

/**
 * Conciliación (tarea 6.6): la fórmula de destinos del plan (`buildAssetPlan`, design D6.5)
 * debe dar exactamente las cifras medidas en instalaciones reales.
 */
let root: string;

async function plan(argv: string[]): Promise<{ destinations: number; skillCount: number }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(['init', '--dry-run', ...argv], { cwd: root, io, exec: fakeRunner().run });
  expect(code).toBe(0);
  return JSON.parse(out.join('\n')) as { destinations: number; skillCount: number };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-measured-'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('formula matches the measured installs (6.6)', () => {
  it('full', async () => {
    expect(await plan([])).toMatchObject({ destinations: MEASURED.lock.full, skillCount: MEASURED.projectSkills });
  });
  it('preset-only', async () => {
    expect((await plan(['--preset-only'])).destinations).toBe(MEASURED.lock.presetOnly);
  });
  it('custom without the skill-quality rubrics', async () => {
    expect((await plan(['--exclude', 'rule:skill-quality'])).destinations).toBe(MEASURED.lock.customNoRubrics);
  });
  it('angular-express', async () => {
    expect((await plan(['--preset', 'angular-express'])).destinations).toBe(MEASURED.lock.angularExpress);
  });
});

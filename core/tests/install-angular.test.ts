import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { MEASURED } from './measured.js';

let root: string;

function capture(): { io: CliIO; out: string[] } {
  const out: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => out.push(line) }, out };
}

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const sink = capture();
  const code = await runCli(argv, { cwd: root, io: sink.io, exec: fakeRunner().run });
  return { code, out: sink.out.join('\n') };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-install-angular-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('full angular-express installation', () => {
  // Timeout propio: la instalación full con angular-express midió 70,2 s en el equipo del dueño.
  it('installs 9 rules and the measured destinations without duplicating core (timeout 180 s)', { timeout: 180_000 }, async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { '@angular/core': '^18' } }),
    );
    await fs.writeFile(path.join(root, 'angular.json'), '{}');
    const result = await cli(['init', '--preset', 'angular-express', '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('9 reglas');
    expect(result.out).toContain(`${MEASURED.lock.angularExpress} destinos`);

    await expect(
      fs.access(path.join(root, '.ai-hub', 'skills', 'angular-developer', 'SKILL.md')),
    ).resolves.toBeUndefined();
    for (const rule of ['core', 'frontend', 'backend', 'architecture']) {
      await expect(fs.access(path.join(root, '.ai-hub', 'rules', `${rule}.md`))).resolves.toBeUndefined();
    }
    const materialized = await fs.readdir(path.join(root, '.ai-hub', 'rules'), { recursive: true });
    expect(materialized.filter((entry) => entry === 'core.md')).toHaveLength(1);
    expect(materialized.filter((entry) => entry.endsWith('.md'))).toHaveLength(8);

    const lock = JSON.parse(await fs.readFile(path.join(root, 'sync.lock.json'), 'utf8'));
    expect(Object.keys(lock.files)).toHaveLength(MEASURED.lock.angularExpress);
  });
});

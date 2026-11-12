import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packEntry } from './pack-entry.js';

const PACKAGE = '@dsalazardev/ai-hub-cli';
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

describe('npm pack --json shapes (ci-verde 1.4)', () => {
  const entry = { name: PACKAGE, files: [{ path: 'package.json' }], entryCount: 1 };

  it('reads the npm 10 array output', () => {
    expect(packEntry([entry], PACKAGE)).toEqual(entry);
    expect(packEntry([{ ...entry, name: 'otro' }, entry], PACKAGE)).toEqual(entry);
  });

  it('reads the npm 11+ object output keyed by package name', () => {
    expect(packEntry({ [PACKAGE]: entry }, PACKAGE)).toEqual(entry);
  });

  it('fails naming the package for an empty object, an empty array or an array without it', () => {
    for (const data of [{}, [], [{ ...entry, name: 'otro' }]]) {
      expect(() => packEntry(data, PACKAGE)).toThrow(PACKAGE);
    }
  });

  it('fails naming the package for a single-element array without a name, never undefined', () => {
    const { name: _omitted, ...nameless } = entry;
    expect(() => packEntry([nameless], PACKAGE)).toThrow(PACKAGE);
  });
});

describe('published package', () => {
  it('contains the four skill-quality rubrics and they match the workshop copy', async () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: CORE_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const pkg = packEntry(JSON.parse(raw), PACKAGE);
    expect(pkg).toBeDefined();
    const paths = pkg.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(RUBRICS.map((file) => `rules/skill-quality/${file}`)),
    );
    // factory-evolution Lote D: +14 (6 módulos × .js/.d.ts en dist + 2 plantillas en engine/templates).
    // Lote B: +14 (command-names, references, gate, hook, sync/hooks, catalog/collisions × 2;
    // engine/catalog-baseline.json; engine/templates/opencode-plugin.js).
    // Lote C: +9 (harness/runs, control/tick × 2; schema/runs.schema.json; engine/templates/lessons.md;
    // agents/narrator.md; skills/shared/improve-from-runs/{SKILL.md,evals/cases.yaml}).
    // Lote A: +8 (speckit/status, agents/header, agents/doctor, review/consolidate × 2).
    // Lote E: +10 (engine/scopes, sync/region, adopt/{detect,mcp,convert} × 2).
    // Lote F: +11 (SECURITY.md; engine/templates/{examples-good,examples-bad}.md y devcontainer.json;
    // presets/php/{preset.yaml,rules/php.md,rules/modules.md}; cli/seal y harness/review-seal × 2).
    // scripts/upstream-watch.mjs (M-28) vive en la raíz del taller y no viaja.
    // hermes-control fase 1: +11 (control/{cli,decide,ledger,render,tracker} × 2 en dist;
    // engine/templates/hermes/control-poll.sh). Fase 2: +3 (control/ingest × 2; gitlab-route.sh).
    // Fase 3: +5 (control/{apply,reply} × 2; engine/templates/hermes/SKILL.md).
    // Fase 4: +6 (control/{doctor,enroll,hermes} × 2).
    // control-onboarding: +4 (control/{onboard,onboard-step} × 2).
    // idea-input fase 2: +2 (cli/idea × 2).
    // init-fiabilidad H1: +4 (cli/integrations y control/redact × 2 en dist); medido con npm pack --dry-run --json.
    // init-fiabilidad H2: +5 (control/{identity,profile-env} × 2 en dist + engine/templates/hermes/SOUL.md).
    expect(pkg.entryCount).toBe(1996);
    expect(paths.some((file) => file.includes('upstream-watch'))).toBe(false);
    expect(paths).toContain('SECURITY.md');
    expect(paths).toEqual(expect.arrayContaining(['engine/templates/env.example', 'engine/templates/gitlab-ci.yml']));
    expect(paths.filter((file) => file.startsWith('skills/shared/speckit-'))).toEqual([]);

    for (const file of RUBRICS) {
      const packaged = path.join(CORE_ROOT, 'rules', 'skill-quality', file);
      const workshop = path.join(REPO_ROOT, 'rules', 'skill-quality', file);
      await expect(fs.access(packaged)).resolves.toBeUndefined();
      expect(await sha256(packaged)).toBe(await sha256(workshop));
    }
    expect(paths.some((file) => file.includes('node-pty'))).toBe(false);
  }, 180_000);

  it('never declares node-pty: the Windows terminal probe is opt-in with npm install --no-save (idea-input D9)', async () => {
    const manifest = await fs.readFile(path.join(CORE_ROOT, 'package.json'), 'utf8');
    expect(manifest).not.toContain('node-pty');
  });
});

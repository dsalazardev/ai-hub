import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  findReferences,
  isMaterializableHarnessPath,
  loadCatalogBaseline,
  scanCatalogReferences,
  type ReferenceContext,
} from '../src/engine/references.js';
import { CLI_COMMAND_NAMES } from '../src/cli/command-names.js';
import { COMMAND_NAMES, runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..');

const CONTEXT: ReferenceContext = {
  agents: new Set(['implementer-backend', 'spec-author']),
  commands: new Set(['doctor', 'sync', 'gate']),
  planning: true,
};

async function refs(text: string, existing: string[] = []): Promise<Array<{ kind: string; ref: string }>> {
  const file = path.join(os.tmpdir(), 'skill', 'SKILL.md');
  const found = await findReferences(text, file, CONTEXT, async (absolute) =>
    existing.some((rel) => path.resolve(path.dirname(file), rel) === absolute),
  );
  return found.map(({ kind, ref }) => ({ kind, ref }));
}

describe('reference detectors (3.2)', () => {
  it('harness paths must be materializable', async () => {
    expect(isMaterializableHarnessPath('.ai-hub/.env')).toBe(true);
    expect(isMaterializableHarnessPath('.ai-hub/work/001/review-arch.md')).toBe(true);
    expect(isMaterializableHarnessPath('.ai-hub/work')).toBe(true);
    expect(await refs('Load `.ai-hub/bootstrap/load-env.sh` first.')).toEqual([
      { kind: 'harness-path', ref: '.ai-hub/bootstrap/load-env.sh' },
    ]);
    expect(await refs('Copy `.ai-hub/.env.example` to `.ai-hub/.env`.')).toEqual([]);
  });

  it('npx ai-hub commands must exist', async () => {
    expect(await refs('Run `npx ai-hub sello verify` then `npx ai-hub doctor`.')).toEqual([{ kind: 'command', ref: 'sello' }]);
    expect(await refs('Run `npx --yes @dsalazardev/ai-hub-cli gate`.')).toEqual([]);
  });

  it('dispatched subagents must exist (host types allowed)', async () => {
    expect(await refs('Dispatch with `subagent_type: developer`.')).toEqual([{ kind: 'agent', ref: 'developer' }]);
    expect(await refs('Use subagent_type: implementer-backend or subagent_type: general-purpose.')).toEqual([]);
  });

  it('relative links resolve; placeholders and fenced examples are skipped', async () => {
    expect(await refs('See [x](./missing.md) and [y](./here.md).', ['./here.md'])).toEqual([
      { kind: 'link', ref: './missing.md' },
    ]);
    expect(await refs('A [tpl]({topic}/a.md) and [web](https://example.test/x).')).toEqual([]);
    expect(await refs('```md\n[example](./nowhere.md)\n```\n')).toEqual([]);
  });

  it('.planning/ is flagged only when requested', async () => {
    expect(await refs('Write to .planning/findings.md')).toEqual([{ kind: 'planning', ref: '.planning/' }]);
    const off = await findReferences('Write to .planning/findings.md', '/x/SKILL.md', { ...CONTEXT, planning: false }, async () => true);
    expect(off).toEqual([]);
  });
});

describe('published catalog scan with the dated baseline (3.3)', () => {
  it('has no violations and no expired exceptions today', async () => {
    const scan = await scanCatalogReferences(REPO, 'published');
    expect(scan.violations.map((item) => `${item.file}:${item.line} ${item.kind} ${item.ref}`)).toEqual([]);
    expect(scan.expired).toEqual([]);
  });

  it('every baseline entry still matches a real finding (the list can only shrink)', async () => {
    const baseline = await loadCatalogBaseline();
    const scan = await scanCatalogReferences(REPO, 'published');
    const live = new Set(scan.baselined.map((item) => `${item.key}|${item.kind}|${item.ref}`));
    const dead = baseline.entries.filter((entry) => !live.has(`${entry.key}|${entry.kind}|${entry.ref}`));
    expect(dead).toEqual([]);
  });

  it('G-04 is fixed: no dispatch to a missing developer agent anywhere', async () => {
    const scan = await scanCatalogReferences(REPO, 'published');
    expect([...scan.violations, ...scan.baselined].filter((item) => item.kind === 'agent')).toEqual([]);
  });

  it('exceptions expire: after the date the same scan fails', async () => {
    const scan = await scanCatalogReferences(REPO, 'published', { now: new Date('2027-03-01T00:00:00Z') });
    expect(scan.expired.length).toBeGreaterThan(0);
  });

  it('the command list matches the dispatcher', () => {
    expect([...CLI_COMMAND_NAMES].sort()).toEqual([...COMMAND_NAMES, 'verify', 'judge'].sort());
  });
});

describe('catalog:references in the consumer (3.4)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-refs-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function cli(argv: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
    const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
    return { code, out: out.join('\n') };
  }

  it('pristine copies pass; a project skill with a broken link fails naming file and link', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    expect((await cli(['doctor'])).out).toContain('[OK]   catalog:references');
    const skill = path.join(root, '.ai-hub', 'skills', 'mine');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: mine\ndescription: x\n---\nSee [guide](./guide.md).\n');
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(1);
    expect(doctor.out).toContain('[FAIL] catalog:references: .ai-hub/skills/mine/SKILL.md:5 link ./guide.md');
  });
});

describe('eval lint and reviewer doctrine (3.5, workshop only)', () => {
  interface Cases {
    skill?: string;
    should_trigger?: Array<{ prompt?: string }>;
    should_not_trigger?: Array<{ prompt?: string; route_to?: string }>;
  }

  /** Mínimos de rsc-harness `eval-lint.sh` (MIT): ≥5 positivos, ≥4 negativos, `route_to` real. */
  function lintCases(id: string, cases: Cases, skills: Set<string>): string[] {
    const problems: string[] = [];
    if (cases.skill !== id) {
      problems.push(`${id}: skill declara "${cases.skill}"`);
    }
    if ((cases.should_trigger ?? []).length < 5) {
      problems.push(`${id}: menos de 5 should_trigger`);
    }
    if ((cases.should_not_trigger ?? []).length < 4) {
      problems.push(`${id}: menos de 4 should_not_trigger`);
    }
    for (const item of cases.should_not_trigger ?? []) {
      const target = item.route_to;
      if (target !== undefined && target !== 'none' && !target.startsWith('external:') && !skills.has(target)) {
        problems.push(`${id}: route_to ${target} no existe`);
      }
    }
    return problems;
  }

  const DOCTRINE: Record<string, string[]> = {
    'reviewer-architecture': ['## Scope', '## Workflow', '## Rules', 'PASS', 'NEEDS_FIX', 'BLOCKED'],
    'reviewer-tests': ['## Scope', '## Workflow', '## Rules', 'PASS', 'NEEDS_FIX', 'BLOCKED'],
    'refuter-correctness': ['```json findings', 'failure_scenario', 'consolidation'],
    'refuter-security': ['```json findings', 'failure_scenario', 'consolidation'],
    'refuter-tests': ['```json findings', 'failure_scenario', 'consolidation'],
    'finding-verifier': ['CONFIRMED', 'REFUTED', 'UNPROVEN'],
  };

  function lintDoctrine(id: string, text: string): string[] {
    return (DOCTRINE[id] ?? []).filter((marker) => !text.includes(marker)).map((marker) => `${id}: falta "${marker}"`);
  }

  it('every published cases.yaml meets the minimums and routes to real skills', async () => {
    const dir = path.join(CORE, 'skills', 'shared');
    const skills = new Set(await fs.readdir(dir));
    const problems: string[] = [];
    let linted = 0;
    for (const id of skills) {
      const raw = await fs.readFile(path.join(dir, id, 'evals', 'cases.yaml'), 'utf8').catch(() => null);
      if (raw === null) {
        continue;
      }
      linted += 1;
      problems.push(...lintCases(id, parse(raw) as Cases, skills));
    }
    expect(linted).toBeGreaterThanOrEqual(269);
    expect(problems).toEqual([]);
  });

  it('a mutated eval fails the lint', () => {
    const skills = new Set(['review']);
    const mutated: Cases = { skill: 'review', should_trigger: [{}], should_not_trigger: [{ route_to: 'ghost' }] };
    expect(lintCases('review', mutated, skills)).toEqual([
      'review: menos de 5 should_trigger',
      'review: menos de 4 should_not_trigger',
      'review: route_to ghost no existe',
    ]);
  });

  it('reviewers and refuters keep their doctrine; a mutated reviewer fails', async () => {
    const problems: string[] = [];
    for (const id of Object.keys(DOCTRINE)) {
      problems.push(...lintDoctrine(id, await fs.readFile(path.join(CORE, 'agents', `${id}.md`), 'utf8')));
    }
    expect(problems).toEqual([]);
    const text = await fs.readFile(path.join(CORE, 'agents', 'reviewer-tests.md'), 'utf8');
    expect(lintDoctrine('reviewer-tests', text.replace('NEEDS_FIX', 'NEEDS-FIX'))).toEqual(['reviewer-tests: falta "NEEDS_FIX"']);
  });
});

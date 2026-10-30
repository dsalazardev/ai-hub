import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogIndexFrom, catalogIndex } from '../src/catalog.js';
import { crossValidate, loadEngine, type EngineManifest } from '../src/engine/engine.js';
import { scanReservedNamespace, scanRetiredStates } from '../src/engine/gates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..');

const THIRD_CHAIN = ['specify', 'clarify', 'plan', 'tasks', 'analyze', 'implement', 'sdd', 'sdd-init', 'verify', 'review', 'ship'];

describe('engine commands point to Spec Kit (5.1)', () => {
  it('declares 17 unique canonical ids and the normalized exit table', async () => {
    const engine = await loadEngine();
    const ids = engine.commands.map((command) => command.speckit);
    expect(new Set(ids).size).toBe(17);
    expect(ids.every((id) => /^speckit\.[a-z]+(\.[a-z]+)?$/.test(id))).toBe(true);
    const exits = Object.fromEntries(engine.commands.map((command) => [command.speckit, command.exit]));
    expect(exits['speckit.assess.decide']).toEqual(['GO', 'NEEDS_CLARIFICATION', 'KILL']);
    expect(exits['speckit.bug.assess']).toEqual(['VALID', 'NEEDS_REPRODUCTION', 'INVALID']);
    expect(exits['speckit.bug.fix']).toEqual(['APPLIED', 'PARTIAL', 'NOT_APPLIED']);
    expect(exits['speckit.bug.test']).toEqual(['VERIFIED', 'PARTIAL', 'FAILED']);
    expect(exits['speckit.converge']).toEqual(['CONVERGED', 'NEEDS_WORK']);
    for (const id of ['speckit.assess.intake', 'speckit.plan', 'speckit.constitution', 'speckit.implement']) {
      expect(exits[id], id).toEqual(['DONE', 'BLOCKED']);
    }
    expect(engine.roles).toHaveLength(9);
    expect(engine.labels).toHaveLength(7);
  });

  it('rejects a retired exit state naming the command', async () => {
    const engine = structuredClone(await loadEngine()) as EngineManifest;
    const bugAssess = engine.commands.find((command) => command.id === 'bug-assess');
    if (bugAssess === undefined) {
      throw new Error('bug-assess no existe');
    }
    bugAssess.exit = ['ROOT_CAUSE'];
    expect(crossValidate(engine).join('\n')).toMatch(/bug-assess.*ROOT_CAUSE/);
  });

  it('gives every exit state exactly one label effect', async () => {
    const engine = await loadEngine();
    const states = [...new Set(engine.commands.flatMap((command) => command.exit))].sort();
    expect(Object.keys(engine.exit_effects).sort()).toEqual(states);
  });
});

describe('no consumer reads command.skill (5.2)', () => {
  it('has no command.skill left in core/src', async () => {
    const hits: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.ts') && (await fs.readFile(full, 'utf8')).includes('command.skill')) {
          hits.push(full);
        }
      }
    }
    await walk(path.join(CORE, 'src'));
    expect(hits).toEqual([]);
  });
});

describe('catalog (5.3, 6.1, 6.2)', () => {
  it('ships no speckit-* skill and the reserved namespace gate passes', async () => {
    const shared = await fs.readdir(path.join(CORE, 'skills', 'shared'));
    expect(shared.filter((name) => name.startsWith('speckit'))).toEqual([]);
    expect(await scanReservedNamespace()).toEqual([]);
  });

  it('excludes runtime: false skills from the installable catalog even with profiles core and full', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-catalog-runtime-'));
    try {
      for (const [name, extra] of [['kept', ''], ['legacy-chain', 'runtime: false\n']] as const) {
        await fs.mkdir(path.join(dir, name), { recursive: true });
        await fs.writeFile(
          path.join(dir, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: x\nprofiles: [core, full]\n${extra}---\nbody\n`,
        );
      }
      const index = await buildCatalogIndexFrom(dir);
      expect(index.skills).toEqual(['kept']);
      expect(Object.keys(index.skillFiles)).toEqual(['kept']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the 11 third-chain skills on disk, out of core, with runtime: false', async () => {
    const index = await catalogIndex();
    for (const name of THIRD_CHAIN) {
      const text = await fs.readFile(path.join(CORE, 'skills', 'shared', name, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      expect(frontmatter, name).toMatch(/^runtime: false$/m);
      expect(frontmatter, name).not.toMatch(/profiles:.*\bcore\b/);
      expect(index.skills).not.toContain(name);
    }
    expect(index.skills).toHaveLength(261);
  });
});

describe('retired state vocabulary gate (5.5)', () => {
  it('flags retired states used as exit states, with file and line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-retired-'));
    try {
      const file = path.join(dir, 'doc.md');
      await fs.writeFile(
        file,
        ['# Doc', 'El bug termina en `FIXED`.', 'Estado `ROOT_CAUSE` tras el diagnóstico.', 'status = "OPEN" en DynamoDB'].join('\n'),
      );
      const findings = await scanRetiredStates([file], dir);
      expect(findings).toEqual([
        'doc.md:2 vocabulario obsoleto "FIXED"',
        'doc.md:3 vocabulario obsoleto "ROOT_CAUSE"',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('finds no retired state in the engine, docs and published catalog', async () => {
    expect(await scanRetiredStates(undefined, REPO)).toEqual([]);
  });
});

describe('doctor checks are documented (7.6)', () => {
  it('lists every speckit:* id that doctor can emit in the package README', async () => {
    const { SPECKIT_CHECK_IDS } = await import('../src/speckit/doctor.js');
    const readme = await fs.readFile(path.join(CORE, 'README.md'), 'utf8');
    const documented = [...readme.matchAll(/^\| `(speckit:[a-z]+)` \|/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual([...SPECKIT_CHECK_IDS, 'speckit:targets'].sort());
  });
});

describe('hermes-control contract in AGENTS.md §5 (9.1)', () => {
  it('publishes a seal vector that the reference implementation recomputes', async () => {
    const { featureSeal } = await import('../src/speckit/seal.js');
    const agents = await fs.readFile(path.join(REPO, 'AGENTS.md'), 'utf8');
    const published = /seal-vector: ([a-f0-9]{64})/.exec(agents)?.[1];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-seal-'));
    try {
      await fs.mkdir(path.join(dir, 'specs', '001-demo'), { recursive: true });
      await fs.writeFile(path.join(dir, 'specs', '001-demo', 'spec.md'), '# Demo\n');
      await fs.writeFile(path.join(dir, 'specs', '001-demo', 'plan.md'), '# Plan\n');
      await fs.writeFile(path.join(dir, 'specs', '001-demo', 'tasks.md'), '- [ ] T001 Demo\n');
      expect(await featureSeal(dir, 'specs/001-demo')).toBe(published);
      await fs.cp(path.join(dir, 'specs', '001-demo'), path.join(dir, 'specs', '002-demo'), { recursive: true });
      expect(await featureSeal(dir, 'specs/002-demo')).not.toBe(published);
      await fs.writeFile(path.join(dir, 'specs', '001-demo', 'tasks.md'), '\uFEFF- [ ] T001 Demo\r\n');
      expect(await featureSeal(dir, 'specs/001-demo')).toBe(published);
      await fs.rm(path.join(dir, 'specs', '001-demo', 'plan.md'));
      await expect(featureSeal(dir, 'specs/001-demo')).rejects.toThrow(/specs\/001-demo\/plan\.md/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('publishes exactly one row per exit state, matching engine.yaml', async () => {
    const { exitStates } = await import('../src/speckit/binding.js');
    const engine = await loadEngine();
    const agents = await fs.readFile(path.join(REPO, 'AGENTS.md'), 'utf8');
    const section = agents.slice(agents.indexOf('### Contrato de estados y etiquetas'));
    const rows = [...section.matchAll(/^\| `([A-Z_]+)` \| (.+) \|$/gm)].map((match) => [match[1], match[2]]);
    expect(rows.map(([state]) => state)).toEqual(exitStates(engine));
    for (const [state, effect] of rows) {
      expect(effect, state).toBe(engine.exit_effects[state]);
    }
  });
});

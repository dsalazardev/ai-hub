import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { runCli } from '../src/cli/run.js';
import { loadEngine } from '../src/engine/engine.js';
import { bindingRule } from '../src/speckit/binding.js';
import {
  formatStatusLine,
  lastStatusLine,
  parseStatusLine,
  statusContract,
  StatusLineError,
} from '../src/speckit/status.js';
import { validateAgentHeader } from '../src/agents/header.js';
import { checkAgentCapabilities } from '../src/agents/doctor.js';
import { consolidateFindings, extractFindings } from '../src/review/consolidate.js';
import { readRunEvents, startRun } from '../src/harness/runs.js';
import { TOOL_IDS } from '../src/sync/targets.js';
import { writeInventory } from '../src/manifest/manifest.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { seedFixture } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, '..');

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agents-'));
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

function header(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match ? (parse(match[1]) as Record<string, unknown>) : {};
}

describe('status line contract (5.2)', () => {
  it('round-trips every engine state and both panel verdicts', async () => {
    const engine = await loadEngine();
    const contract = statusContract(engine);
    expect(contract.states).toEqual([...Object.keys(engine.exit_effects), 'REFUTED', 'NOT-REFUTED']);
    expect(contract.states).toHaveLength(17);
    for (const state of contract.states) {
      const status = { state, artifact: 'specs/001-demo/tasks.md', reasonCode: 'probe', reasonText: 'una frase corta' };
      expect(parseStatusLine(formatStatusLine(status, contract), contract)).toEqual(status);
    }
  });

  it('rejects unknown states, missing reasons, long phrases and unsafe artifacts', async () => {
    const contract = statusContract(await loadEngine());
    const bad = [
      'AI-HUB-STATUS: SHIPPED | artifact=- | reason=-',
      'AI-HUB-STATUS: BLOCKED | artifact=- | reason=-',
      `AI-HUB-STATUS: FAILED | artifact=- | reason=x: ${'a'.repeat(201)}`,
      'AI-HUB-STATUS: DONE | artifact=../etc/passwd | reason=-',
      'AI-HUB-STATUS: DONE | artifact=/abs/path | reason=-',
      'STATUS: DONE | artifact=- | reason=-',
    ];
    for (const line of bad) {
      expect(() => parseStatusLine(line, contract), line).toThrow(StatusLineError);
    }
    expect(lastStatusLine('texto\n\nAI-HUB-STATUS: DONE | artifact=- | reason=-\n\n', contract)?.state).toBe('DONE');
    expect(lastStatusLine('AI-HUB-STATUS: DONE | artifact=- | reason=-\nprosa final', contract)).toBeNull();
  });
});

describe('closing contract in the binding rule (5.3)', () => {
  it('every target renders all states, the reason rule, the round limit and the escalation', async () => {
    const engine = await loadEngine();
    const contract = statusContract(engine);
    for (const tool of TOOL_IDS) {
      const rule = bindingRule(engine, tool);
      expect(rule, tool).toContain('## Contrato de cierre');
      expect(rule).toContain(`Estados admitidos: ${contract.states.map((state) => `\`${state}\``).join(', ')}.`);
      expect(rule).toContain(`como máximo ${engine.loop.converge.max_rounds} rondas`);
      expect(rule).toContain('reason=low_confidence');
    }
  });

  it('the state list is generated, not copied by hand into the renderers', async () => {
    for (const file of ['src/speckit/binding.ts', 'src/speckit/status.ts']) {
      expect(await fs.readFile(path.join(CORE, file), 'utf8'), file).not.toContain('NEEDS_REPRODUCTION');
    }
  });
});

describe('runs --from-status uses the contract (5.4)', () => {
  it('stores state, artifact and reason code, never the phrase; an invalid line records only the reason', async () => {
    const run = await startRun(root);
    expect((await cli(['runs', 'event', '--run', run, '--from-status', 'AI-HUB-STATUS: NEEDS_WORK | artifact=specs/001-a/tasks.md | reason=missing_test: falta el test del caso borde'])).code).toBe(0);
    expect((await cli(['runs', 'event', '--run', run, '--from-status', 'AI-HUB-STATUS: BLOCKED | artifact=- | reason=-'])).code).toBe(0);
    const events = await readRunEvents(root, run);
    expect(events[1]).toMatchObject({ kind: 'status', state: 'NEEDS_WORK', artifact: 'specs/001-a/tasks.md', reason_code: 'missing_test' });
    expect(JSON.stringify(events)).not.toContain('caso borde');
    expect(events[2]).toMatchObject({ kind: 'status', reason_code: 'invalid_status' });
    expect(events[2].state).toBeUndefined();
  });
});

describe('bounded converge loop (5.5)', () => {
  it('the project cannot raise max_rounds above the engine', async () => {
    await seedFixture(root);
    await writeInventory(root);
    const manifest = path.join(root, 'manifest.yaml');
    const text = await fs.readFile(manifest, 'utf8');
    await fs.writeFile(manifest, text.replace(/(policy:\n)/, '$1  maxRounds: 5\n'));
    const raised = await cli(['doctor']);
    expect(raised.code).toBe(1);
    expect(raised.out).toContain('policy.maxRounds 5 supera el límite del motor (loop.converge.max_rounds = 3)');
    await fs.writeFile(manifest, text.replace(/(policy:\n)/, '$1  maxRounds: 2\n'));
    expect((await cli(['doctor'])).out).not.toContain('policy.maxRounds');
  });
});

describe('canonical agent headers (5.6)', () => {
  it('a host tool name or an unknown capability fails naming the agent', () => {
    expect(validateAgentHeader({ capabilities: ['Bash'] }, 'agents.publish "x"')).toEqual([
      'agents.publish "x": capability desconocida "Bash" (válidas: read, search, edit, shell, web, delegate)',
    ]);
    expect(validateAgentHeader({ tools: ['Read'] }, 'a')[0]).toContain('"tools" es una clave de destino');
    expect(validateAgentHeader({ capabilities: ['read'], max_turns: 0 }, 'a')).toEqual(['a: max_turns debe ser un entero entre 1 y 500']);
    expect(validateAgentHeader({ capabilities: ['read', 'search'], max_turns: 40, tier: 'heavy' }, 'a')).toEqual([]);
  });

  it('every published agent declares valid capabilities', async () => {
    const dir = path.join(CORE, 'agents');
    const errors: string[] = [];
    for (const file of await fs.readdir(dir)) {
      const data = header(await fs.readFile(path.join(dir, file), 'utf8'));
      expect(Array.isArray(data.capabilities), file).toBe(true);
      errors.push(...validateAgentHeader(data, file));
    }
    expect(errors).toEqual([]);
  });
});

describe('per-target projection (5.7, 5.8)', () => {
  async function seededWithHeaders(models = ''): Promise<void> {
    await seedFixture(root);
    const agents = path.join(root, '.ai-hub', 'agents');
    await fs.writeFile(
      path.join(agents, 'reviewer-tests.md'),
      '---\nname: reviewer-tests\ndescription: fixture reviewer\ncapabilities: [read, search]\n---\n\n# r\n',
    );
    await fs.writeFile(
      path.join(agents, 'implementer-backend.md'),
      '---\nname: implementer-backend\ndescription: fixture implementer\ncapabilities: [read, search, edit, shell]\n---\n\n# i\n',
    );
    await fs.writeFile(
      path.join(agents, 'narrator.md'),
      '---\nname: narrator\ndescription: fixture narrator\ntier: balanced\ncapabilities: [read, search]\nmax_turns: 20\n---\n\n# n\n',
    );
    if (models !== '') {
      await fs.appendFile(path.join(root, 'manifest.yaml'), models);
    }
    await writeInventory(root);
    const result = await cli(['sync']);
    expect(result.code, result.out).toBe(0);
  }

  async function read(rel: string): Promise<Record<string, unknown>> {
    return header(await fs.readFile(path.join(root, ...rel.split('/')), 'utf8'));
  }

  it('Claude gets real tools and maxTurns; OpenCode denies and limits steps', async () => {
    await seededWithHeaders();
    expect(await read('.claude/agents/reviewer-tests.md')).toMatchObject({ name: 'reviewer-tests', tools: ['Read', 'Grep', 'Glob'] });
    expect((await read('.claude/agents/narrator.md')).maxTurns).toBe(20);
    expect((await read('.claude/agents/reviewer-tests.md')).model).toBeUndefined();
    const reviewer = await read('.opencode/agents/reviewer-tests.md');
    expect(reviewer.mode).toBe('subagent');
    const permissions = reviewer.permissions as Array<{ action: string; effect: string }>;
    expect(permissions.every((item) => item.effect === 'deny')).toBe(true);
    expect(permissions.map((item) => item.action)).toEqual(expect.arrayContaining(['edit', 'shell', 'webfetch', 'subagent']));
    expect(permissions.map((item) => item.action)).not.toContain('read');
    expect((await read('.opencode/agents/narrator.md')).steps).toBe(20);
    expect((await read('.opencode/agents/implementer-backend.md')).permissions).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ action: 'edit' })]),
    );
  });

  it('Copilot gets .agent.md with alias tools; Cursor gets readonly in .cursor/agents; Pi gets nothing', async () => {
    await seededWithHeaders();
    expect(await read('.github/agents/reviewer-tests.agent.md')).toMatchObject({ name: 'reviewer-tests', tools: ['read', 'search'] });
    await expect(fs.access(path.join(root, '.github', 'agents', 'reviewer-tests.md'))).rejects.toThrow();
    expect((await read('.github/agents/reviewer-tests.agent.md')).mode).toBeUndefined();
    expect((await read('.cursor/agents/reviewer-tests.md')).readonly).toBe(true);
    expect((await read('.cursor/agents/implementer-backend.md')).readonly).toBeUndefined();
    await expect(fs.access(path.join(root, '.pi', 'agents'))).rejects.toThrow();
    const render = await fs.readFile(path.join(CORE, 'src', 'sync', 'render.ts'), 'utf8');
    expect(render).not.toContain("tool === 'claude'");
  });

  it('agentModels maps a tier to a model per target; unmapped targets inherit', async () => {
    await seededWithHeaders('agentModels:\n  claude:\n    balanced: model-from-project\n');
    expect((await read('.claude/agents/narrator.md')).model).toBe('model-from-project');
    expect((await read('.opencode/agents/narrator.md')).model).toBeUndefined();
  });

  it('an upgrade removes the old .md copies of Copilot and the Pi agents through the lock', async () => {
    await seededWithHeaders();
    const legacy = ['.github/agents/narrator.md', '.pi/agents/narrator.md'];
    const lockFile = path.join(root, 'sync.lock.json');
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { files: Record<string, { sha256: string; source: string }> };
    for (const rel of legacy) {
      const content = '---\nname: narrator\n---\nold\n';
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
      lock.files[rel] = { sha256: createHash('sha256').update(content).digest('hex'), source: '.ai-hub/agents/narrator.md' };
    }
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2));
    expect((await cli(['sync'])).code).toBe(0);
    for (const rel of legacy) {
      await expect(fs.access(path.join(root, rel)), rel).rejects.toThrow();
    }
    expect((await cli(['drift'])).code).toBe(0);
  });
});

describe('agents:capabilities (5.9, 5.12)', () => {
  it('the published catalog passes and lists what each target cannot express', async () => {
    const agents = (await fs.readdir(path.join(CORE, 'agents'))).map((file) => file.replace(/\.md$/, ''));
    const check = await checkAgentCapabilities({ root: null, source: null, agents, targets: [...TOOL_IDS] });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('copilot: no expresa max_turns');
    expect(check.detail).toContain('pi: sin subagentes en el núcleo');
    expect(check.detail).toContain('cursor: también lee .claude/agents');
  });

  it('a refuter declaring edit fails naming it', async () => {
    const dir = path.join(root, '.ai-hub', 'agents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'refuter-x.md'), '---\nname: refuter-x\ndescription: x\nrole: refuter\ncapabilities: [read, edit]\n---\n');
    const check = await checkAgentCapabilities({ root, source: '.ai-hub/agents', agents: ['refuter-x'], targets: ['claude'] });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('refuter-x es de solo lectura y declara edit');
  });
});

describe('review consolidate (5.10)', () => {
  const report = (lens: string, items: unknown[]): string => `# ${lens}\n\n\`\`\`json findings\n${JSON.stringify(items)}\n\`\`\`\n`;

  it('merges ±3 lines, keeps the highest severity and demotes unsupported findings', () => {
    const findings = [
      ...extractFindings(report('correctness', [{ lens: 'correctness', severity: 'should-fix', file: 'src/a.ts', line: 10, claim: 'null', failure_scenario: 'x=null → crash' }])),
      ...extractFindings(report('security', [{ lens: 'security', severity: 'blocker', file: 'src/a.ts', line: 12, claim: 'inyección', failure_scenario: 'input → sql' }])),
      ...extractFindings(report('tests', [{ lens: 'tests', severity: 'blocker', file: 'src/a.ts', line: 30, claim: 'falta test' }])),
    ];
    const merged = consolidateFindings(findings);
    expect(merged[0]).toMatchObject({ lenses: ['correctness', 'security'], severity: 'blocker', file: 'src/a.ts', lines: [10, 12] });
    expect(merged.find((item) => item.lines.includes(30))).toMatchObject({ severity: 'question', demoted: true });
  });

  it('the command writes only to stdout', async () => {
    await fs.writeFile(path.join(root, 'r1.md'), report('correctness', [{ lens: 'correctness', severity: 'nit', file: 'a.ts', line: 1, failure_scenario: 'f' }]));
    const before = (await fs.readdir(root)).sort();
    const result = await cli(['review', 'consolidate', 'r1.md']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ input: 1, demoted: 0 });
    expect((await fs.readdir(root)).sort()).toEqual(before);
    expect((await cli(['review', 'consolidate'])).code).toBe(2);
    expect((await cli(['review', 'consolidate', 'nope.md'])).code).toBe(2);
  });
});

describe('panel in the base preset (5.11)', () => {
  it('every preset installs the four panel agents', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }));
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    for (const id of ['refuter-correctness', 'refuter-security', 'refuter-tests', 'finding-verifier']) {
      await expect(fs.access(path.join(root, '.ai-hub', 'agents', `${id}.md`)), id).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, '.claude', 'agents', `${id}.md`)), id).resolves.toBeUndefined();
    }
  });
});

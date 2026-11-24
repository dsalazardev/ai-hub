import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTick } from '../src/control/tick.js';
import { DELEGATION_REASONS, loadEngine } from '../src/engine/engine.js';
import { readRunEvents } from '../src/harness/runs.js';
import { delegationSection, formatStatusLine, parseStatusLine, statusContract } from '../src/speckit/status.js';
import { verifierModel } from '../src/sync/render.js';
import { fakeGitlab } from './control-fake.js';
import { harness, issue, type Harness } from './control-harness.js';

/** Delegación y contrato de cierre (4.42–4.47, 4.82, 4.84; R-049, R-054, R-055, R-067, R-107, R-109). */

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.dispose();
});

const RUN = '20261123-061800Z-a1b2c3';

describe('política de delegación en engine.yaml (4.42, 4.47, R-054)', () => {
  it('inline por defecto y cuatro razones con umbral', async () => {
    const engine = await loadEngine();
    expect(engine.delegation.default).toBe('inline');
    expect(engine.delegation.reasons.map((reason) => reason.id)).toEqual([...DELEGATION_REASONS]);
    for (const reason of engine.delegation.reasons) {
      expect(reason.threshold.length, reason.id).toBeGreaterThan(10);
    }
  });

  it('los estados de exit_effects no cambian', async () => {
    const engine = await loadEngine();
    expect(Object.keys(engine.exit_effects).sort()).toEqual([
      'DONE', 'BLOCKED', 'GO', 'NEEDS_CLARIFICATION', 'KILL', 'CONVERGED', 'NEEDS_WORK', 'VALID',
      'NEEDS_REPRODUCTION', 'INVALID', 'APPLIED', 'PARTIAL', 'NOT_APPLIED', 'VERIFIED', 'FAILED',
    ].sort());
  });

  it('orchestrator/delegation-rules.md nombra las cuatro razones y el inline por defecto', async () => {
    const text = await fs.readFile(path.resolve(__dirname, '..', '..', 'orchestrator', 'delegation-rules.md'), 'utf8');
    expect(text).toContain('**inline**');
    for (const id of DELEGATION_REASONS) {
      expect(text, id).toContain(`\`${id}\``);
    }
  });
});

describe('parser y formateador del cierre (4.44, 4.46, R-049, R-107)', () => {
  it.each([
    [`AI-HUB-STATUS: DONE | artifact=- | run=${RUN} | reason=-`, { runId: RUN }],
    [`AI-HUB-STATUS: DONE | artifact=- | run=${RUN} | delegated=exploration | reason=-`, { runId: RUN, delegated: 'exploration' }],
    ['AI-HUB-STATUS: DONE | artifact=- | delegated=exploration | reason=-', { delegated: 'exploration' }],
    ['AI-HUB-STATUS: NEEDS_CLARIFICATION | artifact=- | reason=needs_input: elegir A | B', { reasonText: 'elegir A | B' }],
    ['AI-HUB-STATUS: BLOCKED | artifact=- | reason=diversity_unavailable', { state: 'BLOCKED', reasonCode: 'diversity_unavailable' }],
  ])('válida: %s', async (line, expected) => {
    const contract = statusContract(await loadEngine());
    const parsed = parseStatusLine(line, contract);
    expect(parsed).toMatchObject(expected);
    // Viaje parse → format byte a byte.
    expect(formatStatusLine(parsed, contract)).toBe(line);
  });

  it('una línea vigente sin segmentos sigue válida y conserva su forma', async () => {
    const contract = statusContract(await loadEngine());
    expect(parseStatusLine('AI-HUB-STATUS: CONVERGED | artifact=specs/001-a/tasks.md | reason=-', contract)).toEqual({
      state: 'CONVERGED',
      artifact: 'specs/001-a/tasks.md',
      reasonCode: null,
      reasonText: null,
    });
  });

  it.each([
    ['AI-HUB-STATUS: DONE | artifact=- | run=-bad id | reason=-', /segmento run/],
    [`AI-HUB-STATUS: DONE | artifact=- | run=${RUN} | run=${RUN} | reason=-`, /run repetido o fuera de orden/],
    [`AI-HUB-STATUS: DONE | artifact=- | delegated=exploration | run=${RUN} | reason=-`, /fuera de orden/],
    ['AI-HUB-STATUS: DONE | artifact=- | delegated=size | reason=-', /segmento delegated/],
    ['AI-HUB-STATUS: BLOCKED | artifact=- | reason=low_confidence: duda | delegated=exploration', /marcador de segmento/],
    [`AI-HUB-STATUS: DONE | artifact=- | reason=ok: listo | run=${RUN}`, /marcador de segmento/],
    ['AI-HUB-STATUS: DONE | artifact=- | foo=bar | reason=-', /segmento desconocido/],
  ])('rechazada: %s', async (line, error) => {
    const contract = statusContract(await loadEngine());
    expect(() => parseStatusLine(line, contract)).toThrow(error);
  });
});

describe('regla generada en todos los destinos (4.43, 4.82, R-067)', () => {
  it('la regla proyectada contiene la delegación y los segmentos tal como los declara el motor', async () => {
    await h.consumer();
    const engine = await loadEngine();
    const expected = delegationSection(engine);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['.git', 'node_modules', '.ai-hub'].includes(entry.name)) {
          await walk(full);
        } else if (entry.isFile() && /speckit/.test(entry.name) && (await fs.readFile(full, 'utf8')).includes('## Contrato de cierre')) {
          files.push(full);
        }
      }
    };
    await walk(h.root);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      for (const line of expected.filter((item) => item.trim() !== '')) {
        expect(text, `${path.relative(h.root, file)}: ${line}`).toContain(line);
      }
      expect(text).toContain('[| run=<run-id>] [| delegated=<razón>]');
      expect(text).toContain('no puede contener ` | run=` ni ` | delegated=`');
    }
  });
});

describe('modelo del verificador (4.45, R-055)', () => {
  it('elige un modelo distinto del de autoría cuando agentModels lo permite', () => {
    const choice = verifierModel({ balanced: 'modelo-a', heavy: 'modelo-b' }, 'balanced', 'diversity_unavailable');
    expect(choice.model).toBe('modelo-b');
    expect(choice.note).toContain('distinto del modelo de autoría');
  });

  it('con un solo modelo anota la diversidad reducida y el cierre diversity_unavailable', () => {
    for (const models of [{ balanced: 'modelo-a' }, {}]) {
      const choice = verifierModel(models, 'balanced', 'diversity_unavailable');
      expect(choice.note).toContain('Diversidad reducida');
      expect(choice.note).toContain('reason=diversity_unavailable');
    }
  });

  it('el render del verificador lleva la nota en todos los destinos con agentes', async () => {
    await h.consumer();
    const claude = await fs.readFile(path.join(h.root, '.claude', 'agents', 'finding-verifier.md'), 'utf8');
    expect(claude).toContain('Diversidad reducida');
    const implementer = await fs.readFile(path.join(h.root, '.claude', 'agents', 'implementer-backend.md'), 'utf8');
    expect(implementer).not.toContain('Diversidad');
  });
});

describe('runs event --from-status conserva el run id (4.82, R-107)', () => {
  it('run igual: registra estado; run distinto: run_mismatch sin estado; segmento inválido: invalid_status', async () => {
    await h.consumer();
    const started = await h.cli(['runs', 'start']);
    const run = started.out.trim();
    expect(started.code, started.err).toBe(0);
    await h.cli(['runs', 'event', '--run', run, '--from-status', `AI-HUB-STATUS: DONE | artifact=specs/001-a/spec.md | run=${run} | reason=-`]);
    await h.cli(['runs', 'event', '--run', run, '--from-status', `AI-HUB-STATUS: DONE | artifact=specs/001-a/spec.md | run=otro-run-ajeno | reason=-`]);
    await h.cli(['runs', 'event', '--run', run, '--from-status', 'AI-HUB-STATUS: DONE | artifact=- | delegated=size | reason=-']);
    const statuses = (await readRunEvents(h.root, run)).filter((event) => event.kind === 'status');
    expect(statuses[0]).toMatchObject({ run, state: 'DONE', artifact: 'specs/001-a/spec.md' });
    expect(statuses[1]).toMatchObject({ run, reason_code: 'run_mismatch' });
    expect(statuses[1].state).toBeUndefined();
    expect(statuses[1].artifact).toBeUndefined();
    expect(statuses[2]).toMatchObject({ reason_code: 'invalid_status' });
  });
});

describe('el tick elige la nota más reciente con prefijo y después la valida (4.84, R-109)', () => {
  const note = (id: number, body: string) => ({ id, body, authorId: 1 });

  async function tick(notes: Array<{ id: number; body: string; authorId: number }>) {
    await h.consumer();
    await h.feature('001-alpha');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev', { notes })]);
    return runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
  }

  it('la más reciente inválida y una anterior NEEDS_WORK: ninguna propuesta e invalid_status nombrando la nota', async () => {
    const result = await tick([note(10, 'AI-HUB-STATUS: NEEDS_WORK | artifact=- | reason=tests'), note(20, 'AI-HUB-STATUS: SHIPPED | artifact=- | reason=-')]);
    expect(result.proposals.filter((proposal) => proposal.iid === 7)).toEqual([]);
    expect(result.invalidStatus).toEqual([{ iid: 7, ref: 'nota de la issue #7' }]);
  });

  it('válida → inválida → comentario ordinario: se elige la inválida', async () => {
    const result = await tick([
      note(10, 'AI-HUB-STATUS: CONVERGED | artifact=- | reason=-'),
      note(20, 'AI-HUB-STATUS: CONVERGED | artifact=../fuera | reason=-'),
      note(30, 'Gracias, lo reviso mañana.'),
    ]);
    expect(result.invalidStatus).toEqual([{ iid: 7, ref: 'nota de la issue #7' }]);
    expect(result.proposals.filter((proposal) => proposal.iid === 7)).toEqual([]);
  });

  it('una frase con « | delegated=» invalida la nota', async () => {
    const result = await tick([note(10, 'AI-HUB-STATUS: CONVERGED | artifact=- | reason=ok: hecho | delegated=exploration')]);
    expect(result.invalidStatus).toEqual([{ iid: 7, ref: 'nota de la issue #7' }]);
  });

  it('una nota válida más reciente sigue proponiendo', async () => {
    const result = await tick([note(10, 'AI-HUB-STATUS: SHIPPED | artifact=- | reason=-'), note(20, 'AI-HUB-STATUS: CONVERGED | artifact=- | reason=-')]);
    expect(result.invalidStatus).toBeUndefined();
    expect(result.proposals.some((proposal) => proposal.iid === 7)).toBe(true);
  });
});

describe('procedencia de los umbrales de delegación (revisión del supuesto A)', () => {
  it('son los de la issue #7 como referencia observable; ninguno es una medición de contexto inventada', async () => {
    const reasons = Object.fromEntries((await loadEngine()).delegation.reasons.map((reason) => [reason.id, reason.threshold]));
    expect(reasons.exploration).toContain('más de un lote inline');
    expect(reasons.exploration).toContain('5 búsquedas secuenciales');
    expect(reasons.parallel_writers).toContain('superficies de edición disjuntas');
    expect(reasons.context_backup).toContain('el arnés no mide el consumo de contexto');
    expect(reasons.independent_verifier).toContain('alto riesgo');
    expect(reasons.independent_verifier).toContain('ninguna prueba atrapa la regresión');
    expect(Object.values(reasons).join(' ')).not.toMatch(/\d+\s*%/);
  });
});

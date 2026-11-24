import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDecide } from '../src/control/decide.js';
import { readConflicts, readDecisions } from '../src/control/ledger.js';
import { CAPABILITY_DECLARATIONS, CapabilityDeclarationError, trackerCapability, validateDeclarations, type CapabilityDeclaration } from '../src/control/capabilities.js';
import { issueLockPath } from '../src/control/label-policy.js';
import { acquireLock } from '../src/harness/lock.js';
import { fakeGitlab, writes, type FakeGitlab } from './control-fake.js';
import { APPROVER, NOW, harness, issue, type Harness } from './control-harness.js';

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.dispose();
});

async function published(labels: 'withhold' | 'unprotected', expire: 'block' | 'notify' = 'block'): Promise<{ gitlab: FakeGitlab; id: string }> {
  await h.consumer({ labels, expire });
  await h.feature('001-alpha');
  await h.status('001-alpha', 'CONVERGED');
  const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
  const { fresh } = await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
  gitlab.requests.length = 0;
  h.use(gitlab);
  return { gitlab, id: fresh[0].decision.id };
}

describe('capacidades condicionales por producto y versión (3.18, R-017)', () => {
  it('hoy ningún adaptador declara actualización condicional; cada uno con su evidencia', () => {
    for (const product of ['gitlab', 'github'] as const) {
      const result = trackerCapability(product, 'conditional_label_update', '17.5.0');
      expect(result).toMatchObject({ available: false, reason: 'capability_unverified' });
      expect(result.evidence).toMatch(product === 'gitlab' ? /2\.1/ : /2\.2/);
    }
    validateDeclarations(CAPABILITY_DECLARATIONS);
  });

  it('versión fuera de rango o desconocida: no soportada', () => {
    const declared: CapabilityDeclaration[] = [
      { product: 'gitlab', capability: 'conditional_label_update', available: true, versions: { min: '17.0', max: '17.9' }, evidence: 'findings › 2.1 (ejemplo)' },
    ];
    expect(trackerCapability('gitlab', 'conditional_label_update', '18.1', declared)).toMatchObject({ available: false, reason: 'version_unsupported' });
    expect(trackerCapability('gitlab', 'conditional_label_update', null, declared)).toMatchObject({ available: false, reason: 'version_unknown' });
    expect(trackerCapability('gitlab', 'conditional_label_update', '17.5.2', declared)).toMatchObject({ available: true });
    // GitHub no hereda la capacidad de GitLab.
    expect(trackerCapability('github', 'conditional_label_update', '17.5.2', declared).available).toBe(false);
  });

  it('una declaración disponible sin evidencia o sin rango falla', () => {
    expect(() => validateDeclarations([{ product: 'gitlab', capability: 'conditional_label_update', available: true, versions: null, evidence: 'findings › 2.1 (ejemplo)' }])).toThrow(CapabilityDeclarationError);
    expect(() => validateDeclarations([{ product: 'gitlab', capability: 'conditional_label_update', available: true, versions: { min: '1', max: '2' }, evidence: '' }])).toThrow(/evidencia/);
  });
});

describe('retención por defecto sin garantía (4.19, R-004)', () => {
  it('una aprobación no envía ningún PUT, nombra label_update_unprotected y deja la decisión pendiente', async () => {
    const { gitlab, id } = await published('withhold');
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(result.code).toBe(1);
    expect(result.out + result.err).toContain('label_update_unprotected');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('pending');
  });

  it('expire con block registra la caducidad y no mueve la etiqueta', async () => {
    const { gitlab, id } = await published('withhold');
    h.use(gitlab, new Date(NOW.getTime() + 25 * 3600 * 1000));
    const result = await h.cli(['control', 'expire']);
    expect(result.out).toContain('la etiqueta no se mueve');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('expired');
    expect(gitlab.issues.get(7)?.labels).toEqual(['ai::in-dev']);
  });

  it('una instalación actualizada con decisiones pendientes no aplica ninguna y doctor lo dice', async () => {
    const { gitlab, id } = await published('withhold');
    await h.cli(['control', 'apply', '--preapproved']);
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('pending');
    const doctor = await h.cli(['doctor']);
    expect(doctor.out).toMatch(/control:labels.*label_update_unprotected.*retención por defecto/);
  });
});

describe('modo sin garantía atómica remota (4.85, R-111)', () => {
  it('un cambio desde la interfaz web entre la relectura y el PUT no se previene: se escribe y se declara sin garantía', async () => {
    const { gitlab, id } = await published('unprotected');
    const original = gitlab.fetch;
    let issueReads = 0;
    gitlab.fetch = async (url, init) => {
      const response = await original(url, init);
      if ((init.method ?? 'GET') === 'GET' && /\/issues\/7$/.test(new URL(url).pathname)) {
        issueReads += 1;
        if (issueReads === 2) {
          // La persona cambia la etiqueta en la web justo después de la relectura.
          gitlab.issues.get(7)!.labels = ['ai::blocked'];
        }
      }
      return response;
    };
    h.use(gitlab);
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('sin garantía atómica remota');
    expect(writes(gitlab.requests).filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(result.out + (await h.ledgerText())).not.toMatch(/prevenid|protegid/);
    expect(await h.ledgerText()).toContain('label_update_unprotected');
  });

  it('doctor declara que otros hosts no se coordinan', async () => {
    await h.consumer({ labels: 'unprotected' });
    const doctor = await h.cli(['doctor']);
    expect(doctor.out).toMatch(/control:labels.*no la interfaz web, otros hosts ni clientes externos/);
  });
});

describe('lock por identidad de issue (4.86, R-112)', () => {
  it('cambio detectado en la relectura: label_conflict, sin PUT y conflicto tipado', async () => {
    const { gitlab, id } = await published('unprotected');
    const original = gitlab.fetch;
    let issueReads = 0;
    gitlab.fetch = async (url, init) => {
      if ((init.method ?? 'GET') === 'GET' && /\/issues\/7$/.test(new URL(url).pathname)) {
        issueReads += 1;
        if (issueReads === 2) {
          gitlab.issues.get(7)!.labels = ['ai::blocked'];
        }
      }
      return original(url, init);
    };
    h.use(gitlab);
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(result.code).toBe(1);
    expect(result.out + result.err).toContain('label_conflict');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('superseded');
    expect((await readConflicts(h.root)).map((item) => item.reason)).toEqual(['label_conflict']);
  });

  it('dos escritores en dos worktrees sobre la misma issue: un solo PUT', async () => {
    const { gitlab, id } = await published('unprotected');
    const [a, b] = await Promise.all([
      h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]),
      h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]),
    ]);
    expect([a.code, b.code]).toContain(0);
    expect(writes(gitlab.requests).filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('el mismo iid en otro proyecto usa otro lock', () => {
    expect(issueLockPath('https://gitlab.example.test', 'grp/demo', 42)).not.toBe(issueLockPath('https://gitlab.example.test', 'grp/otro', 42));
    expect(issueLockPath('https://gitlab.example.test/', 'grp/demo', 42)).toBe(issueLockPath('https://GITLAB.example.test', 'grp/demo', 42));
  });

  it('espera agotada: label_lock_timeout con el dueño en el diagnóstico y nada escrito', async () => {
    const { gitlab, id } = await published('unprotected');
    const held = await acquireLock(issueLockPath('https://gitlab.example.test', 'grp/demo', 7), 'otro escritor', { pid: process.pid });
    try {
      process.env.AI_HUB_LABEL_LOCK_WAIT_MS = '50';
      const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
      expect(result.code).toBe(1);
      expect(result.out + result.err).toContain('label_lock_timeout');
      expect(result.out + result.err).toContain(`pid ${process.pid}`);
      expect(writes(gitlab.requests)).toEqual([]);
      expect((await readConflicts(h.root)).map((item) => item.reason)).toEqual(['label_lock_timeout']);
    } finally {
      delete process.env.AI_HUB_LABEL_LOCK_WAIT_MS;
      await held.release();
    }
    expect(await fs.readdir(path.join(h.root))).toBeDefined();
  });
});

describe('contrato documental de apply (4.17, R-002)', () => {
  it('no presenta la segunda lectura como garantía (CAS)', async () => {
    const source = await fs.readFile(path.join(__dirname, '..', 'src', 'control', 'apply.ts'), 'utf8');
    expect(source).not.toMatch(/etiqueta actual \(CAS\)/);
    expect(source).toContain('NO es una actualización condicional (no es CAS)');
  });
});

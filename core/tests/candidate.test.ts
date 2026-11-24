import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReviewSealRecord, panelCandidateOf, REVIEW_SEAL_FILE } from '../src/harness/review-seal.js';
import { readRunEvents } from '../src/harness/runs.js';
import {
  CandidateError,
  candidateEntries,
  candidateIntact,
  defaultBase,
  FINDING_VERDICTS,
  freezeCandidate,
  materializeCandidate,
  PANEL_AGENTS,
  PANEL_RECORD_FILE,
  PANEL_VERDICTS,
  panelInputs,
  removeCandidate,
  resolveBase,
  runPanel,
  SEAL_VERDICTS,
} from '../src/review/candidate.js';
import { gitUnavailable } from './git.js';

/** Candidato congelado del panel (4.48–4.55, R-056–R-061) sobre repositorios git temporales. */

const skip = gitUnavailable() !== null;
const EXTERNAL_SENTINEL = 'AIHUB_CANDIDATE_EXTERNAL_SENTINEL_2c9d';
let root: string;
let outside: string;

function git(...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8' });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function hashObject(content: string): string {
  const result = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, windowsHide: true, encoding: 'utf8', input: content });
  return result.stdout.trim();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-candidate-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-candidate-out-'));
  if (skip) {
    return;
  }
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\n.ai-hub/runs/\n');
  await fs.writeFile(path.join(root, 'keep.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'gone.txt'), 'se borra\n');
  await fs.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho hola\n');
  // En POSIX (core.fileMode=true) el bit del índice debe coincidir con el del archivo: si no, el árbol dice 644.
  await fs.chmod(path.join(root, 'run.sh'), 0o755);
  git('add', '-A');
  git('update-index', '--chmod=+x', 'run.sh');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
});
afterEach(async () => {
  for (const dir of [root, outside]) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function workChanges(): Promise<void> {
  await fs.writeFile(path.join(root, 'keep.txt'), 'cambiado\n');
  await fs.rm(path.join(root, 'gone.txt'));
  await fs.writeFile(path.join(root, 'nuevo.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]));
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, 'build', 'ignorado.js'), 'no entra\n');
  await fs.mkdir(path.join(root, '.ai-hub', 'runs', 'r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-hub', 'runs', 'r1', 'events.jsonl'), '{}\n');
}

describe.skipIf(skip)('candidato inmutable (4.48, 4.49, R-056)', () => {
  it('recoge rastreados, sin rastrear, binarios, borrados y bit de ejecución; excluye runs e ignorados; se reconstruye idéntico', async () => {
    await workChanges();
    const first = await freezeCandidate(root, 'main');
    const second = await freezeCandidate(root, 'main');
    expect(second).toEqual(first);
    expect(first.base).toBe(git('rev-parse', 'main'));
    const entries = candidateEntries(root, first);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('nuevo.bin');
    expect(paths).not.toContain('gone.txt');
    expect(paths.some((file) => file.startsWith('build/') || file.startsWith('.ai-hub/runs/'))).toBe(false);
    expect(entries.find((entry) => entry.path === 'run.sh')?.executable).toBe(true);
    const dir = path.join(outside, 'materializado');
    await materializeCandidate(root, first, dir);
    expect((await fs.readFile(path.join(dir, 'nuevo.bin'))).equals(Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]))).toBe(true);
    expect(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8')).toBe('cambiado\n');
    expect(git('rev-parse', `refs/ai-hub/candidates/${first.commit}`)).toBe(first.commit);
    // El índice real no se tocó.
    expect(git('diff', '--cached', '--name-only')).toBe('');
  });

  it('sin base resoluble o sin merge-base, el sellado se rechaza', async () => {
    expect(() => resolveBase(root, 'no-existe')).toThrow(CandidateError);
    git('checkout', '-q', '--orphan', 'huerfana');
    git('commit', '-q', '-m', 'sin historia común', '--allow-empty');
    try {
      defaultBase(root, 'main');
      throw new Error('no debía resolver');
    } catch (error) {
      expect((error as CandidateError).reasonCode).toBe('base_unresolvable');
    }
  });
});

describe.skipIf(skip)('las lentes leen solo bytes del candidato (4.50, R-057)', () => {
  it('un enlace externo se entrega como texto y su destino cambiado no llega a las lentes', async () => {
    const external = path.join(outside, 'secreto.txt').replace(/\\/g, '/');
    await fs.writeFile(external, 'antes\n');
    git('update-index', '--add', '--cacheinfo', `120000,${hashObject(external)},enlace`);
    git('commit', '-q', '-m', 'enlace externo');
    git('checkout', '-q', '--', 'enlace');
    const candidate = await freezeCandidate(root, 'main');
    await fs.writeFile(external, `${EXTERNAL_SENTINEL}\n`);
    const dir = path.join(outside, 'lentes');
    const entries = await materializeCandidate(root, candidate, dir);
    expect(entries.find((entry) => entry.path === 'enlace')).toMatchObject({ kind: 'symlink', value: external });
    await expect(fs.access(path.join(dir, 'enlace'))).rejects.toThrow();
    expect(JSON.stringify(entries)).not.toContain(EXTERNAL_SENTINEL);
    expect(JSON.stringify(panelInputs(candidate, { taskContract: 't', approvedSpec: 's', entryPoint: 'npm test' }))).not.toContain(EXTERNAL_SENTINEL);
  });

  it('un submódulo se entrega como su commit registrado, sin contenido', async () => {
    const commit = git('rev-parse', 'main');
    git('update-index', '--add', '--cacheinfo', `160000,${commit},vendor/sub`);
    git('commit', '-q', '-m', 'submódulo');
    // Un submódulo sin poblar deja su directorio vacío en el worktree.
    await fs.mkdir(path.join(root, 'vendor', 'sub'), { recursive: true });
    const candidate = await freezeCandidate(root, 'main');
    const sub = candidateEntries(root, candidate).find((entry) => entry.path === 'vendor/sub');
    expect(sub).toEqual({ path: 'vendor/sub', kind: 'submodule', executable: false, object: commit, value: commit });
    const dir = path.join(outside, 'sub');
    await materializeCandidate(root, candidate, dir);
    await expect(fs.access(path.join(dir, 'vendor', 'sub'))).rejects.toThrow();
  });
});

describe('registro de revisión v2 (4.51, R-059)', () => {
  it('lee un v1 (sigue valiendo para ship) pero no lo usa como candidato; v2 lleva candidato y tier', async () => {
    const file = path.join(root, ...REVIEW_SEAL_FILE.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ v: 1, base: 'a'.repeat(40), verdict: 'APPROVE', diff: 'd', seal: 's' }));
    const v1 = readReviewSealRecord(root)!;
    expect(v1).toEqual({ v: 1, base: 'a'.repeat(40), verdict: 'APPROVE', diff: 'd', seal: 's' });
    expect(panelCandidateOf(v1)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ v: 2, base: 'a'.repeat(40), verdict: 'APPROVE', diff: 'd', seal: 's', candidate: { tree: 't', commit: 'c' }, tier: 'high' }));
    const v2 = readReviewSealRecord(root)!;
    expect(v2).toMatchObject({ v: 2, candidate: { tree: 't', commit: 'c' }, tier: 'high' });
    expect(panelCandidateOf(v2)).toEqual({ tree: 't', commit: 'c' });
  });
});

describe.skipIf(skip)('panel sobre un candidato (4.52–4.55, R-056, R-058, R-059, R-061)', () => {
  const contract = { taskContract: 'petición y cambios aprobados', approvedSpec: 'specs/001-a/spec.md', entryPoint: 'npm test' };

  it('las cuatro entradas son idénticas, cerradas y sin conversación', async () => {
    const candidate = await freezeCandidate(root, 'main');
    const inputs = panelInputs(candidate, contract);
    expect(Object.keys(inputs)).toEqual([...PANEL_AGENTS]);
    for (const agent of PANEL_AGENTS) {
      expect(Object.keys(inputs[agent]).sort()).toEqual(['approvedSpec', 'entryPoint', 'sourceState', 'taskContract']);
      expect(inputs[agent]).toEqual(inputs['refuter-correctness']);
      expect(inputs[agent].sourceState.commit).toBe(candidate.commit);
    }
  });

  it('modificar el worktree tras la primera lente detiene con CANDIDATE_CHANGED sin veredicto', async () => {
    const candidate = await freezeCandidate(root, 'main');
    let calls = 0;
    const outcome = await runPanel(
      root,
      candidate,
      async () => {
        calls += 1;
        await fs.writeFile(path.join(root, 'keep.txt'), `editado tras la lente ${calls}\n`);
        return { verdict: 'NOT-REFUTED' };
      },
      contract,
      'panel-run',
    );
    expect(outcome).toEqual({ status: 'stopped', diagnostic: 'CANDIDATE_CHANGED' });
    expect(calls).toBe(1);
    await expect(fs.access(path.join(root, ...PANEL_RECORD_FILE.split('/')))).rejects.toThrow();
    expect((await readRunEvents(root, 'panel-run')).at(-1)).toMatchObject({ kind: 'status', reason_code: 'candidate_changed' });
    expect(await candidateIntact(root, candidate)).toBe(false);
  });

  it('veredicto y hallazgos llevan la identidad del candidato; las familias son cerradas y separadas', async () => {
    expect(SEAL_VERDICTS.filter((item) => (PANEL_VERDICTS as readonly string[]).includes(item) || (FINDING_VERDICTS as readonly string[]).includes(item))).toEqual([]);
    const candidate = await freezeCandidate(root, 'main');
    const outcome = await runPanel(root, candidate, async (agent) => (agent === 'finding-verifier' ? { findings: [{ id: 'F1', verdict: 'UNPROVEN' }] } : { verdict: 'NOT-REFUTED' }), contract, 'panel-ok');
    expect(outcome.record).toMatchObject({ candidate: { commit: candidate.commit, tree: candidate.tree }, verdict: 'NOT-REFUTED', findings: [{ id: 'F1', verdict: 'UNPROVEN' }] });
    await expect(runPanel(root, candidate, async () => ({ verdict: 'APPROVE' as never }), contract, 'panel-bad')).rejects.toThrow(/familia/);
  });

  it('eliminar un candidato referenciado por un veredicto se rechaza nombrándolo, salvo forzado', async () => {
    const candidate = await freezeCandidate(root, 'main');
    await runPanel(root, candidate, async () => ({ verdict: 'NOT-REFUTED' }), contract, 'panel-ref');
    await expect(removeCandidate(root, candidate.commit)).rejects.toThrow(/veredicto NOT-REFUTED/);
    await removeCandidate(root, candidate.commit, true);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/ai-hub/candidates/${candidate.commit}`], { cwd: root }).status).not.toBe(0);
  });
});

describe('protocolo de medición de la fase 2 (4.56, R-060)', () => {
  it('el README del taller fija datos, muestra y criterio sin cifras inventadas', async () => {
    const readme = await fs.readFile(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');
    const start = readme.indexOf('### Panel de refutación: medición de la fase 2');
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, readme.indexOf('### Ratchets del taller'));
    for (const text of ['Datos por cambio', 'al menos 10 cambios reales', 'al menos 3 por cada grupo', 'ningún hallazgo `CONFIRMED`', 'siempre `high`', 'Sin cifras inventadas']) {
      expect(section, text).toContain(text);
    }
    // Ninguna cifra de presupuesto: ni porcentajes, ni tiempos, ni importes.
    expect(section).not.toMatch(/\d+\s*(%|ms|s\b|min\b|\$|€|USD|tokens\b)/);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { writeInventory } from '../src/manifest/manifest.js';
import { checkCompatibility, compatWarning } from '../src/harness/compat.js';
import { updateState } from '../src/harness/state-store.js';
import { seedFixture } from './fixtures.js';
import { fakeRunner } from './speckit-fake.js';

/** 3.26 (R-114, R-106): fuente única de la VMC, aviso antes de escribir y `doctor` sin afirmar recuperación. */

const CORE = path.resolve(__dirname, '..');
const REPO = path.resolve(CORE, '..');
const MINIMUM = (parse(readFileSync(path.join(CORE, 'engine', 'engine.yaml'), 'utf8')) as { compatibility: { minimum: string } }).compatibility.minimum;

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-compat-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Huella sincrónica del árbol (ruta, tamaño, mtime): permite comprobar qué había escrito al emitir el aviso. */
function treeFingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') {
          walk(full);
        }
      } else {
        const stat = statSync(full);
        out.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

async function cliWatchingWarning(argv: string[]): Promise<{ code: number; out: string; atWarning: string[] | null }> {
  const lines: string[] = [];
  let atWarning: string[] | null = null;
  const io: CliIO = {
    out: (line) => {
      if (atWarning === null && line.startsWith('aviso: versión mínima compatible')) {
        atWarning = treeFingerprint(root);
      }
      lines.push(line);
    },
    err: (line) => lines.push(line),
  };
  const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
  return { code, out: lines.join('\n'), atWarning };
}

describe('versión mínima compatible (3.26)', () => {
  it('upgrade avisa antes de escribir: el árbol está intacto cuando sale el aviso', async () => {
    await seedFixture(root);
    await writeInventory(root);
    const before = treeFingerprint(root);
    const result = await cliWatchingWarning(['upgrade', '--preset-only']);
    expect(result.out).toContain(compatWarning(MINIMUM));
    expect(result.atWarning).toEqual(before);
    expect(treeFingerprint(root)).not.toEqual(before);
  });

  it('install avisa antes de escribir; --dry-run no avisa porque no escribe', async () => {
    await seedFixture(root);
    await writeInventory(root);
    const dry = await cliWatchingWarning(['install', '--no-speckit', '--dry-run']);
    expect(dry.atWarning).toBeNull();
    const before = treeFingerprint(root);
    const result = await cliWatchingWarning(['install', '--no-speckit']);
    expect(result.atWarning).toEqual(before);
    expect(result.out).toContain(`versión mínima compatible ${MINIMUM}`);
  });

  it('doctor muestra la VMC de engine.yaml y el estado más nuevo encontrado', async () => {
    await seedFixture(root);
    await updateState(root, 'grants', (records) => ({ ...records, g1: { issue: 7 } }));
    const check = await checkCompatibility(root);
    expect(check.detail).toContain(`versión mínima compatible ${MINIMUM}`);
    expect(check.detail).toContain('grants v1');
  });

  it('runs colgantes: doctor los informa sin afirmar que se recuperan', async () => {
    await seedFixture(root);
    await updateState(root, 'execution-index', (records) => ({ ...records, e1: { run: '20260101-000000Z-podado' } }));
    const check = await checkCompatibility(root);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('1 entrada(s) del índice sin su run (20260101-000000Z-podado)');
    expect(check.detail).toContain('no se recupera');
    expect(check.detail).not.toMatch(/se recuperar[áa]|recuperad[oa]s?\b|restaurad/);
  });

  it('notas de versión, documentación y doctor nombran el mismo mínimo que engine.yaml', () => {
    const docs = ['CHANGELOG.md', 'README.md', 'AGENTS.md', 'core/README.md', 'core/SECURITY.md'];
    const named: Array<{ doc: string; version: string }> = [];
    for (const doc of docs) {
      const text = readFileSync(path.join(REPO, doc), 'utf8');
      for (const match of text.matchAll(/(?:versión mínima compatible|VMC)[^0-9\n]{0,40}(\d+\.\d+\.\d+)/gi)) {
        named.push({ doc, version: match[1] });
      }
    }
    // Las notas de versión deben nombrarla al menos una vez, y nadie puede nombrar otra.
    expect(named.some((item) => item.doc === 'CHANGELOG.md')).toBe(true);
    expect(named.filter((item) => item.version !== MINIMUM)).toEqual([]);
    expect(compatWarning(MINIMUM)).toContain(MINIMUM);
  });
});

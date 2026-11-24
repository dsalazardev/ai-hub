import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo ESM del taller sin declaraciones de tipos
import { compareRefusals, extractRefusals, scanRefusals } from '../scripts/ratchet/refusals.mjs';
// @ts-expect-error módulo ESM del taller sin declaraciones de tipos
import { compareDeadcode, INSTALL_HINT, knipBin, runDeadcode, validateExceptions, validateKnipConfig } from '../scripts/ratchet/deadcode.mjs';

/** Ratchets del taller (4.37–4.41, R-062–R-066): rechazos y código muerto solo pueden bajar. */

const CORE = path.resolve(__dirname, '..');
type Refusal = { file: string; emitter: string; template: string };
type Dead = { file: string; type: string; symbol: string };
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(CORE, rel), 'utf8')) as T;
const how = 'si el rechazo es intencionado, justifícalo en la revisión y ejecuta «npm run ratchet:update -- --accept»';

describe('extractor estructural de rechazos (4.37, R-062)', () => {
  const source = `
    export function f(iid: number, ctx: any) {
      if (iid < 0) {
        throw new ControlConfigError(\`#\${iid}: la decisión no existe\`);
      }
      ctx.io.err('aprobador no autorizado: ' + iid);
      ctx.io.out('aplicado #' + iid);
      if (iid === 1) {
        return { code: 1, lines: [\`#\${iid}: primera línea\`, 'segunda línea fija'] };
      }
      return { code: 0, lines: ['todo bien'] };
    }`;
  const found: Refusal[] = extractRefusals(source, 'control/x.ts');

  it('throw con interpolación: plantilla con marcador en vez del valor', () => {
    expect(found).toContainEqual({ file: 'control/x.ts', emitter: 'throw ControlConfigError', template: '#{}: la decisión no existe' });
  });

  it('resultado de fallo con lista: cada línea con el mismo archivo y emisor', () => {
    expect(found.filter((item) => item.emitter === 'return code 1').map((item) => item.template)).toEqual(['#{}: primera línea', 'segunda línea fija']);
  });

  it('concatenación en el flujo de error', () => {
    expect(found).toContainEqual({ file: 'control/x.ts', emitter: 'io.err', template: 'aprobador no autorizado: {}' });
  });

  it('la salida de éxito o informativa se excluye', () => {
    expect(JSON.stringify(found)).not.toContain('aplicado');
    expect(JSON.stringify(found)).not.toContain('todo bien');
  });
});

describe('ratchet de rechazos (4.38, R-063)', () => {
  const baseline = readJson<Refusal[]>('ratchets/refusals.json');

  it('el código actual no añade rechazos fuera de la línea base', () => {
    const { added } = compareRefusals(scanRefusals(path.join(CORE, 'src')), baseline) as { added: Refusal[] };
    expect(added.map((item) => `${item.file} (${item.emitter}): «${item.template}» — ${how}`)).toEqual([]);
  });

  it('una adición falla nombrando archivo y texto; una eliminación pasa', () => {
    const current: Refusal[] = baseline.slice(1);
    const extra = { file: 'control/nuevo.ts', emitter: 'io.err', template: 'rechazo nuevo sin revisar' };
    expect(compareRefusals([...current, extra], baseline).added).toEqual([extra]);
    expect(compareRefusals(current, baseline).added).toEqual([]);
  });
});

describe('ratchet de código muerto con Knip (4.39, R-064)', () => {
  const baseline = readJson<Dead[]>('ratchets/deadcode.json');
  const exceptions = readJson<Array<Record<string, string>>>('ratchets/deadcode-exceptions.json');

  it('el recuento no crece desde las entradas públicas reales', () => {
    const { added } = compareDeadcode(runDeadcode(CORE, { exceptions }), baseline) as { added: Dead[] };
    expect(added.map((item) => `${item.file}: ${item.symbol} (${item.type})`)).toEqual([]);
  }, 120_000);

  it('un export muerto nuevo falla nombrando el símbolo', () => {
    const extra = { file: 'src/control/nuevo.ts', type: 'exports', symbol: 'helperSinUso' };
    expect(compareDeadcode([...baseline, extra], baseline).added).toEqual([extra]);
  });

  it('una excepción sin justificación o de un directorio entero falla', () => {
    expect(validateExceptions([{ file: 'src/a.ts', symbol: 'x', justification: '' }])).toEqual([expect.stringContaining('falta la justificación')]);
    expect(validateExceptions([{ file: 'src/**', symbol: 'x', justification: 'una justificación larga' }])).toEqual([expect.stringContaining('directorios enteros')]);
    expect(validateExceptions(exceptions)).toEqual([]);
    expect(validateKnipConfig(readJson('knip.json'))).toEqual([]);
    expect(validateKnipConfig({ ignore: ['src/legacy/**'] })).toHaveLength(1);
  });
});

describe('actualización explícita y gate sin red (4.40, 4.41, R-065, R-066)', () => {
  it('sin --accept sale 2 y no cambia las líneas base', () => {
    const before = fs.readFileSync(path.join(CORE, 'ratchets', 'refusals.json'), 'utf8');
    const result = spawnSync(process.execPath, [path.join(CORE, 'scripts', 'ratchet', 'update.mjs')], { cwd: CORE, encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--accept');
    expect(fs.readFileSync(path.join(CORE, 'ratchets', 'refusals.json'), 'utf8')).toBe(before);
  });

  it('con el analizador ausente falla con la instrucción de instalación, sin descargar nada', () => {
    expect(() => knipBin(CORE, path.join(CORE, 'node_modules', 'knip-ausente', 'bin.js'))).toThrow(INSTALL_HINT);
    expect(INSTALL_HINT).toContain('npm install --save-dev knip');
  });

  it('el comando y su uso están documentados en el README del taller', () => {
    const readme = fs.readFileSync(path.join(CORE, '..', 'README.md'), 'utf8');
    expect(readme).toContain('npm run ratchet:update -- --accept');
  });
});

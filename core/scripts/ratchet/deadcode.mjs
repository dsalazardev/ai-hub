// Ratchet de código muerto (taller, R-064, R-066): Knip con las entradas públicas reales del paquete
// (`knip.json`: el binario, el generador del manifiesto, los scripts y las pruebas del taller). Sin red: usa el
// Knip ya instalado en `node_modules` y, si falta, falla con la instrucción de instalación. Las excepciones se
// listan una a una con su justificación en `ratchets/deadcode-exceptions.json`; nunca directorios enteros.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_HINT = 'falta el analizador de código muerto: instala la dependencia del taller con «npm install --save-dev knip@5» (el gate no descarga nada)';

export class RatchetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RatchetError';
  }
}

/** Ruta del ejecutable de Knip instalado, o error con la instrucción si no está. */
export function knipBin(root, override) {
  const bin = override ?? path.join(root, 'node_modules', 'knip', 'bin', 'knip.js');
  if (!fs.existsSync(bin)) {
    throw new RatchetError(INSTALL_HINT);
  }
  return bin;
}

/** Excepciones válidas: símbolo y archivo concretos con justificación; sin globs de directorio. */
export function validateExceptions(exceptions) {
  const problems = [];
  for (const [index, item] of exceptions.entries()) {
    const where = `${item?.file ?? '(sin archivo)'}#${item?.symbol ?? '(sin símbolo)'}`;
    if (typeof item?.file !== 'string' || typeof item?.symbol !== 'string' || item.symbol.trim() === '') {
      problems.push(`excepción ${index + 1} (${where}): debe nombrar un archivo y un símbolo`);
    } else if (/[*]|\/$/.test(item.file)) {
      problems.push(`excepción ${index + 1} (${where}): no se excluyen directorios enteros`);
    }
    if (typeof item?.justification !== 'string' || item.justification.trim().length < 10) {
      problems.push(`excepción ${index + 1} (${where}): falta la justificación`);
    }
  }
  return problems;
}

/** La configuración de Knip no puede ignorar directorios enteros. */
export function validateKnipConfig(config) {
  const ignored = [...(config.ignore ?? []), ...(config.ignoreFiles ?? [])];
  return ignored.filter((glob) => /\*\*|\/$/.test(glob)).map((glob) => `knip.json ignora un directorio entero: ${glob}`);
}

const key = (item) => `${item.file}#${item.type}#${item.symbol}`;

/** Elementos sin uso según Knip (exports, tipos, archivos y dependencias), sin las excepciones. */
export function runDeadcode(root, options = {}) {
  const bin = knipBin(root, options.knipBin);
  const result = spawnSync(process.execPath, [bin, '--reporter', 'json', '--no-progress'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) {
    throw new RatchetError(`no se pudo ejecutar Knip: ${result.error.message}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new RatchetError(`Knip no devolvió JSON (exit ${result.status}): ${(result.stderr || '').split('\n')[0]}`);
  }
  const exceptions = options.exceptions ?? [];
  const excepted = new Set(exceptions.map((item) => `${item.file}#${item.symbol}`));
  const items = [];
  for (const file of report.files ?? []) {
    items.push({ file, type: 'file', symbol: '(archivo)' });
  }
  for (const entry of report.issues ?? []) {
    for (const [type, list] of Object.entries(entry)) {
      if (!Array.isArray(list)) {
        continue;
      }
      for (const issue of list) {
        const symbol = issue?.name ?? String(issue);
        if (!excepted.has(`${entry.file}#${symbol}`)) {
          items.push({ file: entry.file, type, symbol });
        }
      }
    }
  }
  return items.sort((a, b) => key(a).localeCompare(key(b)));
}

/** Los nuevos fallan; los retirados pasan (el recuento solo baja). */
export function compareDeadcode(current, baseline) {
  const known = new Set(baseline.map(key));
  const now = new Set(current.map(key));
  return {
    added: current.filter((item) => !known.has(key(item))),
    removed: baseline.filter((item) => !now.has(key(item))),
  };
}

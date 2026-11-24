// Actualización explícita de las líneas base de los ratchets (taller, R-065). Sin `--accept` sale 2 y no
// escribe nada. Uso: `npm run ratchet:update -- --accept` desde `core/`, y revisar el diff en la revisión.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RatchetError, runDeadcode, validateExceptions } from './deadcode.mjs';
import { scanRefusals } from './refusals.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RATCHETS_DIR = path.join(CORE, 'ratchets');
export const REFUSALS_BASELINE = path.join(RATCHETS_DIR, 'refusals.json');
export const DEADCODE_BASELINE = path.join(RATCHETS_DIR, 'deadcode.json');
export const DEADCODE_EXCEPTIONS = path.join(RATCHETS_DIR, 'deadcode-exceptions.json');

export function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function main(argv, root = CORE) {
  if (!argv.includes('--accept')) {
    process.stderr.write('ratchet:update sin --accept: las líneas base solo cambian con aceptación explícita (npm run ratchet:update -- --accept); no se escribió nada\n');
    return 2;
  }
  const exceptions = readJson(DEADCODE_EXCEPTIONS, []);
  const problems = validateExceptions(exceptions);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    return 1;
  }
  let dead;
  try {
    dead = runDeadcode(root, { exceptions });
  } catch (error) {
    if (error instanceof RatchetError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const refusals = scanRefusals(path.join(root, 'src'));
  fs.mkdirSync(RATCHETS_DIR, { recursive: true });
  fs.writeFileSync(REFUSALS_BASELINE, `${JSON.stringify(refusals, null, 2)}\n`);
  fs.writeFileSync(DEADCODE_BASELINE, `${JSON.stringify(dead, null, 2)}\n`);
  process.stdout.write(`líneas base actualizadas: ${refusals.length} rechazos, ${dead.length} elementos sin uso\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

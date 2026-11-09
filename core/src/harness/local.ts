import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ENV_EXAMPLE, HARNESS_ENV_FILE } from '../env/dotenv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Plantillas que viajan en el paquete (`core/engine/templates`). */
export const ENGINE_TEMPLATES_DIR = path.join(__dirname, '..', '..', 'engine', 'templates');

/** Estado de trabajo del consumidor (PD-2): versionado. */
export const HARNESS_WORK_DIR = '.ai-hub/work';
/** Lecciones del proyecto (PD-2): versionado, propiedad del proyecto. */
export const HARNESS_LESSONS_FILE = '.ai-hub/lessons.md';
/** Ejemplos buenos y malos del proyecto (M-23): versionados. */
export const HARNESS_EXAMPLES_DIR = '.ai-hub/examples';
/** Telemetría de ejecuciones (PD-2): ignorada, con retención. */
export const HARNESS_RUNS_DIR = '.ai-hub/runs';

/**
 * Rutas locales del arnés que jamás entran en un snapshot ni en un listado de archivos
 * gestionados: credenciales y telemetría. Un snapshot vive en `.backups/`, que el proyecto
 * puede versionar; copiar ahí `.ai-hub/.env` filtraría el token.
 */
export const HARNESS_PRIVATE_PATHS: readonly string[] = [HARNESS_ENV_FILE, `${HARNESS_RUNS_DIR}/`];

export function isHarnessPrivate(relative: string): boolean {
  const rel = relative.replace(/\\/g, '/');
  return HARNESS_PRIVATE_PATHS.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function readTemplate(name: string): Promise<string> {
  return fs.readFile(path.join(ENGINE_TEMPLATES_DIR, name), 'utf8');
}

async function writeOnce(root: string, relative: string, content: string): Promise<boolean> {
  const destination = path.join(root, relative);
  if (await exists(destination)) {
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, 'utf8');
  return true;
}

/**
 * Archivos locales del arnés que `init` e `install` materializan fuera del recuento del
 * catálogo (la línea de resumen y el plan no cambian): el ejemplo de credenciales, nunca el
 * `.env` real (PD-1). Solo se escribe lo que falta; lo existente queda byte a byte.
 */
export async function materializeHarnessLocal(root: string): Promise<string[]> {
  const written: string[] = [];
  if (await writeOnce(root, HARNESS_ENV_EXAMPLE, await readTemplate('env.example'))) {
    written.push(HARNESS_ENV_EXAMPLE);
  }
  // PD-2 (O2): estado de trabajo del consumidor. work/ y lessons.md se versionan; runs/ se ignora.
  if (await writeOnce(root, `${HARNESS_WORK_DIR}/.gitkeep`, '')) {
    written.push(`${HARNESS_WORK_DIR}/.gitkeep`);
  }
  if (await writeOnce(root, HARNESS_LESSONS_FILE, await readTemplate('lessons.md'))) {
    written.push(HARNESS_LESSONS_FILE);
  }
  await fs.mkdir(path.join(root, ...HARNESS_RUNS_DIR.split('/')), { recursive: true });
  // M-23: ejemplos buenos y malos del proyecto; los revisores los leen antes de juzgar.
  for (const [rel, template] of [
    [`${HARNESS_EXAMPLES_DIR}/good/README.md`, 'examples-good.md'],
    [`${HARNESS_EXAMPLES_DIR}/bad/README.md`, 'examples-bad.md'],
  ] as const) {
    if (await writeOnce(root, rel, await readTemplate(template))) {
      written.push(rel);
    }
  }
  return written;
}

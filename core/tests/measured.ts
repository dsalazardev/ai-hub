import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cifras medidas en instalaciones reales (`fixtures/install-counts.json`); los tests no las calculan a mano. */
export interface MeasuredCounts {
  lock: { full: number; presetOnly: number; customNoRubrics: number; angularExpress: number };
  projectSkills: number;
  angularProjectSkills: number;
  agents: number;
  speckitCommands: number;
}

export const MEASURED = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'install-counts.json'), 'utf8'),
) as MeasuredCounts;

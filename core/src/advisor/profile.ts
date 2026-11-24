import path from 'node:path';
import { readTemplate } from '../harness/local.js';
import { createExclusive } from '../writes/proposals.js';

/**
 * Perfil `hermes-advisor` (R-078, R-080): identidad y skill propias en un perfil distinto de `hermes-control`. Los
 * archivos se crean en exclusiva (D-65): uno existente nunca se sobrescribe y se informa. El perfil de control no se
 * toca. El token del bot y el almacenamiento son del advisor; nunca hay una ruta al `.env` de control.
 */

export const ADVISOR_PROFILE = 'hermes-advisor';
export const ADVISOR_SKILL = 'ai-hub-advisor';

export interface AdvisorProfileResult {
  dir: string;
  created: string[];
  kept: string[];
}

export async function materializeAdvisorProfile(hermesHome: string): Promise<AdvisorProfileResult> {
  const dir = path.join(hermesHome, 'profiles', ADVISOR_PROFILE);
  const files: Array<[string, string]> = [
    [path.join(dir, 'SOUL.md'), await readTemplate('hermes-advisor/SOUL.md')],
    [path.join(dir, 'skills', ADVISOR_SKILL, 'SKILL.md'), await readTemplate('hermes-advisor/SKILL.md')],
  ];
  const result: AdvisorProfileResult = { dir, created: [], kept: [] };
  for (const [file, content] of files) {
    (await createExclusive(file, content) ? result.created : result.kept).push(file);
  }
  return result;
}

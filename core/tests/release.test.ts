import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../src/engine/engine.js';
import { MEASURED } from './measured.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..');

/** Formato de miles del CHANGELOG: 4407 → "4.407". */
function thousands(value: number): string {
  return value.toLocaleString('de-DE');
}

async function currentSection(): Promise<{ version: string; date: string; body: string }> {
  const pkg = JSON.parse(await fs.readFile(path.join(CORE, 'package.json'), 'utf8')) as { version: string };
  const changelog = await fs.readFile(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  const heading = new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} — .*\\((\\d{4}-\\d{2}-\\d{2})\\)$`, 'm').exec(changelog);
  if (heading === null) {
    throw new Error(`CHANGELOG.md no tiene una entrada fechada para ${pkg.version}`);
  }
  const start = heading.index;
  const next = changelog.indexOf('\n## ', start + 1);
  return { version: pkg.version, date: heading[1], body: changelog.slice(start, next < 0 ? undefined : next) };
}

describe('release 0.3.0 (9.3)', () => {
  it('bumps the package and names the three breaking changes', async () => {
    const section = await currentSection();
    expect(section.version).toBe('0.3.0');
    expect(section.body).toMatch(/BREAKING — cuerpos `speckit-\*`/);
    expect(section.body).toMatch(/BREAKING — vocabulario de estados/);
    expect(section.body).toMatch(/BREAKING — Copilot sin Spec Kit/);
    expect(section.body).toContain('runtime: false');
  });

  it('publishes the measured figures, not computed ones', async () => {
    const { body } = await currentSection();
    for (const value of Object.values(MEASURED.lock)) {
      expect(body).toContain(`| ${thousands(value)} |`);
    }
    expect(body).toContain(`${MEASURED.projectSkills} skills de proyecto + ${MEASURED.speckitCommands} comandos Spec Kit`);
  });
});

describe('--exclude-newer is a release decision (1.2)', () => {
  it('is not later than the release date and is justified in the changelog', async () => {
    const engine = await loadEngine();
    const { date, body } = await currentSection();
    expect(engine.speckit.excludeNewer <= date).toBe(true);
    expect(body).toContain(`excludeNewer: ${engine.speckit.excludeNewer}`);
  });
});

describe('workshop README (11.4)', () => {
  it('publishes the measured figures and the uv requirement with its exit 2', async () => {
    const readme = await fs.readFile(path.join(REPO, 'README.md'), 'utf8');
    const rows: Array<[string, number]> = [
      ['`init --yes` (`generic-ts`, full)', MEASURED.lock.full],
      ['`init --yes --preset-only`', MEASURED.lock.presetOnly],
      ['`init --yes --exclude rule:skill-quality`', MEASURED.lock.customNoRubrics],
      ['`init --yes --preset angular-express`', MEASURED.lock.angularExpress],
    ];
    for (const [label, value] of rows) {
      expect(readme, label).toContain(`| ${label} | ${thousands(value)} |`);
    }
    expect(readme).toContain(`${MEASURED.projectSkills} skills de proyecto + ${MEASURED.speckitCommands} comandos Spec Kit`);
    expect(readme).toMatch(/uv\]\(https:\/\/docs\.astral\.sh\/uv/);
    expect(readme).toContain('sale con código 2 antes de escribir nada');
    expect(readme).toContain('Copilot queda excluido de Spec Kit');
  });
});

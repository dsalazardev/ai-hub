import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('release 0.12.0 (hermes-control)', () => {
  it('bumps the package and names the control plane, its specs, the package delta and what stays pending', async () => {
    const section = await currentSection();
    expect(section.version).toBe('0.12.0');
    expect(section.date).toBe('2026-11-09');
    for (const sub of ['decide', 'ingest', 'apply', 'expire', 'enroll']) {
      expect(section.body).toContain('`' + sub + '`');
    }
    expect(section.body).toContain('23 requisitos');
    expect(section.body).toContain('spec-kit-pipeline');
    expect(section.body).toContain('externo y opcional');
    expect(section.body).toContain('1.956 → 1.981 entradas');
    expect(section.body).toContain('Sin cambios en los caminos sin Hermes');
    expect(section.body).toMatch(/Discord[\s\S]*webhook[\s\S]*cron/);
    expect(section.body).not.toMatch(/telegram/i);
  });

  // El ritual iguala versión y fixture: la comprobación de cifras es estricta, sin omisión.
  it('the measured fixture belongs to the released version', () => {
    const version = (JSON.parse(readFileSync(path.join(CORE, 'package.json'), 'utf8')) as { version: string }).version;
    expect(String((MEASURED as unknown as { package?: string }).package ?? '').startsWith(version)).toBe(true);
  });

  it('publishes the measured figures, not computed ones', async () => {
    const { body } = await currentSection();
    for (const value of Object.values(MEASURED.lock)) {
      expect(body).toContain(`| ${thousands(value)} |`);
    }
    expect(body).toContain(`${MEASURED.projectSkills} skills de proyecto + ${MEASURED.speckitCommands} comandos Spec Kit`);
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

  it('documents the chosen script set and the banner (script-choice 7.1)', async () => {
    const readme = await fs.readFile(path.join(REPO, 'README.md'), 'utf8');
    expect(readme).toContain('--scripts');
    expect(readme).toMatch(/conjunto de scripts/i);
    expect(readme).toMatch(/banner de identidad/);
    expect(readme).toMatch(/NO_COLOR/);
  });
});

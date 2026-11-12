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

describe('release 0.15.0 (init-fiabilidad)', () => {
  it('bumps the package and names the root, the status line and the control contract', async () => {
    const section = await currentSection();
    expect(section.version).toBe('0.15.0');
    expect(section.date).toBe('2026-11-12');
    for (const flag of ['--dir', 'AI_HUB_DIR', '--connect-hermes']) {
      expect(section.body).toContain(flag);
    }
    expect(section.body).toContain('ai-hub-integration:');
    expect(section.body).toContain('channelId');
    expect(section.body).toContain('WEBHOOK_ENABLED');
    expect(section.body).toContain('SOUL.md.pre-ai-hub');
    expect(section.body).toContain('%LOCALAPPDATA%');
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

describe('init-fiabilidad 5.1 — security policy lists every written credential (DEV-07)', () => {
  it('names GITLAB_TOKEN in .ai-hub/.env and DISCORD_BOT_TOKEN in the profile .env, never a single credential, with the Windows caveat', async () => {
    const policy = await fs.readFile(path.join(CORE, 'SECURITY.md'), 'utf8');
    expect(policy).not.toMatch(/the only credential the package writes/i);
    const section = policy.slice(policy.indexOf('## Credentials the package writes'));
    expect(section.startsWith('## Credentials the package writes')).toBe(true);
    expect(section).toMatch(/`GITLAB_TOKEN`.*`\.ai-hub\/\.env`/);
    expect(section).toMatch(/`DISCORD_BOT_TOKEN`.*`hermes-control`.*`\.env`/);
    expect(section).toMatch(/ignored by git/i);
    expect(section).toMatch(/never printed/i);
    expect(section).toMatch(/on Windows it does not change\s+the access control list/i);
    expect(section).toMatch(/OneDrive/);
  });
});

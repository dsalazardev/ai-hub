import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * webhook-operativo 3.3 y 4.4: la documentación de secretos y del webhook dice lo que hace el runtime. Vive fuera de
 * `release.test.ts`, que pertenece al ritual de release del propietario.
 */
const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..');

async function section(file: string, heading: string): Promise<string> {
  const text = await fs.readFile(file, 'utf8');
  const start = text.indexOf(heading);
  expect(start, `${file} › ${heading}`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

describe('webhook-operativo 3.3 — route secret rotation never puts a secret on a command line', () => {
  it('SECURITY.md rotates with remove + subscribe without --secret, names both windows and why --secret is unsafe', async () => {
    const rotating = await section(path.join(CORE, 'SECURITY.md'), '## Rotating credentials');
    const row = rotating.split('\n').find((line) => line.startsWith('| Webhook secret')) ?? '';
    expect(row).toContain('hermes webhook remove ai-hub-gitlab');
    expect(row).toMatch(/subscribe[^|]*without `--secret`/);
    expect(row).not.toMatch(/--secret\s+</);
    expect(row).not.toMatch(/Re-subscribe the route in Hermes \(a new secret is generated\)/);
    expect(row).toContain('404');
    expect(row).toContain('401');
    expect(rotating).toMatch(/shell history/i);
    expect(rotating).toMatch(/process list/i);
  });

  it('SECURITY.md and core/README.md document the WEBHOOK_SECRET override over extra.secret', async () => {
    for (const file of [path.join(CORE, 'SECURITY.md'), path.join(CORE, 'README.md')]) {
      const text = await fs.readFile(file, 'utf8');
      expect(text, file).toContain('WEBHOOK_SECRET');
      expect(text, file).toContain('extra.secret');
      expect(text, file).toMatch(/config_env\.py/);
    }
  });
});

describe('webhook-operativo 4.4 — the control docs describe config.yaml, the listener owner and the restart', () => {
  it('core/README.md no longer says enroll writes WEBHOOK_ENABLED/WEBHOOK_PORT and documents the new contract', async () => {
    const readme = await fs.readFile(path.join(CORE, 'README.md'), 'utf8');
    expect(readme).not.toMatch(/añade solo las\s+claves ausentes `WEBHOOK_ENABLED=true`/);
    for (const expected of ['platforms.webhook', '--webhook-owner', '/p/hermes-control/webhooks/ai-hub-gitlab', 'GET /health', 'hermes gateway install', 'sesiones']) {
      expect(readme, expected).toContain(expected);
    }
  });

  it('AGENTS.md §9 says the control step writes the block in the listener owner config.yaml, never WEBHOOK_* in .env', async () => {
    const agents = await fs.readFile(path.join(REPO, 'AGENTS.md'), 'utf8');
    const s9 = agents.slice(agents.indexOf('## 9.'), agents.indexOf('## 10.'));
    expect(s9).not.toContain('las claves de la plataforma webhook que falten (`WEBHOOK_ENABLED`, `WEBHOOK_PORT`');
    expect(s9).toContain('platforms.webhook');
    expect(s9).toContain('--webhook-owner');
    expect(s9).toMatch(/ningún secreto/);
  });

  it('the recovery runbook covers an occupied port, the firewall, a stopped gateway and a pending owner', async () => {
    const readme = await fs.readFile(path.join(CORE, 'README.md'), 'utf8');
    const runbook = readme.slice(readme.indexOf('Recuperación del webhook'));
    expect(runbook.length).toBeGreaterThan(30);
    for (const expected of ['ocupado', 'firewall', 'parado', 'pendiente']) {
      expect(runbook, expected).toContain(expected);
    }
  });
});

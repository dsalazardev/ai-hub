import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { cmdInit } from '../src/cli/onboarding.js';
import { MAX_CAUSE_LINES, REDACTED, redactText, redactedCause } from '../src/control/redact.js';
import {
  APPROVER,
  BOT_TOKEN,
  CHANNEL,
  WEBHOOK_SECRET_SENTINEL,
  WEBHOOK_SETUP_HINT,
  fakeDiscord,
  fakeHermes,
  stepContext,
  type FakeHermes,
} from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** init-fiabilidad 4.3 (HC-03): la salida de Hermes se muestra solo en fallo, redactada y acotada. */

describe('redactText / redactedCause (unidad)', () => {
  it('removes known values, sensitive lines, URL credentials and long opaque strings', () => {
    const lines = redactText(
      [
        'Error: route refused',
        `Secret: ${WEBHOOK_SECRET_SENTINEL}`,
        `token=${BOT_TOKEN}`,
        `profile value ${BOT_TOKEN} leaked inline`,
        'url https://user:pass@example.invalid/hook',
        `opaque ${'a'.repeat(40)}`,
        'Authorization: Bot xyz',
      ].join('\n'),
      [BOT_TOKEN],
    );
    expect(lines).toEqual(['Error: route refused', `profile value ${REDACTED} leaked inline`, `url https://${REDACTED}@example.invalid/hook`, `opaque ${REDACTED}`]);
    expect(lines.join('\n')).not.toContain(WEBHOOK_SECRET_SENTINEL);
  });

  it('keeps the exit code first and at most 20 lines', () => {
    const many = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
    const cause = redactedCause({ status: 1, stdout: many, stderr: '' }, []);
    expect(cause[0]).toBe('exit 1');
    expect(cause).toHaveLength(1 + MAX_CAUSE_LINES);
  });
});

let h: Harness;
let hermes: FakeHermes;

beforeEach(async () => {
  h = await harness();
  await h.consumer({ control: false });
  hermes = await fakeHermes(h.root);
});

afterEach(async () => {
  await h.dispose();
});

const CONNECT = ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin'];

async function connect() {
  const sink = { out: [] as string[], err: [] as string[] };
  const code = await cmdInit(parseArgs(CONNECT), { ...stepContext(h, sink), controlHost: hermes.host, discordFetch: fakeDiscord().fetch, stdin: async () => BOT_TOKEN });
  return { code, text: [...sink.out, ...sink.err].join('\n') };
}

describe('init-fiabilidad 4.3 — salida de Hermes redactada (HC-03)', () => {
  it('Secret: centinela never shown, while the non-secret error lines are kept', async () => {
    hermes.failOn.set('webhook subscribe', { stdout: `  Created ai-hub-gitlab\n  Secret: ${WEBHOOK_SECRET_SENTINEL}`, stderr: 'Error: route refused by Hermes' });
    const result = await connect();
    expect(result.code).toBe(0);
    expect(result.text).not.toContain(WEBHOOK_SECRET_SENTINEL);
    expect(result.text).not.toContain(BOT_TOKEN);
    expect(result.text).toContain('Error: route refused by Hermes');
  }, 60_000);

  it('cause visible: the exit code and the setup hint lines are shown', async () => {
    hermes.failOn.set('webhook subscribe', { stdout: WEBHOOK_SETUP_HINT });
    const result = await connect();
    expect(result.text).toContain('exit 1');
    expect(result.text).toContain('Webhook platform is not enabled');
    expect(result.text).toContain('WEBHOOK_ENABLED=true');
  }, 60_000);

  it('success shows nothing of the subscription output', async () => {
    const result = await connect();
    expect(result.code).toBe(0);
    expect(result.text).not.toContain(WEBHOOK_SECRET_SENTINEL);
    expect(result.text).not.toContain('Created ai-hub-gitlab');
  }, 60_000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { LATER_LINE, offerControlStep } from '../src/control/onboard-step.js';
import { BOT_TOKEN, creating, fakeHermes, noHermesHost, scripted, stepContext, treeHash } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** control-onboarding, fase 1: detección de Hermes, pregunta de entrada y gating (helpers en control-onboarding-fake.ts). */

let h: Harness;

beforeEach(async () => {
  h = await harness();
  await h.consumer({ control: false });
});

afterEach(async () => {
  await h.dispose();
});

describe('fase 1 — detección y pregunta de entrada (1.2, 1.3)', () => {
  it('without Hermes it asks nothing and names control enroll for later', async () => {
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s']);
    const code = await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: noHermesHost(h.root) }), null);
    expect(code).toBe(0);
    expect(script.asked).toEqual([]);
    expect(sink.out).toEqual([LATER_LINE]);
  });

  it('with Hermes 0.23.0 the last question names the version, the own bot and the gateway restart', async () => {
    const hermes = await fakeHermes(h.root);
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['']);
    await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: hermes.host }), null);
    expect(script.asked).toHaveLength(1);
    expect(script.asked[0]).toContain('Hermes v0.23.0 detectado');
    expect(script.asked[0]).toContain('TU bot');
    expect(script.asked[0]).toContain('reinicia el gateway');
    expect(script.asked[0]).toContain('vacío = saltar');
  });

  it('an older Hermes is not offered and the message names both versions', async () => {
    const hermes = await fakeHermes(h.root, '0.22.9');
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s']);
    await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: hermes.host }), null);
    expect(script.asked).toEqual([]);
    expect(sink.out.join('\n')).toContain('0.22.9');
    expect(sink.out.join('\n')).toContain('0.23.0');
  });

  it.each([
    ['empty answer', ['']],
    ['cancel at the entry question', [null]],
  ])('%s: zero writes in the repository and the Hermes home', async (_label, replies) => {
    const hermes = await fakeHermes(h.root);
    await fs.mkdir(hermes.home, { recursive: true });
    const before = [await treeHash(h.root), await treeHash(hermes.home)];
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await offerControlStep(scripted(replies).prompts, stepContext(h, sink, { controlHost: hermes.host }), 'una idea');
    expect(code).toBe(0);
    expect(sink.out.join('\n')).toContain('no se escribió nada');
    expect([await treeHash(h.root), await treeHash(hermes.home)]).toEqual(before);
    expect(creating(hermes.calls)).toEqual([]);
  });
});

describe('fase 1 — sin terminal o con --yes no pregunta (1.4)', () => {
  it('init --yes with a TTY, masked prompts and Hermes installed asks nothing and runs no Hermes command', async () => {
    const hermes = await fakeHermes(h.root);
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s', BOT_TOKEN]);
    const { cmdInit } = await import('../src/cli/onboarding.js');
    const { parseArgs } = await import('../src/cli/args.js');
    const code = await cmdInit(parseArgs(['--preset-only', '--yes']), {
      ...stepContext(h, sink),
      interactive: true,
      assistantPrompts: script.prompts,
      controlHost: hermes.host,
    });
    expect(code).toBe(0);
    expect(script.asked).toEqual([]);
    expect(hermes.calls).toEqual([]);
    expect(sink.out.join('\n')).not.toMatch(/^control:/m);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runEnroll, PROFILE } from '../src/control/enroll.js';
import { diagnose } from '../src/cli/doctor.js';
import { fakeHermes, noHermesHost, stepContext, type FakeHermes } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/**
 * webhook-operativo 4.1 y 4.3: las precondiciones del enrolamiento salen como una etapa con código y causa redactada,
 * nunca como excepción ni «Error inesperado»; `doctor` informa el webhook declarado frente al escuchando.
 */

let h: Harness;
let hermes: FakeHermes;

beforeEach(async () => {
  h = await harness();
  await h.consumer();
  hermes = await fakeHermes(h.root);
});

afterEach(async () => {
  await h.dispose();
});

describe('webhook-operativo 4.1 — preconditions are a stage, never a thrown error', () => {
  it('Hermes missing: runEnroll resolves with stage resolver, exit 2 and the tried paths', async () => {
    const outcome = await runEnroll(h.root, { mode: 'yes', host: noHermesHost(h.root) });
    expect(outcome.code).toBe(2);
    expect(outcome.stage).toBe('resolver');
    expect(outcome.lines.join('\n')).toContain('Hermes no está instalado');
    expect(outcome.lines.join('\n')).not.toContain('Error inesperado');
  });

  it('Hermes too old: runEnroll resolves with stage resolver and exit 1', async () => {
    const old = await fakeHermes(h.root, '0.22.9');
    const outcome = await runEnroll(h.root, { mode: 'yes', host: old.host });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('resolver');
    expect(outcome.lines.join('\n')).toContain('0.22.9');
  });

  it('an exception inside the webhook stage is a webhook-platform failure with its first line, not a throw', async () => {
    hermes.host.probeWebhook = async () => {
      throw new Error('EACCES sonda\nstack');
    };
    const outcome = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    const text = outcome.lines.join('\n');
    expect(text).toContain('EACCES sonda');
    expect(text).not.toContain('stack');
    expect([...hermes.crons]).toEqual(['ai-hub-control-poll']);
  });

  it('control enroll --yes on the CLI never prints the generic error for a known precondition', async () => {
    await fs.mkdir(path.join(hermes.home, 'profiles', PROFILE), { recursive: true });
    await fs.writeFile(path.join(hermes.home, 'profiles', PROFILE, 'config.yaml'), 'k: 1\nk: 2\n');
    const { setControlDeps } = await import('../src/control/cli.js');
    setControlDeps({ hermesHost: hermes.host });
    const result = await h.cli(['control', 'enroll', '--yes']);
    expect(result.code).toBe(1);
    expect(`${result.out}\n${result.err}`).toContain('webhook');
    expect(`${result.out}\n${result.err}`).not.toContain('Error inesperado');
  });
});

describe('webhook-operativo 4.3 — doctor reports the webhook platform of the control plane', () => {
  it('with manifest.control and a declared block that does not answer, doctor fails control:webhook', async () => {
    await fs.mkdir(path.join(hermes.home, 'profiles', PROFILE), { recursive: true });
    await fs.writeFile(path.join(hermes.home, 'profiles', PROFILE, 'config.yaml'), 'platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 8711\n');
    const sink = { out: [] as string[], err: [] as string[] };
    const report = await diagnose({ ...stepContext(h, sink), controlHost: { ...hermes.host, probeWebhook: async () => 'refused' } });
    const row = report.checks.find((check) => check.id === 'control:webhook');
    expect(row, JSON.stringify(report.checks.map((check) => check.id))).toBeDefined();
    expect(row!.ok).toBe(false);
    expect(row!.detail).toContain('8711');
  });

  it('without any block, control:webhook is optional and passes', async () => {
    const sink = { out: [] as string[], err: [] as string[] };
    const report = await diagnose({ ...stepContext(h, sink), controlHost: hermes.host });
    const row = report.checks.find((check) => check.id === 'control:webhook');
    expect(row).toMatchObject({ ok: true });
    expect(row!.detail).toContain('no configurado');
  });
});

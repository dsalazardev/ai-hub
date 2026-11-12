import { describe, it, expect } from 'vitest';
import {
  ENROLL_ACTION,
  RETAKE_ACTION,
  RETAKE_PROVIDE,
  humanNote,
  isolate,
  printReports,
  statusLine,
  type IntegrationReport,
  type IntegrationState,
} from '../src/cli/integrations.js';

/** init-fiabilidad 4.4 (DEV-08, IO-02): línea estable por integración y nota humana para lo no completado. */

const PARSE = /^ai-hub-integration: name=(\S+) state=(\S+) stage=(\S+) action=(.*)$/;

describe('init-fiabilidad 4.4 — línea ai-hub-integration', () => {
  it('snapshot of each state', () => {
    const states: Array<[IntegrationState, string | null, string | null]> = [
      ['no-solicitada', null, null],
      ['completada', null, null],
      ['pendiente', 'gateway', 'hermes gateway restart'],
      ['fallida', 'webhook-route', ENROLL_ACTION],
      ['no-verificable', 'discord', 'ai-hub control enroll --check'],
    ];
    expect(states.map(([state, stage, action]) => statusLine({ name: 'control', state, stage, action }))).toEqual([
      'ai-hub-integration: name=control state=no-solicitada stage=- action=-',
      'ai-hub-integration: name=control state=completada stage=- action=-',
      'ai-hub-integration: name=control state=pendiente stage=gateway action=hermes gateway restart',
      'ai-hub-integration: name=control state=fallida stage=webhook-route action=ai-hub control enroll --yes',
      'ai-hub-integration: name=control state=no-verificable stage=discord action=ai-hub control enroll --check',
    ]);
  });

  it('the line parses with the documented expression, action taking the rest of the line', () => {
    const line = statusLine({ name: 'control', state: 'fallida', stage: 'discord', action: RETAKE_ACTION });
    expect(PARSE.exec(line)?.slice(1)).toEqual(['control', 'fallida', 'discord', RETAKE_ACTION]);
  });

  it('notes go to stderr, status lines close stdout in order, completed and skipped have no note', () => {
    const out: string[] = [];
    const err: string[] = [];
    const reports: IntegrationReport[] = [
      { name: 'tracker', state: 'no-solicitada', stage: null, action: null },
      { name: 'control', state: 'fallida', stage: 'webhook-route', action: ENROLL_ACTION, ready: ['perfil', '.env', 'skill', 'scripts'], missing: ['ruta', 'cron'], cause: ['exit 1', 'Error: route refused'] },
    ];
    printReports({ out: (line) => out.push(line), err: (line) => err.push(line) }, reports);
    expect(out).toEqual([
      'ai-hub-integration: name=tracker state=no-solicitada stage=- action=-',
      'ai-hub-integration: name=control state=fallida stage=webhook-route action=ai-hub control enroll --yes',
    ]);
    expect(err).toEqual([
      'aviso: control: fallida en webhook-route · listo: perfil, .env, skill, scripts · falta: ruta, cron · siguiente: ai-hub control enroll --yes',
      '  exit 1',
      '  Error: route refused',
    ]);
  });

  it('before the connection is saved the note names the data to provide again', () => {
    const note = humanNote({ name: 'control', state: 'fallida', stage: 'profile', action: RETAKE_ACTION, provide: RETAKE_PROVIDE });
    expect(note).toContain('aporta de nuevo: token (entrada estándar o entrada enmascarada), canal, aprobador, TTL, expiración');
    expect(note).toContain('(o ai-hub init en una terminal)');
  });

  it('isolate turns any exception into a failed state with its stage', async () => {
    const report = await isolate('control', () => 'cron', async () => {
      throw new Error('kaboom\nstack');
    });
    expect(report).toEqual({ name: 'control', state: 'fallida', stage: 'cron', action: null, cause: ['kaboom'] });
  });
});

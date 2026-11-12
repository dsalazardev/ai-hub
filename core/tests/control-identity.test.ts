import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSoulIdentity, SOUL_HISTORY, SOUL_VERSION } from '../src/control/identity.js';
import { DEFAULT_SOUL } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** init-fiabilidad 8.4–8.6: plantilla de identidad, tres vías, copias y procedencia. */

let h: Harness;
let profile: string;
let file: string;

beforeEach(async () => {
  h = await harness();
  profile = path.join(h.root, 'profiles', 'hermes-control');
  file = path.join(profile, 'SOUL.md');
  await fs.mkdir(profile, { recursive: true });
});

afterEach(async () => {
  await h.dispose();
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const begin = (version: number, hash: string): string => `<!-- ai-hub:soul:begin v=${version} sha256=${hash} -->`;
const block = (text: string, version = SOUL_VERSION, hash = sha(text)): string => `${begin(version, hash)}\n${text}<!-- ai-hub:soul:end -->`;

async function currentTemplate(): Promise<{ text: string; hash: string }> {
  const text = await fs.readFile(path.resolve(__dirname, '..', 'engine', 'templates', 'hermes', 'SOUL.md'), 'utf8');
  return { text, hash: sha(text) };
}

describe('init-fiabilidad 8.4 — persona gestionada', () => {
  it('persona names the grammar and no commands', async () => {
    const { text, hash } = await currentTemplate();
    expect(SOUL_HISTORY).toContain(hash);
    for (const reply of ['aprobar <iid> <hash>', 'rechazar <iid> <motivo>', 'detalle <iid>']) {
      expect(text).toContain(reply);
    }
    for (const guarantee of ['Nunca apruebas', 'no inventas estados', 'no pides', 'credenciales', 'AI-Hub revalida']) {
      expect(text).toContain(guarantee);
    }
    expect(text).toContain('`ai-hub-control`');
    expect(text).not.toMatch(/^\s*(?:\$|npx|hermes|ai-hub)\s+(?:control|webhook|cron|gateway)\b/m);
  });
});

describe('init-fiabilidad 8.5 — tres vías', () => {
  it('E: missing SOUL.md is created with the managed block', async () => {
    const { text } = await currentTemplate();
    const result = await ensureSoulIdentity(profile, {});
    expect(result.state).toBe('created');
    const written = await fs.readFile(file, 'utf8');
    expect(written).toContain(begin(SOUL_VERSION, sha(text)));
    expect(written).toContain(text);
    expect(written).toContain('<!-- ai-hub:soul:end -->');
  });

  it('C: the current block is byte-identical and reported present', async () => {
    const { text } = await currentTemplate();
    const original = `Antes.\n${block(text)}Después.\n`;
    await fs.writeFile(file, original);
    const result = await ensureSoulIdentity(profile, {});
    expect(result.state).toBe('present');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('A: an intact older block is replaced and the outside stays byte-identical', async () => {
    const old = 'Eres una identidad anterior.\n';
    const original = `Cabecera de la persona.\r\n${block(old, 0, sha(old))}Cola propia.\r\n`;
    await fs.writeFile(file, original);
    const { text, hash } = await currentTemplate();
    const result = await ensureSoulIdentity(profile, { history: [sha(old), hash] });
    expect(result.state).toBe('updated');
    const written = await fs.readFile(file, 'utf8');
    expect(written.startsWith('Cabecera de la persona.\r\n')).toBe(true);
    expect(written.endsWith('Cola propia.\r\n')).toBe(true);
    expect(written).toContain(begin(SOUL_VERSION, hash));
    expect(written).toContain(text);
    expect(written).not.toContain(old);
  });

  it('B: an edited block stays byte-identical and pending', async () => {
    const { text, hash } = await currentTemplate();
    const edited = block(text.replace('Nunca apruebas', 'Sí apruebas'), SOUL_VERSION, hash);
    await fs.writeFile(file, edited);
    const result = await ensureSoulIdentity(profile, {});
    expect(result.state).toBe('pending');
    expect(result.reason).toBe('edited');
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
    expect(result.action).toContain('SOUL.md');
  });

  it('D new profile: an unmarked seeded file is adopted without a question', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    const result = await ensureSoulIdentity(profile, { createdThisRun: true });
    expect(result.state).toBe('created');
    expect(await fs.readFile(path.join(profile, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
    expect(await fs.readFile(file, 'utf8')).toContain(`<!-- ai-hub:soul:begin v=${SOUL_VERSION}`);
  });

  it('D existing profile: adopts only with consent and otherwise stays pending', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    const declined = await ensureSoulIdentity(profile, { adopt: async () => false });
    expect(declined.state).toBe('pending');
    expect(await fs.readFile(file, 'utf8')).toBe(DEFAULT_SOUL);
    const accepted = await ensureSoulIdentity(profile, { adopt: async () => true });
    expect(accepted.state).toBe('created');
    expect(await fs.readFile(path.join(profile, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
  });

  it('D′: an identical backup completes the adoption without asking or duplicating', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    await fs.writeFile(path.join(profile, 'SOUL.md.pre-ai-hub'), DEFAULT_SOUL);
    const result = await ensureSoulIdentity(profile, {});
    expect(result.state).toBe('created');
    expect(await fs.readFile(file, 'utf8')).toContain(`<!-- ai-hub:soul:begin v=${SOUL_VERSION}`);
    expect(await fs.readFile(path.join(profile, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
    expect((await fs.readdir(profile)).filter((name) => name.startsWith('SOUL.md.pre-ai-hub'))).toEqual(['SOUL.md.pre-ai-hub']);
  });
});

describe('init-fiabilidad 8.6 — copias protegidas y reanudación', () => {
  it('retry reuses an identical backup', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    await fs.writeFile(path.join(profile, 'SOUL.md.pre-ai-hub'), DEFAULT_SOUL);
    await ensureSoulIdentity(profile, {});
    expect((await fs.readdir(profile)).filter((name) => name.startsWith('SOUL.md.pre-ai-hub'))).toEqual(['SOUL.md.pre-ai-hub']);
  });

  it('a different earlier backup is preserved and the new copy goes to .1', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    await fs.writeFile(path.join(profile, 'SOUL.md.pre-ai-hub'), 'Otra identidad anterior.\n');
    const result = await ensureSoulIdentity(profile, { adopt: async () => true });
    expect(result.backup).toBe(path.join(profile, 'SOUL.md.pre-ai-hub.1'));
    expect(await fs.readFile(path.join(profile, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe('Otra identidad anterior.\n');
    expect(await fs.readFile(path.join(profile, 'SOUL.md.pre-ai-hub.1'), 'utf8')).toBe(DEFAULT_SOUL);
  });

  it('an interruption after the backup is completed without a question or a second copy', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    await expect(
      ensureSoulIdentity(profile, {
        createdThisRun: true,
        onStage: (stage) => {
          if (stage === 'identity-backup') {
            throw new Error('interrupted after backup');
          }
        },
      }),
    ).rejects.toThrow('interrupted after backup');
    expect(await fs.readFile(file, 'utf8')).toBe(DEFAULT_SOUL);
    expect(await fs.readFile(path.join(profile, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
    const resumed = await ensureSoulIdentity(profile, {});
    expect(resumed.state).toBe('created');
    expect((await fs.readdir(profile)).filter((name) => name.startsWith('SOUL.md.pre-ai-hub'))).toEqual(['SOUL.md.pre-ai-hub']);
  });

  it('an interruption before the backup leaves the seeded file untouched', async () => {
    await fs.writeFile(file, DEFAULT_SOUL);
    await expect(
      ensureSoulIdentity(profile, {
        createdThisRun: true,
        onStage: (stage) => {
          if (stage === 'identity-before-backup') {
            throw new Error('interrupted before backup');
          }
        },
      }),
    ).rejects.toThrow('interrupted before backup');
    expect(await fs.readFile(file, 'utf8')).toBe(DEFAULT_SOUL);
    await expect(fs.access(path.join(profile, 'SOUL.md.pre-ai-hub'))).rejects.toThrow();
  });
});

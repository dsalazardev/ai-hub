import { createHash, randomBytes } from 'node:crypto';
import { externalTarget } from '../writes/targets.js';
import { replaceOwned } from '../writes/replace.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePrivateStorage, type PrivateStorageHost } from '../writes/private-storage.js';

/**
 * Borradores del advisor (R-082, R-083, R-046): se guardan solo en el almacenamiento privado validado (fuera del
 * repositorio, así que nunca entran en snapshots ni en el paquete). Cada uno tiene un token de confirmación ligado
 * al hash del contenido, al autor, al canal y a la caducidad, y se consume una sola vez.
 */

export const DRAFTS_DIR = 'advisor-drafts';
export const DRAFT_TTL_MS = 60 * 60 * 1000;
const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface Draft {
  v: 1;
  id: string;
  contentHash: string;
  author: string;
  channel: string;
  expiresAt: string;
  token: string;
  used: boolean;
}

export class DraftError extends Error {
  constructor(
    readonly reasonCode: 'draft_unknown' | 'draft_author' | 'draft_channel' | 'draft_used' | 'draft_expired' | 'draft_changed' | 'private_storage',
    message: string,
  ) {
    super(message);
    this.name = 'DraftError';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Token de 10 caracteres derivado de contenido, autor, canal, caducidad y un nonce del borrador. */
function tokenFor(id: string, contentHash: string, author: string, channel: string, expiresAt: string): string {
  const digest = createHash('sha256').update(`ai-hub-draft\n${id}\n${contentHash}\n${author}\n${channel}\n${expiresAt}`).digest();
  let token = '';
  for (let index = 0; index < 10; index += 1) {
    token += TOKEN_ALPHABET[digest[index] % 32];
  }
  return token;
}

async function draftsDir(root: string, host?: PrivateStorageHost): Promise<string> {
  const storage = await resolvePrivateStorage(root, host);
  if (!storage.ok) {
    throw new DraftError('private_storage', `sin almacenamiento privado validado no se guardan borradores (${storage.reason}): ${storage.detail}`);
  }
  const dir = path.join(storage.dir, DRAFTS_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function createDraft(root: string, input: { content: string; author: string; channel: string; now?: Date }, host?: PrivateStorageHost): Promise<Draft> {
  const now = input.now ?? new Date();
  const id = randomBytes(8).toString('hex');
  const contentHash = sha256(input.content);
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS).toISOString();
  const draft: Draft = { v: 1, id, contentHash, author: input.author, channel: input.channel, expiresAt, token: tokenFor(id, contentHash, input.author, input.channel, expiresAt), used: false };
  const dir = await draftsDir(root, host);
  // El borrador guarda solo el hash del contenido: el texto vive en el mensaje de Discord, no en disco.
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(draft), { flag: 'wx', mode: 0o600 });
  return draft;
}

/**
 * Confirma un borrador con su token: mismo autor, mismo canal, sin caducar, sin usar y con el mismo contenido.
 * Lo marca usado antes de devolverlo (una sola vez).
 */
export async function confirmDraft(root: string, input: { token: string; author: string; channel: string; content: string; now?: Date }, host?: PrivateStorageHost): Promise<Draft> {
  const dir = await draftsDir(root, host);
  const now = input.now ?? new Date();
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name);
    const raw = await fs.readFile(file, 'utf8');
    const draft = JSON.parse(raw) as Draft;
    if (draft.token !== input.token.trim().toUpperCase()) {
      continue;
    }
    if (draft.used) {
      throw new DraftError('draft_used', 'el token ya se usó; no se crea nada');
    }
    if (draft.author !== input.author) {
      throw new DraftError('draft_author', 'el token es de otro autor; no se crea nada');
    }
    if (draft.channel !== input.channel) {
      throw new DraftError('draft_channel', 'el token es de otro canal; no se crea nada');
    }
    if (Date.parse(draft.expiresAt) <= now.getTime()) {
      throw new DraftError('draft_expired', 'el borrador caducó; pide uno nuevo');
    }
    if (sha256(input.content) !== draft.contentHash) {
      throw new DraftError('draft_changed', 'el contenido no es el del borrador confirmado; no se crea nada');
    }
    const used: Draft = { ...draft, used: true };
    // 3.11: un solo uso también ante dos confirmaciones simultáneas: se reemplaza solo si sigue sin usar.
    await replaceOwned({ root: dir, file, module: 'advisor/drafts.ts', content: JSON.stringify(used), target: externalTarget('advisor-drafts'), expected: raw });
    return used;
  }
  throw new DraftError('draft_unknown', 'ningún borrador tiene ese token; no se crea nada');
}

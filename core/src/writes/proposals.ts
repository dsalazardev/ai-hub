import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from '../harness/state-store.js';

/**
 * Propuestas para configuración ajena existente (D-65, R-113): el motor NO edita ni reemplaza un archivo
 * ajeno que ya existe. Prepara una propuesta que aplica la persona con su editor, ligada a la huella de
 * los bytes que leyó, e informa la capacidad que depende de ella como `pending_application`.
 *
 * Una propuesta guarda solo el fragmento gestionado por el motor y la huella del archivo, nunca sus bytes:
 * no copia contenido sensible del destino. Su identidad es estable (destino, capacidad, huella y
 * fragmento): repetir un paso no la duplica, y un archivo que cambió la deja obsoleta y se sustituye.
 */

export const PROPOSALS_DIR = `${STATE_DIR}/proposals`;
export const PROPOSAL_VERSION = 1;

export interface Proposal {
  v: number;
  id: string;
  /** Capacidad que queda pendiente hasta que la persona aplique el fragmento. */
  capability: string;
  /** Destino tal como se muestra (relativo a la raíz o ruta externa). */
  target: string;
  /** Huella de los bytes leídos (`absent` si no existía). */
  baseFingerprint: string;
  /** Fragmento gestionado que hay que añadir (texto aplicable por la persona). */
  fragment: string;
  /** Instrucción breve para aplicarlo. */
  instructions: string;
  /** Cómo se comprueba que quedó aplicado. */
  check: string;
  createdAt: string;
}

export interface PrepareInput {
  capability: string;
  /** Ruta absoluta del archivo ajeno. */
  file: string;
  display: string;
  fragment: string;
  instructions: string;
  check: string;
  now?: Date;
}

export type PrepareResult = { status: 'existing' | 'new' | 'replaced'; proposal: Proposal; file: string };

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function fileFingerprint(file: string): Promise<string> {
  const bytes = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  return bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
}

export function proposalsDir(root: string): string {
  return path.join(root, ...PROPOSALS_DIR.split('/'));
}

export async function listProposals(root: string): Promise<Proposal[]> {
  const dir = proposalsDir(root);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();
  const out: Proposal[] = [];
  for (const name of names) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Proposal;
      if (typeof data.id === 'string' && typeof data.capability === 'string') {
        out.push(data);
      }
    } catch {
      // Una propuesta ilegible no se ofrece; `doctor` la ve como archivo sobrante.
    }
  }
  return out;
}

function proposalId(input: PrepareInput, fingerprint: string): string {
  return sha256([input.display, input.capability, fingerprint, input.fragment].join('\0')).slice(0, 16);
}

/** Prepara (o reutiliza) la propuesta; nunca toca el archivo ajeno. */
export async function prepareProposal(root: string, input: PrepareInput): Promise<PrepareResult> {
  const fingerprint = await fileFingerprint(input.file);
  const id = proposalId(input, fingerprint);
  const dir = proposalsDir(root);
  const file = path.join(dir, `${id}.json`);
  const previous = (await listProposals(root)).filter((item) => item.capability === input.capability && item.target === input.display);
  if (previous.some((item) => item.id === id)) {
    return { status: 'existing', proposal: previous.find((item) => item.id === id)!, file };
  }
  const proposal: Proposal = {
    v: PROPOSAL_VERSION,
    id,
    capability: input.capability,
    target: input.display,
    baseFingerprint: fingerprint,
    fragment: input.fragment,
    instructions: input.instructions,
    check: input.check,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(file, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  // Una propuesta anterior para el mismo destino quedó obsoleta (el archivo o el fragmento cambiaron).
  for (const stale of previous) {
    await fs.rm(path.join(dir, `${stale.id}.json`), { force: true });
  }
  return { status: previous.length > 0 ? 'replaced' : 'new', proposal, file };
}

/** La persona aplicó el fragmento (lo confirma la comprobación de quien llama): se cierra. */
export async function closeProposals(root: string, capability: string, display: string): Promise<number> {
  const dir = proposalsDir(root);
  let closed = 0;
  for (const item of await listProposals(root)) {
    if (item.capability === capability && item.target === display) {
      await fs.rm(path.join(dir, `${item.id}.json`), { force: true });
      closed += 1;
    }
  }
  return closed;
}

/** Creación exclusiva de un archivo nuevo del motor: nunca sobrescribe (si otro lo crea antes, falla). */
export async function createExclusive(file: string, content: string, mode?: number): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Línea para la persona: qué falta, dónde está la propuesta y cómo se comprueba. */
export function describePending(root: string, proposal: Proposal): string {
  return `pendiente: ${proposal.capability} · ${proposal.target} · propuesta ${path.join(proposalsDir(root), `${proposal.id}.json`)} · ${proposal.instructions} · se comprueba: ${proposal.check}`;
}

/**
 * Check de `doctor` (R-118): mientras haya una propuesta pendiente, la instalación está degradada y la
 * capacidad que depende de ella no se informa como instalada, activa ni sana.
 */
export async function checkPendingProposals(root: string): Promise<{ id: 'pending'; ok: boolean; detail: string }> {
  const pending = await listProposals(root);
  if (pending.length === 0) {
    return { id: 'pending', ok: true, detail: 'sin capacidades pendientes de aplicación' };
  }
  return {
    id: 'pending',
    ok: false,
    detail: `instalación degradada: ${pending.length} pendiente(s) de aplicación por la persona: ${pending.map((item) => `${item.capability} (${item.target})`).join(', ')}; propuestas en ${PROPOSALS_DIR}/`,
  };
}

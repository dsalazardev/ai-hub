import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Archivos que sella `ai::spec-ready`, dentro de `specs/<feature>/`. */
export const SEALED_FILES = ['plan.md', 'spec.md', 'tasks.md'] as const;

export class IncompleteFeatureError extends Error {
  constructor(readonly missing: string[]) {
    super(`la feature no se puede sellar; faltan: ${missing.join(', ')}`);
    this.name = 'IncompleteFeatureError';
  }
}

/** Normaliza el contenido como exige el contrato: sin BOM y con LF. */
function canonicalContent(bytes: Buffer): Buffer {
  const text = bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return Buffer.from(text, 'utf8');
}

/**
 * Sello SHA-256 de una feature de Spec Kit (implementación de referencia del contrato de
 * `hermes-control`, AGENTS.md §5): rutas relativas a la raíz, ordenadas, separador `/`;
 * por archivo `ruta + "\n" + bytes` normalizados a LF y sin BOM; SHA-256 sobre la secuencia.
 */
export async function featureSeal(root: string, featureDir: string): Promise<string> {
  const dir = featureDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const rels = SEALED_FILES.map((name) => `${dir}/${name}`).sort();
  const contents: Array<[string, Buffer]> = [];
  const missing: string[] = [];
  for (const rel of rels) {
    const bytes = await fs.readFile(path.join(root, ...rel.split('/'))).catch(() => null);
    if (bytes === null) {
      missing.push(rel);
    } else {
      contents.push([rel, canonicalContent(bytes)]);
    }
  }
  if (missing.length > 0) {
    throw new IncompleteFeatureError(missing);
  }
  const hash = createHash('sha256');
  for (const [rel, bytes] of contents) {
    hash.update(`${rel}\n`, 'utf8');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

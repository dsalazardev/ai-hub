import { spawnSync } from 'node:child_process';
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
  return sealWith(featureDir, (rel) => fs.readFile(path.join(root, ...rel.split('/'))).catch(() => null));
}

/**
 * Mismo sello que `featureSeal`, leyendo los tres archivos de `ref` del repositorio git (`git show ref:ruta`)
 * en lugar del árbol de trabajo (D3): el plano de control revalida contra la rama del MR sin hacer checkout.
 */
export async function featureSealAtRef(root: string, ref: string, featureDir: string): Promise<string> {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-')) {
    throw new Error(`ref no válida para el sello: ${ref}`);
  }
  return sealWith(featureDir, async (rel) => {
    const result = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 && result.stdout ? Buffer.from(result.stdout) : null;
  });
}

async function sealWith(featureDir: string, read: (rel: string) => Promise<Buffer | null>): Promise<string> {
  const dir = featureDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const rels = SEALED_FILES.map((name) => `${dir}/${name}`).sort();
  const contents: Array<[string, Buffer]> = [];
  const missing: string[] = [];
  for (const rel of rels) {
    const bytes = await read(rel);
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

/** Veredictos que `ai-hub seal review` acepta (los tres cierres de la skill `review`). */
export const REVIEW_VERDICTS = ['APPROVE', 'APPROVE_WITH_NITS', 'CHANGES_REQUESTED'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(value: string): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(value);
}

export function isApproving(verdict: ReviewVerdict): boolean {
  return verdict !== 'CHANGES_REQUESTED';
}

export interface ReviewSeal {
  verdict: ReviewVerdict;
  /** SHA-256 de los bytes del diff revisado. */
  diff: string;
  /** SHA-256 de `review\n<veredicto>\n<diff>`: liga el veredicto a esos bytes y a ningún otro. */
  seal: string;
  /** Archivos de `specs/<feature>/` que el diff toca: invalidan la aprobación humana de la spec. */
  specs: string[];
}

/** Rutas (lado `a/` y `b/`) de las cabeceras `diff --git` de un diff unificado. */
export function diffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    paths.add(match[1]);
    paths.add(match[2]);
  }
  return [...paths].sort();
}

/**
 * Sello de revisión (M-31): liga un veredicto a los bytes exactos del diff revisado. Puro: el
 * diff lo aporta quien llama. El sello de spec de §5 (`featureSeal`) no cambia.
 */
export function reviewSeal(diffBytes: Buffer | string, verdict: ReviewVerdict): ReviewSeal {
  const bytes = typeof diffBytes === 'string' ? Buffer.from(diffBytes, 'utf8') : diffBytes;
  const diff = createHash('sha256').update(bytes).digest('hex');
  const seal = createHash('sha256').update(`review\n${verdict}\n${diff}`, 'utf8').digest('hex');
  const specs = diffPaths(bytes.toString('utf8')).filter((file) => /^specs\/[^/]+\/.+/.test(file));
  return { verdict, diff, seal, specs };
}

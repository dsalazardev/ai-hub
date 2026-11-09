import fs from 'node:fs/promises';
import path from 'node:path';
import { splitFrontmatter } from '../frontmatter.js';

/** Umbral de similitud a partir del cual dos descripciones compiten por el mismo disparo (M-21). */
export const COLLISION_THRESHOLD = 0.8;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'use', 'uses', 'using', 'your', 'you',
  'are', 'not', 'any', 'all', 'its', 'via', 'per', 'del', 'las', 'los', 'para', 'con', 'una', 'que', 'por',
]);

export interface SkillCollision {
  left: string;
  right: string;
  score: number;
}

/** Bolsa de términos normalizados (minúsculas, sin acentos, sin palabras vacías, ≥ 3 letras). */
export function terms(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  for (const word of normalized.split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOP.has(word)) {
      continue;
    }
    bag.set(word, (bag.get(word) ?? 0) + 1);
  }
  return bag;
}

export function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [term, count] of left) {
    leftNorm += count * count;
    dot += count * (right.get(term) ?? 0);
  }
  for (const count of right.values()) {
    rightNorm += count * count;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

/** Pares con similitud ≥ umbral, ordenados de mayor a menor. */
export function findCollisions(
  descriptions: Record<string, string>,
  threshold: number = COLLISION_THRESHOLD,
): SkillCollision[] {
  const ids = Object.keys(descriptions).sort();
  const bags = new Map(ids.map((id) => [id, terms(descriptions[id])]));
  const collisions: SkillCollision[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const score = cosine(bags.get(ids[i]) ?? new Map(), bags.get(ids[j]) ?? new Map());
      if (score >= threshold) {
        collisions.push({ left: ids[i], right: ids[j], score: Math.round(score * 1000) / 1000 });
      }
    }
  }
  return collisions.sort((a, b) => b.score - a.score || (a.left < b.left ? -1 : 1));
}

/** Descripciones de las skills publicadas por el proyecto (`<source>/<id>/SKILL.md`). */
export async function readSkillDescriptions(root: string, source: string, ids: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const id of ids) {
    const file = path.join(root, ...source.split('/'), id, 'SKILL.md');
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) {
      continue;
    }
    try {
      const description = splitFrontmatter(text, file).data.description;
      if (typeof description === 'string') {
        result[id] = description;
      }
    } catch {
      continue;
    }
  }
  return result;
}

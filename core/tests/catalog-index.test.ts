import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { catalogIndex, catalogWalkCount } from '../src/catalog.js';
import { CATALOG_INDEX_FILE } from './catalog-index-file.js';

describe('catalog index', () => {
  it('is built once by globalSetup and shared with every worker', async () => {
    if (process.env.AI_HUB_CATALOG_INDEX_FILE !== CATALOG_INDEX_FILE) {
      throw new Error('barrido repetido: falta AI_HUB_CATALOG_INDEX_FILE para el índice único');
    }
    let raw: string;
    try {
      raw = await fs.readFile(CATALOG_INDEX_FILE, 'utf8');
    } catch {
      throw new Error('barrido repetido: globalSetup no construyó el índice compartido');
    }
    const index = JSON.parse(raw) as {
      skills: string[];
      agents: string[];
      ruleFiles: Record<string, string[]>;
      walkCount: number;
    };
    expect(index.skills).toHaveLength(261);
    expect(index.agents).toHaveLength(39);
    expect(Object.keys(index.ruleFiles)).toHaveLength(4);
    expect(index.walkCount).toBe(1);
    const first = await catalogIndex();
    const second = await catalogIndex();
    expect(second).toBe(first);
    expect(catalogWalkCount()).toBe(1);
  });
});

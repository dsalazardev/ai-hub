import fs from 'node:fs/promises';
import { rebuildCatalogIndex } from '../src/catalog.js';
import { CATALOG_INDEX_FILE } from './catalog-index-file.js';

export { CATALOG_INDEX_FILE };

export default async function globalSetup(): Promise<void> {
  const index = await rebuildCatalogIndex();
  await fs.writeFile(CATALOG_INDEX_FILE, `${JSON.stringify(index)}\n`, 'utf8');
}

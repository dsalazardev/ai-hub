import os from 'node:os';
import path from 'node:path';

/** Archivo compartido entre globalSetup y los workers de Vitest. */
export const CATALOG_INDEX_FILE = path.join(os.tmpdir(), 'ai-hub-catalog-index.json');

import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_NAME } from '../package-info.js';

export interface SourceCheckout {
  isSource: boolean;
  files: string[];
}

export async function sourceCheckout(root: string): Promise<SourceCheckout> {
  const raw = await fs.readFile(path.join(root, 'core', 'package.json'), 'utf8').catch(() => null);
  if (raw === null) {
    return { isSource: false, files: [] };
  }
  try {
    const pkg = JSON.parse(raw) as { name?: unknown; files?: unknown };
    const files = Array.isArray(pkg.files)
      ? pkg.files.filter((file): file is string => typeof file === 'string')
      : [];
    const hasRc = await fs
      .access(path.join(root, '.ai-hubrc.json'))
      .then(
        () => true,
        () => false,
      );
    return { isSource: pkg.name === PACKAGE_NAME && !hasRc, files };
  } catch {
    return { isSource: false, files: [] };
  }
}

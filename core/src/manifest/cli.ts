#!/usr/bin/env node
import { AiHubDirNotFoundError, resolveAiHubDir } from '../paths.js';
import { checkInventory, inventoryPath, writeInventory } from './build.js';
import { ManifestError } from './manifest.js';

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  let root: string;
  try {
    root = resolveAiHubDir().dir;
  } catch (error) {
    if (error instanceof AiHubDirNotFoundError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  try {
    if (check) {
      const result = await checkInventory(root);
      if (!result.ok) {
        process.stderr.write(
          `[FAIL] ${inventoryPath(root)} está desactualizado. Ejecuta npm run manifest:build\n`,
        );
        process.exit(1);
      }
      process.stdout.write('[OK] manifest.json actualizado\n');
      process.exit(0);
    }
    const inventory = await writeInventory(root);
    process.stdout.write(
      `[OK] ${inventoryPath(root)} generado (${inventory.counts.roles} roles, ${inventory.counts.commands} comandos, ${inventory.counts.labels} etiquetas, ${inventory.counts.targets} destinos)\n`,
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof ManifestError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error inesperado: ${message}\n`);
  process.exit(1);
});

import fs from 'node:fs/promises';
import path from 'node:path';

/** Archivo de credenciales locales del arnés, relativo a la raíz del proyecto. */
export const HARNESS_ENV_FILE = '.ai-hub/.env';
/** Ejemplo versionado que `init` materializa; jamás contiene valores reales. */
export const HARNESS_ENV_EXAMPLE = '.ai-hub/.env.example';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parser mínimo de dotenv: `KEY=VALUE` por línea, comentarios `#`, prefijo `export`
 * opcional y comillas simples o dobles alrededor del valor. Sin interpolación ni
 * multilínea: el arnés solo necesita pares planos.
 */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) {
        value = value.slice(0, hash).trimEnd();
      }
    }
    values[key] = value;
  }
  return values;
}

/** Lee `.ai-hub/.env` si existe; `null` cuando no existe. Nunca imprime valores. */
export async function readHarnessEnv(root: string): Promise<Record<string, string> | null> {
  const text = await fs.readFile(path.join(root, HARNESS_ENV_FILE), 'utf8').catch(() => null);
  return text === null ? null : parseDotenv(text);
}

/** Serializa pares a dotenv con comillas dobles cuando el valor lo necesita. */
export function formatDotenv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([key, value]) => (/[\s#"'=]/.test(value) ? `${key}="${value.replace(/"/g, '\\"')}"` : `${key}=${value}`))
      .join('\n') + '\n'
  );
}

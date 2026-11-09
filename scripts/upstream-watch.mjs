#!/usr/bin/env node
/**
 * Vigilancia del upstream (M-28). Herramienta del TALLER: vive fuera de `core/`, no está en
 * `files` de `core/package.json` y nunca viaja en el paquete (la única excepción declarada a la
 * regla del paquete).
 *
 * Solo lee: compara el rango `speckit.supported` de `core/engine/engine.yaml` con la última
 * versión publicada de Spec Kit y lista los dist-tags del paquete en npm. No escribe archivos,
 * no usa credenciales y no envía nada.
 *
 * Uso: node scripts/upstream-watch.mjs [--json]
 * Salida: 0 al día · 1 hay una versión estable fuera del rango soportado · 2 sin red o sin datos.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_KIT_RELEASE = 'https://api.github.com/repos/github/spec-kit/releases/latest';
const NPM_PACKAGE = '@dsalazardev/ai-hub-cli';

function supportedRange() {
  const engine = readFileSync(path.join(ROOT, 'core', 'engine', 'engine.yaml'), 'utf8');
  const match = /^speckit:[\s\S]*?^\s+supported:\s*'([^']+)'/m.exec(engine);
  if (!match) {
    throw new Error('core/engine/engine.yaml no declara speckit.supported');
  }
  return match[1];
}

function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Rango de la forma `>=X.Y.Z <A.B.C`, el único que declara el motor. */
function inRange(version, range) {
  const v = parse(version);
  const bounds = /^>=(\S+)\s+<(\S+)$/.exec(range.trim());
  if (!v || !bounds) return null;
  const low = parse(bounds[1]);
  const high = parse(bounds[2]);
  if (!low || !high) return null;
  return compare(v, low) >= 0 && compare(v, high) < 0;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ai-hub-upstream-watch' } });
  if (!response.ok) {
    throw new Error(`${url} → HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  const json = process.argv.includes('--json');
  const range = supportedRange();
  let latest;
  let distTags;
  try {
    latest = String((await getJson(SPEC_KIT_RELEASE)).tag_name ?? '');
    distTags = await getJson(`https://registry.npmjs.org/-/package/${NPM_PACKAGE.replace('/', '%2f')}/dist-tags`);
  } catch (error) {
    console.error(`upstream-watch: sin datos (${error.message})`);
    return 2;
  }
  const covered = inRange(latest, range);
  const report = { speckit: { supported: range, latest, covered }, npm: { package: NPM_PACKAGE, distTags } };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Spec Kit: última ${latest} · rango soportado ${range} · ${covered ? 'cubierta' : 'FUERA DEL RANGO'}`);
    console.log(`npm ${NPM_PACKAGE}: ${Object.entries(distTags).map(([tag, version]) => `${tag}=${version}`).join(' · ')}`);
  }
  return covered === false ? 1 : covered === null ? 2 : 0;
}

process.exitCode = await main();

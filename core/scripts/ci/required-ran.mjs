// Comprueba en un informe JUnit de vitest que las pruebas exigidas corrieron (no omitidas, no ausentes).
// Uso: node scripts/ci/required-ran.mjs <informe.xml> "<nombre 1>" "<nombre 2>" ...
import { readFileSync } from 'node:fs';

const [report, ...required] = process.argv.slice(2);
const xml = readFileSync(report, 'utf8');
const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map((match) => ({
  name: /\bname="([^"]*)"/.exec(match[1])?.[1] ?? '',
  skipped: /<skipped/.test(match[3] ?? ''),
}));
let missing = false;
for (const name of required) {
  const found = cases.find((item) => item.name.includes(name));
  const ran = found !== undefined && !found.skipped;
  console.log(`${ran ? 'RAN    ' : 'NOT RUN'} ${name}`);
  missing ||= !ran;
}
process.exit(missing ? 1 : 0);

// idea-input D9 (niveles 2 y 3): driver del lector de la idea para las sondas de terminal real. Usa el código
// compilado (`dist/`): lee la idea con `readIdeaFromTerminal` sobre la TTY real, escribe la semilla con
// `writeBacklogSeed` en un root temporal y abre después el confirm del plan de clack, para comprobar que ningún
// byte del pegado lo contesta. No ejecuta `init` completo: el apply instala Spec Kit con uvx (minutos y red).
//
// Uso: node idea-pty-driver.mjs <core-dir> <root-temporal>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [coreDir, root] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(path.join(coreDir, relative)).href);
const { readIdeaFromTerminal, DEFAULT_MAX_IDEA } = await load('dist/cli/idea.js');
const { writeBacklogSeed } = await load('dist/cli/assistant.js');
const p = await load('node_modules/@clack/prompts/dist/index.mjs');

// AIHUB_PROBE_MUTE=1: el lector no escribe nada en la terminal (mide el transporte sin el render).
const mute = process.env.AIHUB_PROBE_MUTE === '1';
const output = mute ? { columns: process.stdout.columns ?? 80, write: () => true } : process.stdout;
process.stdout.write('\nREADY\n');
const outcome = await readIdeaFromTerminal(process.stdin, output, {
  message: 'idea (sonda PTY)',
  maxBytes: DEFAULT_MAX_IDEA,
});
if (outcome === null) {
  process.stdout.write('\nRESULT:cancel\n');
  process.exit(0);
}
if (outcome.kind === 'skip') {
  process.stdout.write('\nRESULT:skip\n');
} else {
  const io = { out: () => undefined, err: () => undefined };
  await writeBacklogSeed({ cwd: root, root, source: null, io }, outcome.text, outcome.note);
  process.stdout.write(`\nRESULT:idea:${Buffer.byteLength(outcome.text)}\n`);
}
const answer = await Promise.race([
  p.confirm({ message: '¿Aplicamos este plan?' }),
  new Promise((resolve) => setTimeout(() => resolve('none'), 1500)),
]);
process.stdout.write(`\nCONFIRM:${typeof answer === 'symbol' ? 'cancel' : String(answer)}\n`);
process.exit(0);

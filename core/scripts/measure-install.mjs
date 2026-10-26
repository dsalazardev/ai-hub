import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(REPO_ROOT, 'core', 'dist', 'bin', 'ai-hub.js');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const preset = option('--preset', 'generic-ts');
const presetOnly = process.argv.includes('--preset-only');
const exclude = option('--exclude');
const keep = process.argv.includes('--keep');
const budget = option('--budget') === null ? null : Number.parseInt(option('--budget'), 10);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function run(args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  return {
    code: result.status ?? 1,
    ms: Math.round(performance.now() - started),
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-measure-'));
try {
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'measure', devDependencies: { typescript: '^5.0.0' } }, null, 2)}\n`,
    'utf8',
  );
  const initArgs = ['init', '--preset', preset, '--yes'];
  if (presetOnly) {
    initArgs.push('--preset-only');
  }
  if (exclude !== null) {
    initArgs.push('--exclude', exclude);
  }
  const cold = run(initArgs);
  if (cold.code !== 0) {
    throw new Error(`init falló (${cold.code}):\n${cold.out}`);
  }
  const files = await walk(root);
  let bytes = 0;
  for (const file of files) {
    bytes += (await fs.stat(file)).size;
  }
  const lock = JSON.parse(await fs.readFile(path.join(root, 'sync.lock.json'), 'utf8'));
  const doctor = run(['doctor']);
  const warm = run(['sync']);
  const report = {
    preset,
    mode: presetOnly ? 'preset-only' : exclude === null ? 'full' : 'custom',
    exclude,
    destinations: Object.keys(lock.files).length,
    files: files.length,
    bytes,
    coldMs: cold.ms,
    warmMs: warm.ms,
    doctorMs: doctor.ms,
    doctorCode: doctor.code,
    warmCode: warm.code,
    budgetMs: budget,
    withinBudget: budget === null ? null : cold.ms <= budget,
    cwd: keep ? root : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (budget !== null && cold.ms > budget) {
    process.exitCode = 1;
  }
} finally {
  if (!keep) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

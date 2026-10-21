#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextFile } from '../context.js';
import { StateNotFoundError } from '../state.js';
import {
  checkEarsRequirements,
  checkScenariosExist,
  checkTasksCoverRequirements,
} from '../harness/level3-semantic.js';
import type { CheckResult } from '../harness/level3-semantic.js';
import { runSync } from '../sync/sync.js';
import { SyncConfigError } from '../sync/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function ok(msg: string): void {
  process.stdout.write(`${GREEN}[OK]${NC}    ${msg}\n`);
}
function fail(msg: string): void {
  process.stdout.write(`${RED}[FAIL]${NC}  ${msg}\n`);
}
function info(msg: string): void {
  process.stdout.write(`[INFO]  ${msg}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`${YELLOW}[WARN]${NC}  ${msg}\n`);
}

function printUsage(): void {
  process.stdout.write('Usage: ai-hub <verify|context|sync [--check]|level3 <change>|judge>\n');
}

async function cmdVerify(): Promise<void> {
  const runAllPath = path.join(PROJECT_ROOT, '.ai-hub', 'harness', 'run-all.sh');
  const result = spawnSync('bash', [runAllPath], { stdio: 'inherit' });
  if (result.error) {
    fail(`run-all.sh no encontrado o no ejecutable: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

async function cmdSync(check: boolean): Promise<void> {
  try {
    const result = await runSync(PROJECT_ROOT, { check });
    if (check) {
      if (result.problems.length > 0) {
        for (const problem of result.problems) {
          fail(problem);
        }
        process.stdout.write('Ejecuta npm run ai:sync tras editar la fuente en .ai-hub/\n');
        process.exit(1);
      }
      ok('Destinos sincronizados');
      process.exit(0);
    }
    ok(`Escritos: ${result.written.length} · Eliminados: ${result.removed.length}`);
    process.exit(0);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof SyncConfigError) {
      process.stdout.write(`${RED}[ERROR]${NC} ${msg}\n`);
    } else {
      fail(`Error en sync: ${msg}`);
    }
    process.exit(1);
  }
}

async function cmdContext(): Promise<void> {
  try {
    await buildContextFile(PROJECT_ROOT);
    ok('Contexto generado: .planning/context-next.md');
    process.exit(0);
  } catch (e: unknown) {
    if (e instanceof StateNotFoundError) {
      fail(e.message);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      fail(`Error generando contexto: ${msg}`);
    }
    process.exit(1);
  }
}

async function cmdLevel3(changeName: string | undefined): Promise<void> {
  if (!changeName) {
    fail('Falta el nombre del cambio. Uso: ai-hub level3 <nombre-del-cambio>');
    process.exit(1);
  }

  const changeDir = path.join(PROJECT_ROOT, 'openspec', 'changes', changeName);

  const checks: Array<{ name: string; fn: () => Promise<CheckResult> }> = [
    { name: 'EARS requirements', fn: () => checkEarsRequirements(changeDir) },
    { name: 'Scenarios exist',   fn: () => checkScenariosExist(changeDir) },
    { name: 'Tasks cover Rn',   fn: () => checkTasksCoverRequirements(changeDir) },
  ];

  let anyFail = false;
  for (const check of checks) {
    const result = await check.fn();
    if (result.pass) {
      ok(check.name);
    } else {
      fail(check.name);
      for (const v of result.violations) {
        process.stdout.write(`         ${v}\n`);
      }
      anyFail = true;
    }
  }

  const total = checks.length;
  const passed = anyFail ? checks.length - checks.filter((_, i) => i < total).length : total;
  if (anyFail) {
    warn(`Level 3 semantic harness — hay violaciones en '${changeName}'`);
    process.exit(1);
  } else {
    ok(`Level 3 semantic harness — ${total}/${total} chequeos pasaron`);
    process.exit(0);
  }
}

async function cmdJudge(): Promise<void> {
  info('Nivel 4 LLM-as-judge no implementado. Disponible en Fase 3 (ai-hub-v4-judge).');
  process.exit(0);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case 'verify':
      await cmdVerify();
      break;
    case 'context':
      await cmdContext();
      break;
    case 'sync':
      await cmdSync(process.argv.includes('--check'));
      break;
    case 'level3':
      await cmdLevel3(process.argv[3]);
      break;
    case 'judge':
      await cmdJudge();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`Error inesperado: ${msg}\n`);
  process.exit(1);
});

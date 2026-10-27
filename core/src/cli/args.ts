import type { ParsedArgs } from './types.js';

const BOOLEAN_FLAGS = new Set([
  'check',
  'check-lock',
  'dry-run',
  'confirm',
  'yes',
  'json',
  'force',
  'install',
  'hooks',
  'all',
  'help',
  'prune',
  'auto',
  'migrate',
  'no-speckit',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body === '') {
      positionals.push(token);
      continue;
    }
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
      continue;
    }
    flags[body] = true;
  }
  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === 'string' ? value : null;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const value = flagString(args, name);
  if (value === null) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

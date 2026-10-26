import type { ParsedArgs } from './types.js';

export function splitItem(args: ParsedArgs): {
  kind: 'skill' | 'agent' | 'rule' | null;
  id: string | null;
} {
  const [first, second] = args.positionals;
  if (!first) {
    return { kind: null, id: null };
  }
  if (first === 'skill' || first === 'agent' || first === 'rule') {
    return { kind: first, id: second ?? null };
  }
  return { kind: null, id: first };
}

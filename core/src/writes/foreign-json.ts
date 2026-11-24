/**
 * Inspección de JSON ajeno (R-033): un JSON inválido, con claves duplicadas o con comentarios se informa y
 * se deja intacto. `JSON.parse` acepta claves duplicadas (gana la última) y rechaza comentarios sin decir
 * por qué; este escáner los distingue sin interpretar ni imprimir valores.
 */

export type ForeignJsonProblem = 'invalid' | 'duplicate-keys' | 'comments';

export function inspectForeignJson(text: string): ForeignJsonProblem | null {
  if (hasComments(text)) {
    return 'comments';
  }
  try {
    JSON.parse(text);
  } catch {
    return 'invalid';
  }
  return hasDuplicateKeys(text) ? 'duplicate-keys' : null;
}

/** Comentarios `//` o `/* … *\/` fuera de cadenas. */
function hasComments(text: string): boolean {
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      return true;
    }
  }
  return false;
}

/** Claves repetidas dentro del mismo objeto (a cualquier profundidad). */
function hasDuplicateKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let index = 0;
  let expectKey = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      stack.push(new Set());
      expectKey = true;
      index += 1;
    } else if (char === '[') {
      stack.push(null);
      expectKey = false;
      index += 1;
    } else if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
      index += 1;
    } else if (char === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      let raw = '';
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') {
          raw += text.slice(end, end + 2);
          end += 2;
          continue;
        }
        raw += text[end];
        end += 1;
      }
      const top = stack[stack.length - 1];
      if (expectKey && top instanceof Set) {
        if (top.has(raw)) {
          return true;
        }
        top.add(raw);
        expectKey = false;
      }
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return false;
}

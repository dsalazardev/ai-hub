import { parse } from 'yaml';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Parses the YAML frontmatter of a source file. Callers normalize CRLF when the
 * body is going to be rendered; this parser accepts both line endings so it can
 * also validate files directly from disk.
 */
export function splitFrontmatter(text: string, source: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    throw new Error(`sin frontmatter: ${source}`);
  }
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch (error) {
    throw new Error(`frontmatter inválido: ${source}: ${(error as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`frontmatter inválido: ${source}: se esperaba un objeto`);
  }
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) };
}

export function frontmatterString(
  data: Record<string, unknown>,
  key: string,
  source: string,
): string {
  const value = data[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${source}: frontmatter.${key} debe ser texto no vacío`);
  }
  return value;
}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Tokens that must never reach a published source again (REQ-01, catalogo-completo). */
const BRAND =
  /\b(?:rsc|risco)\b|ericrisco|rsc-harness|@ericrisco\/rsc|ai-hub SDD|origin:\s*(?:risco|ai-hub)\b|02-DOCS/i;

const SCAN_TREES = ['core/skills', 'core/agents', 'rules'];
const SCAN_ROOT_FILES = [
  'manifest.yaml',
  'README.md',
  'AGENTS.md',
  'package.json',
  'core/package.json',
];
const TEXT_FILE = /\.(?:md|yaml|yml|json)$/i;

const EXCLUDED_PREFIXES = [
  'archive/',
  'openspec/',
  '.planning/',
  '.specify/',
  'core/dist/',
  'node_modules/',
];
const EXCLUDED_FILES = ['NOTICE.md'];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isExcluded(rel: string): boolean {
  if (EXCLUDED_FILES.includes(rel)) {
    return true;
  }
  return EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix) || rel.includes(`/${prefix}`));
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
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

interface ScannedFile {
  rel: string;
  text: string;
}

let sourcesPromise: Promise<ScannedFile[]> | null = null;

async function publishedSources(): Promise<ScannedFile[]> {
  if (sourcesPromise !== null) {
    return sourcesPromise;
  }
  sourcesPromise = (async () => {
    const found: ScannedFile[] = [];
    for (const tree of SCAN_TREES) {
      for (const file of await walk(path.join(REPO_ROOT, ...tree.split('/')))) {
        if (!TEXT_FILE.test(file)) {
          continue;
        }
        const rel = toPosix(path.relative(REPO_ROOT, file));
        if (isExcluded(rel)) {
          continue;
        }
        found.push({ rel, text: await fs.readFile(file, 'utf8') });
      }
    }
    for (const rel of SCAN_ROOT_FILES) {
      if (isExcluded(rel)) {
        continue;
      }
      found.push({ rel, text: await fs.readFile(path.join(REPO_ROOT, ...rel.split('/')), 'utf8') });
    }
    return found;
  })();
  return sourcesPromise;
}

async function publishedSkillIds(manifestText: string): Promise<string[]> {
  const manifest = parseYaml(manifestText) as { skills?: { publish?: unknown } };
  const publish = manifest.skills?.publish;
  expect(Array.isArray(publish)).toBe(true);
  const ids = publish as string[];
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

describe('brand gate', () => {
  it('keeps every published source free of third-party brand residue', async () => {
    const findings: string[] = [];
    for (const { rel, text } of await publishedSources()) {
      text.split(/\r?\n/).forEach((line, index) => {
        if (BRAND.test(line)) {
          findings.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });

  it('keeps published file names free of brand residue', async () => {
    const findings: string[] = [];
    for (const tree of SCAN_TREES) {
      for (const file of await walk(path.join(REPO_ROOT, ...tree.split('/')))) {
        const rel = toPosix(path.relative(REPO_ROOT, file));
        if (!isExcluded(rel) && BRAND.test(rel)) {
          findings.push(rel);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('marks every published skill with origin: dsalazardev', async () => {
    const manifestText = await fs.readFile(path.join(REPO_ROOT, 'manifest.yaml'), 'utf8');
    const ids = await publishedSkillIds(manifestText);
    const missing: string[] = [];
    for (const id of ids) {
      const file = path.join(REPO_ROOT, 'core', 'skills', 'shared', id, 'SKILL.md');
      const text = await fs.readFile(file, 'utf8');
      const frontmatter = FRONTMATTER.exec(text);
      expect(frontmatter, `${id} has no frontmatter`).not.toBeNull();
      const meta = parseYaml(frontmatter![1]) as { origin?: unknown };
      if (meta.origin !== 'dsalazardev') {
        missing.push(`${id}: origin=${String(meta.origin)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('proves the gate detects a reintroduced token and skips NOTICE.md', async () => {
    expect(BRAND.test('npx @ericrisco/rsc add x')).toBe(true);
    expect(BRAND.test('origin: risco')).toBe(true);
    expect(BRAND.test('origin: ai-hub')).toBe(true);
    expect(BRAND.test('read 02-DOCS/wiki/index.md first')).toBe(true);
    expect(BRAND.test('ai-hub SDD')).toBe(true);
    expect(BRAND.test('the catalog ships skills, undiscussed')).toBe(false);
    // An unadapted upstream line reintroduced into an agent body fails the gate.
    expect(BRAND.test('`rsc review consolidate` merges what several lenses reported')).toBe(true);
    expect(BRAND.test('one of three adversarial lenses of the review panel')).toBe(false);

    const scanned = (await publishedSources()).map((file) => file.rel);
    expect(scanned).not.toContain('NOTICE.md');
    expect(scanned).toContain('core/agents/refuter-correctness.md');
    expect(scanned).toContain('core/agents/refuter-security.md');
    expect(scanned).toContain('core/agents/refuter-tests.md');
    expect(scanned).toContain('core/agents/finding-verifier.md');
    expect(EXCLUDED_FILES).toContain('NOTICE.md');
    expect(isExcluded('archive/upstream/ai-hub/README.md')).toBe(true);
    expect(isExcluded('openspec/changes/archive/x/proposal.md')).toBe(true);
    expect(isExcluded('.planning/memory.jsonl')).toBe(true);
    expect(isExcluded('.specify/assessments/x/spec.md')).toBe(true);
    expect(isExcluded('core/dist/cli/run.js')).toBe(true);
    expect(isExcluded('core/skills/shared/harness/SKILL.md')).toBe(false);

    const notice = await fs.readFile(path.join(REPO_ROOT, 'NOTICE.md'), 'utf8');
    expect(BRAND.test(notice)).toBe(false);
    expect(notice).toContain('Daner Alejandro Salazar Colorado');
    expect(notice).toMatch(/MIT/i);
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { listPresetIds, loadPreset } from './schema.js';

export interface RepoProfile {
  files: string[];
  dependencies: Record<string, string>;
  packageManagers: string[];
  testRunners: string[];
  signals: string[];
}

export interface DetectionCandidate {
  id: string;
  score: number;
}

export interface DetectionResult {
  id: string;
  candidates: DetectionCandidate[];
  ambiguous: string[];
  profile: RepoProfile;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '');
}

export async function detectRepo(root: string): Promise<RepoProfile> {
  const rootPkg = await readJson<Record<string, unknown>>(path.join(root, 'package.json'));
  const deps: Record<string, string> = {};
  if (rootPkg) {
    for (const key of ['dependencies', 'devDependencies']) {
      const block = rootPkg[key];
      if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
        for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
          deps[name] = String(version);
        }
      }
    }
  }

  const packageManagers: string[] = [];
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) packageManagers.push('pnpm');
  if (await exists(path.join(root, 'yarn.lock'))) packageManagers.push('yarn');
  if ((await exists(path.join(root, 'bun.lockb'))) || (await exists(path.join(root, 'bun.lock')))) {
    packageManagers.push('bun');
  }
  if (await exists(path.join(root, 'package-lock.json'))) packageManagers.push('npm');
  if (packageManagers.length === 0 && rootPkg) packageManagers.push('npm');

  const testRunners: string[] = [];
  if (deps.vitest) testRunners.push('vitest');
  if (deps.jest) testRunners.push('jest');
  if (deps['@playwright/test'] || deps.playwright) testRunners.push('playwright');
  const pythonText = `${await readText(path.join(root, 'pyproject.toml'))}\n${await readText(path.join(root, 'requirements.txt'))}`;
  if (/pytest/i.test(pythonText)) testRunners.push('pytest');
  if (await exists(path.join(root, 'go.mod'))) testRunners.push('go test');

  const signals: string[] = [];
  if (rootPkg?.workspaces) signals.push('package.json#workspaces');
  for (const file of ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json']) {
    if (await exists(path.join(root, file))) signals.push(file);
  }

  const files: string[] = [];
  for (const file of [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
  ]) {
    if (await exists(path.join(root, file))) files.push(file);
  }

  return { files, dependencies: deps, packageManagers, testRunners, signals };
}

export async function detectPreset(root: string): Promise<DetectionResult> {
  const profile = await detectRepo(root);
  const candidates: DetectionCandidate[] = [];
  for (const id of await listPresetIds()) {
    const preset = await loadPreset(id);
    const detect = preset.detect;
    if (!detect) {
      continue;
    }
    let score = 0;
    for (const file of detect.files ?? []) {
      if (profile.files.includes(file) || (await exists(path.join(root, file)))) {
        score += 2;
      }
    }
    for (const dependency of detect.dependencies ?? []) {
      if (dependency in profile.dependencies) {
        score += 1;
      }
    }
    if (score > 0) {
      candidates.push({ id, score });
    }
  }
  const chosen = chooseDetection(candidates);
  return { ...chosen, candidates, profile };
}

export function chooseDetection(candidates: DetectionCandidate[]): {
  id: string;
  ambiguous: string[];
} {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  if (sorted.length === 0) {
    return { id: 'base', ambiguous: [] };
  }
  const top = sorted[0].score;
  const tied = sorted.filter((candidate) => candidate.score === top).map((candidate) => candidate.id);
  if (tied.length > 1) {
    return { id: 'base', ambiguous: tied };
  }
  return { id: sorted[0].id, ambiguous: [] };
}

export function applyPackageManager(profile: RepoProfile, presetPackageManager: string | undefined): string | undefined {
  return profile.packageManagers[0] ?? presetPackageManager;
}

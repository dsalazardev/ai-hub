import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEngine } from '../src/engine/engine.js';
import { probeShell, shellCandidates } from '../src/speckit/commands.js';
import type { ProcessRunner } from '../src/speckit/runner.js';
import { effectiveSpeckit, type SpeckitSettings } from '../src/speckit/settings.js';

async function shSettings(): Promise<SpeckitSettings> {
  return effectiveSpeckit({ targets: ['claude'] }, await loadEngine());
}

async function psSettings(): Promise<SpeckitSettings> {
  return effectiveSpeckit({ targets: ['claude'], speckit: { script: 'ps' } }, await loadEngine());
}

/** El bash del PATH es el lanzador de WSL sin distribución; cualquier otro comando ejecuta. */
const brokenWslRunner: ProcessRunner = async (command) =>
  command === 'bash'
    ? { status: 1, stdout: '', stderr: 'WSL: no hay distribuciones instaladas' }
    : { status: 0, stdout: 'ok\n', stderr: '' };

const okRunner: ProcessRunner = async () => ({ status: 0, stdout: 'ok\n', stderr: '' });

describe('shellCandidates (1.1)', () => {
  it('lists PATH bash first and the standard Git for Windows locations on win32', async () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    };
    const commands = shellCandidates(await shSettings(), 'win32', env).map((candidate) => candidate.command);
    expect(commands).toEqual([
      'bash',
      path.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    ]);
  });

  it('omits candidates whose environment variable is missing', async () => {
    const commands = shellCandidates(await shSettings(), 'win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }).map(
      (candidate) => candidate.command,
    );
    expect(commands).toEqual(['bash', path.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'Git', 'bin', 'bash.exe')]);
  });

  it('keeps only the PATH bash on linux and macOS', async () => {
    const settings = await shSettings();
    for (const platform of ['linux', 'darwin'] as const) {
      expect(shellCandidates(settings, platform, {}).map((candidate) => candidate.command)).toEqual(['bash']);
    }
  });

  it('keeps the PowerShell candidates for ps on every platform', async () => {
    const settings = await psSettings();
    for (const platform of ['win32', 'linux'] as const) {
      expect(shellCandidates(settings, platform, {}).map((candidate) => candidate.command)).toEqual([
        'pwsh',
        'powershell',
      ]);
    }
  });
});

describe('probeShell (1.1, 1.2)', () => {
  it('resolves the absolute Git Bash when the PATH bash is a broken WSL stub', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-shell-fallback-'));
    try {
      const gitBash = path.join(base, 'Programs', 'Git', 'bin', 'bash.exe');
      await fs.mkdir(path.dirname(gitBash), { recursive: true });
      await fs.writeFile(gitBash, 'stub\n');
      const probe = await probeShell(await shSettings(), brokenWslRunner, base, 'win32', { LOCALAPPDATA: base });
      expect(probe).toEqual({ ok: true, command: gitBash, tried: ['bash', gitBash] });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('keeps the PATH bash when it works and does not try later candidates', async () => {
    const probe = await probeShell(await shSettings(), okRunner, '.', 'win32', { ProgramFiles: 'C:\\Program Files' });
    expect(probe).toEqual({ ok: true, command: 'bash', tried: ['bash'] });
  });

  it('omits nonexistent paths from the tried list and fails without any shell', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-shell-missing-'));
    try {
      const probe = await probeShell(await shSettings(), brokenWslRunner, base, 'win32', { LOCALAPPDATA: base });
      expect(probe).toEqual({ ok: false, command: 'bash', tried: ['bash'] });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

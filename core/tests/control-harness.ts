import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect } from 'vitest';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { setControlDeps } from '../src/control/cli.js';
import { CONTROL_DIR } from '../src/control/ledger.js';
import { appendRunEvent } from '../src/harness/runs.js';
import { fakeRunner } from './speckit-fake.js';
import { TOKEN_SENTINEL, type FakeGitlab, type FakeIssue } from './control-fake.js';

/** Consumidor sintético para las fases 3–5 de hermes-control (mismo montaje que `control.test.ts`). */
export const NOW = new Date('2026-11-09T09:00:00.000Z');
export const APPROVER = '123456789012345678';
export const TEMPLATES = path.resolve(__dirname, '..', 'engine', 'templates', 'hermes');

export interface Harness {
  root: string;
  cli(argv: string[]): Promise<{ code: number; out: string; err: string }>;
  consumer(options?: { control?: boolean; expire?: 'block' | 'notify' }): Promise<void>;
  feature(name: string, files?: Record<string, string>): Promise<void>;
  status(feature: string, state: string, run?: string): Promise<void>;
  ledgerText(): Promise<string>;
  use(gitlab: FakeGitlab, now?: Date): void;
  dispose(): Promise<void>;
}

export function issue(iid: number, feature: string | null, label: string, extra: Partial<FakeIssue> = {}): FakeIssue {
  return {
    iid,
    title: `Issue ${iid}`,
    labels: [label],
    description: feature ? `Contexto.\n\nai-hub:feature=${feature}\n` : 'Sin marcador.',
    notes: [],
    ...extra,
  };
}

export async function harness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-control-'));
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line) };
    const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return {
    root,
    cli,
    async consumer(options = {}) {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
      const init = await cli(['init', '--preset-only', '--yes']);
      expect(init.code, init.out + init.err).toBe(0);
      const control = [
        'control:',
        '  approvers:',
        `    - "${APPROVER}"`,
        '  channelId: "987654321098765432"',
        '  ttlHours: 24',
        `  expire: ${options.expire ?? 'block'}`,
        '',
      ].join('\n');
      await fs.appendFile(
        path.join(root, 'manifest.yaml'),
        `tracker:\n  kind: gitlab\n  urlEnv: GITLAB_URL\n  tokenEnv: GITLAB_TOKEN\n${options.control === false ? '' : control}`,
      );
      await fs.writeFile(
        path.join(root, '.ai-hub', '.env'),
        `GITLAB_URL=https://gitlab.example.test\nGITLAB_TOKEN=${TOKEN_SENTINEL}\nGITLAB_PROJECT_PATH=grp/demo\n`,
      );
    },
    async feature(name, files = {}) {
      const dir = path.join(root, 'specs', name);
      await fs.mkdir(dir, { recursive: true });
      for (const [file, text] of Object.entries({ 'spec.md': `# ${name}\n`, 'plan.md': '# Plan\n', 'tasks.md': '- [ ] T001 Demo\n', ...files })) {
        await fs.writeFile(path.join(dir, file), text);
      }
    },
    async status(feature, state, run = '20261109-090000Z-aaaaaa') {
      await appendRunEvent(root, { v: 1, ts: NOW.toISOString(), run, kind: 'status', state, artifact: `specs/${feature}/tasks.md` });
    },
    ledgerText: () => fs.readFile(path.join(root, CONTROL_DIR, 'decisions.jsonl'), 'utf8').catch(() => ''),
    use(gitlab, now = NOW) {
      setControlDeps({ trackerFetch: gitlab.fetch, now: () => now });
    },
    async dispose() {
      setControlDeps({});
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export { TOKEN_SENTINEL };

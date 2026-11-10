import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFencedIdea } from '../src/cli/idea.js';
import { BRACKETED_END, BRACKETED_START, IDEA_SENTINEL, asTerminalPaste, makeIdeaFixture } from './idea-fixtures.js';
import {
  PTY_TIMEOUT_MS,
  PtyTimeoutError,
  ensureDead,
  isAlive,
  loadNodePty,
  nodePtyChild,
  pipeChild,
  withPty,
} from './pty-harness.js';

/**
 * idea-input D9: sondas de terminal real. Proyecto `integration` (vitest.config.ts): `withPty` corta a 45 s y
 * cada `it` declara 90 s, así que el helper siempre informa antes que vitest y su `finally` mata al hijo.
 */
const PROBE = { timeout: 90_000 };
const nodePty = await loadNodePty();

describe('idea-input — arnés withPty (1.6)', () => {
  it('el timeout por defecto es 45 s, por debajo del timeout del test', () => {
    expect(PTY_TIMEOUT_MS).toBe(45_000);
    expect(PTY_TIMEOUT_MS).toBeLessThan(PROBE.timeout);
  });

  it('un hijo que nunca responde falla por timeout, se mata y no queda vivo', PROBE, async () => {
    let pid = 0;
    const started = Date.now();
    const run = withPty(
      'hijo colgado',
      () => {
        const child = pipeChild(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
        pid = child.pid;
        return child;
      },
      async (session) => {
        await session.waitFor('respuesta que nunca llega');
      },
      2_000,
    );
    await expect(run).rejects.toBeInstanceOf(PtyTimeoutError);
    expect(Date.now() - started).toBeLessThan(PTY_TIMEOUT_MS);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });

  it('ensureDead mata un proceso que ignora SIGTERM (taskkill en Windows, SIGKILL en POSIX)', PROBE, async () => {
    const child = pipeChild(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
    expect(isAlive(child.pid)).toBe(true);
    expect(await ensureDead(child.pid)).toBe(true);
    expect(isAlive(child.pid)).toBe(false);
  });
});

describe('idea-input — node-pty sin declarar (1.5)', () => {
  it.skipIf('pty' in nodePty)(`sin node-pty la sonda se salta con su motivo: ${'reason' in nodePty ? nodePty.reason : ''}`, () => {
    expect('reason' in nodePty && nodePty.reason).toMatch(/npm install --no-save node-pty/);
  });

  it.skipIf(!('pty' in nodePty))('con node-pty, un hijo en pseudoterminal recibe bytes crudos y termina', PROBE, async () => {
    if (!('pty' in nodePty)) {
      return;
    }
    let pid = 0;
    const result = await withPty(
      'eco crudo',
      () => {
        const child = nodePtyChild(
          nodePty.pty,
          process.execPath,
          ['-e', "process.stdin.setRawMode(true);process.stdout.write('listo\\n');process.stdin.on('data',d=>{process.stdout.write('bytes:'+d.length+'\\n');process.exit(0)})"],
          { cwd: process.cwd() },
        );
        pid = child.pid;
        return child;
      },
      async (session) => {
        await session.waitFor('listo');
        session.child.write('abc');
        await session.waitFor(/bytes:\d+/);
        return /bytes:(\d+)/.exec(session.output())?.[1];
      },
    );
    expect(result).toBe('3');
    expect(isAlive(pid)).toBe(false);
  });
});

// ───────────────── Sondas de terminal real del lector (4.7 nivel 2, 4.8 nivel 3, 4.9) ─────────────────

const CORE = fileURLToPath(new URL('..', import.meta.url));
const DRIVER = path.join(CORE, 'tests', 'fixtures', 'idea-pty-driver.mjs');

/** Las sondas ejecutan `dist/`: si está más viejo que `src/`, se saltan con el motivo (no prueban código viejo). */
async function staleDist(): Promise<string | null> {
  for (const [src, dist] of [
    ['src/cli/idea.ts', 'dist/cli/idea.js'],
    ['src/cli/assistant.ts', 'dist/cli/assistant.js'],
    ['src/presets/materialize.ts', 'dist/presets/materialize.js'],
  ]) {
    const built = await fs.stat(path.join(CORE, dist)).catch(() => null);
    const source = await fs.stat(path.join(CORE, src));
    if (built === null || built.mtimeMs < source.mtimeMs) {
      return `dist desactualizado (${dist}); ejecuta npm run build`;
    }
  }
  return null;
}

const distReason = await staleDist();
const level3Reason = 'reason' in nodePty ? nodePty.reason : distReason;
const level2Reason =
  process.platform === 'win32'
    ? 'nivel 2 usa el pty POSIX de Python: no aplica en win32 (corre en Linux/WSL con node)'
    : spawnSync('python3', ['--version']).status !== 0
      ? 'python3 no disponible'
      : distReason;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function seedIdeaOf(seed: string): string | null {
  const section = seed.split('\n## Idea\n')[1];
  return section === undefined ? null : extractFencedIdea(section);
}

/**
 * Nivel 3: shell real (PowerShell 5.1 en Windows, bash en POSIX) en un pseudoterminal de node-pty; dentro, el driver
 * del lector. Escribe el pegado en trozos de 1 KiB, termina con Ctrl+D (o Ctrl+C a mitad) y espera a que el shell
 * vuelva: cualquier byte sobrante del pegado aparecería después de la marca final.
 */
async function shellProbe(paste: string, options: { ctrlCAt?: number } = {}): Promise<{ output: string; root: string }> {
  if (!('pty' in nodePty)) {
    throw new Error('node-pty no disponible');
  }
  const pty = nodePty.pty;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-pty-'));
  const windows = process.platform === 'win32';
  const output = await withPty(
    'lector de la idea en terminal real',
    () =>
      nodePtyChild(pty, windows ? 'powershell.exe' : 'bash', windows ? ['-NoLogo', '-NoProfile'] : ['--norc', '--noprofile'], {
        cwd: root,
        cols: 140,
        rows: 50,
      }),
    async (session) => {
      await session.waitFor(windows ? /PS .*> ?$/m : /\$ ?$/m);
      session.child.write(`node "${DRIVER}" "${CORE}" "${root}"\r`);
      await session.waitFor('Ctrl+D o');
      let cancelled = false;
      for (let index = 0; index < paste.length; index += 1024) {
        if (options.ctrlCAt !== undefined && !cancelled && index >= options.ctrlCAt) {
          session.child.write('\x03');
          cancelled = true;
        }
        session.child.write(paste.slice(index, index + 1024));
        await sleep(5);
      }
      await sleep(400);
      if (options.ctrlCAt === undefined) {
        session.child.write('\x04');
      }
      await session.waitFor(/CONFIRM:\w+|RESULT:cancel/);
      await sleep(2_000); // el shell procesaría aquí cualquier resto del pegado
      return session.output();
    },
  );
  return { output, root };
}

function afterDriver(output: string): string {
  const marks = ['CONFIRM:', 'RESULT:cancel'].map((mark) => output.lastIndexOf(mark)).filter((index) => index >= 0);
  return output.slice(Math.max(...marks));
}

const suffix = (reason: string | null): string => (reason ? ` (${reason})` : '');

describe('idea-input — nivel 3: node-pty sobre la terminal del sistema (4.8, 4.9)', () => {
  it.skipIf(level3Reason !== null)(
    `pegado de 2000 líneas con bracketed paste: seed.md idéntico, confirm sin respuesta, nada llega al shell${suffix(level3Reason)}`,
    PROBE,
    async () => {
      const idea = makeIdeaFixture({ lines: 2000 });
      const { output, root } = await shellProbe(`${BRACKETED_START}${asTerminalPaste(idea)}${BRACKETED_END}`);
      expect(output).toContain('CONFIRM:none');
      expect(afterDriver(output)).not.toContain(IDEA_SENTINEL);
      expect(seedIdeaOf(await fs.readFile(path.join(root, 'backlog', 'seed.md'), 'utf8'))).toBe(idea);
      await fs.rm(root, { recursive: true, force: true });
    },
  );

  it.skipIf(level3Reason !== null)(
    `pegado de 2000 líneas sin marcadores (caso conhost): seed.md idéntico y nada llega al shell${suffix(level3Reason)}`,
    PROBE,
    async () => {
      const idea = makeIdeaFixture({ lines: 2000 });
      const { output, root } = await shellProbe(asTerminalPaste(idea));
      expect(output).toContain('CONFIRM:none');
      expect(afterDriver(output)).not.toContain(IDEA_SENTINEL);
      expect(seedIdeaOf(await fs.readFile(path.join(root, 'backlog', 'seed.md'), 'utf8'))).toBe(idea);
      await fs.rm(root, { recursive: true, force: true });
    },
  );

  it.skipIf(level3Reason !== null)(
    `pegado de 64 KiB con bracketed paste: seed.md idéntico${suffix(level3Reason)}`,
    PROBE,
    async () => {
      // Decisión del propietario (opción 1): la consola de Windows entrega ~15 KB/s con o sin render (medido), así
      // que 1 MiB no cabe en los 45 s de withPty. 1 MiB se verifica en proceso (4.3) y por --idea-file/--idea-editor.
      const idea = makeIdeaFixture({ bytes: 64 * 1024 });
      const { output, root } = await shellProbe(`${BRACKETED_START}${asTerminalPaste(idea)}${BRACKETED_END}`);
      expect(output).toContain('CONFIRM:none');
      expect(seedIdeaOf(await fs.readFile(path.join(root, 'backlog', 'seed.md'), 'utf8'))).toBe(idea);
      await fs.rm(root, { recursive: true, force: true });
    },
  );

  it.skipIf(level3Reason !== null)(
    `Ctrl+C a mitad del pegado: cancela, no escribe nada y nada llega al shell (4.9)${suffix(level3Reason)}`,
    PROBE,
    async () => {
      const paste = `${BRACKETED_START}${asTerminalPaste(makeIdeaFixture({ lines: 400 }))}${BRACKETED_END}`;
      const { output, root } = await shellProbe(paste, { ctrlCAt: Math.floor(paste.length / 2) });
      expect(output).toContain('RESULT:cancel');
      expect(afterDriver(output)).not.toContain(IDEA_SENTINEL);
      expect(await fs.readdir(root)).toEqual([]);
      await fs.rm(root, { recursive: true, force: true });
    },
  );
});

/** Nivel 2: pty POSIX de Python; tras el driver, `cat` en modo no canónico lee lo que quede en la TTY. */
const LEVEL2_SCRIPT = [
  'import os, pty, sys, time, select',
  'core, driver, root, paste_path, leftover = sys.argv[1:6]',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  "    os.execvp('sh', ['sh', '-c', 'node \"$1\" \"$2\" \"$3\"; stty -icanon -echo min 0 time 10; cat > \"$4\"', 'sh', driver, core, root, leftover])",
  "buf = b''",
  'def pump(seconds):',
  '    global buf',
  '    end = time.time() + seconds',
  '    while time.time() < end:',
  '        ready, _, _ = select.select([fd], [], [], 0.05)',
  '        if ready:',
  '            try:',
  '                data = os.read(fd, 65536)',
  '            except OSError:',
  '                return',
  '            if not data:',
  '                return',
  '            buf += data',
  'deadline = time.time() + 40',
  "while b'Ctrl+D o' not in buf and time.time() < deadline:",
  '    pump(0.1)',
  "mode = sys.argv[6] if len(sys.argv) > 6 else 'paste'",
  "data = open(paste_path, 'rb').read()",
  'half = len(data) // 2',
  'cancelled = False',
  'for i in range(0, len(data), 1024):',
  "    if mode == 'ctrlc' and not cancelled and i >= half:",
  '        os.write(fd, bytes([3]))',
  '        cancelled = True',
  '    os.write(fd, data[i:i + 1024])',
  // Tras Ctrl+C el resto del pegado llega con pausas de 50 ms: el caso que dejaba bytes en la TTY (4.9).
  "    pump(0.05 if cancelled else 0.005)",
  "if mode == 'paste':",
  '    pump(0.4)',
  '    os.write(fd, bytes([4]))',
  "end_mark = b'RESULT:cancel' if mode == 'ctrlc' else b'CONFIRM:'",
  'while end_mark not in buf and time.time() < deadline:',
  '    pump(0.1)',
  'pump(2.5)',
  'os.waitpid(pid, 0)',
  "sys.stdout.write(buf.decode('utf8', 'replace'))",
].join('\n');

describe('idea-input — nivel 2: pty POSIX de Python (4.7)', () => {
  it.skipIf(level2Reason !== null)(
    `pegado de 2000 líneas: seed.md idéntico, confirm sin respuesta y cero bytes sobrantes en la TTY${suffix(level2Reason)}`,
    PROBE,
    async () => {
      const idea = makeIdeaFixture({ lines: 2000 });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-pty2-'));
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-pty2-work-'));
      const pastePath = path.join(work, 'paste.bin');
      const leftover = path.join(work, 'leftover.bin');
      await fs.writeFile(pastePath, `${BRACKETED_START}${asTerminalPaste(idea)}${BRACKETED_END}`);
      const output = await withPty(
        'nivel 2 python pty',
        () => pipeChild('python3', ['-c', LEVEL2_SCRIPT, CORE, DRIVER, root, pastePath, leftover]),
        async (session) => {
          await session.exited;
          return session.output();
        },
      );
      expect(output).toContain('CONFIRM:none');
      expect((await fs.stat(leftover)).size).toBe(0);
      expect(seedIdeaOf(await fs.readFile(path.join(root, 'backlog', 'seed.md'), 'utf8'))).toBe(idea);
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(work, { recursive: true, force: true });
    },
  );

  it.skipIf(level2Reason !== null)(
    `Ctrl+C a mitad de un pegado de 400 líneas que sigue llegando con pausas de 50 ms: cancela, no escribe nada y cero bytes sobrantes en la TTY (4.9)${suffix(level2Reason)}`,
    PROBE,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-pty2c-'));
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-pty2c-work-'));
      const pastePath = path.join(work, 'paste.bin');
      const leftover = path.join(work, 'leftover.bin');
      await fs.writeFile(pastePath, `${BRACKETED_START}${asTerminalPaste(makeIdeaFixture({ lines: 400 }))}${BRACKETED_END}`);
      const output = await withPty(
        'nivel 2 python pty, Ctrl+C con pausas',
        () => pipeChild('python3', ['-c', LEVEL2_SCRIPT, CORE, DRIVER, root, pastePath, leftover, 'ctrlc']),
        async (session) => {
          await session.exited;
          return session.output();
        },
      );
      expect(output).toContain('RESULT:cancel');
      expect(output).not.toContain('quedan bytes del pegado en la terminal');
      expect((await fs.stat(leftover)).size).toBe(0);
      expect(await fs.readdir(root)).toEqual([]);
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(work, { recursive: true, force: true });
    },
  );
});

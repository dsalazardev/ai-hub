import { spawn } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveryDeps } from './discovery.js';

/**
 * Dependencias reales del descubrimiento: el binario se busca en `PATH` sin shell (con `PATHEXT` en Windows), cada
 * comando corre en un directorio temporal vacío nuevo fuera de cualquier proyecto, con timeout, sin entrada estándar y
 * sin leer archivos de credenciales. La salida solo se usa en memoria.
 */
export function hostDiscoveryDeps(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DiscoveryDeps {
  return {
    async resolveBinary(binary) {
      const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((item) => item.toLowerCase())] : [''];
      for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        for (const extension of extensions) {
          const candidate = path.join(dir, `${binary}${extension}`);
          if (await access(candidate).then(() => true, () => false)) {
            return candidate;
          }
        }
      }
      return null;
    },
    emptyDir: () => mkdtemp(path.join(os.tmpdir(), 'ai-hub-probe-')),
    run(command, args, { cwd, timeoutMs }) {
      return new Promise((resolve) => {
        let stdout = '';
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: timeoutMs });
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = (stdout + chunk.toString('utf8')).slice(-4096);
        });
        child.on('error', (error: NodeJS.ErrnoException) => resolve({ exitCode: null, stdout, started: !['ENOENT', 'EACCES'].includes(error.code ?? '') }));
        child.on('close', (code) => resolve({ exitCode: code, stdout, started: true }));
      });
    },
  };
}

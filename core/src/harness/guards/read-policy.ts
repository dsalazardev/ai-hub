import type { GuardMode } from './types.js';

/**
 * Política de lectura (R-047–R-053), núcleo puro: no importa `node:fs`, `node:child_process` ni `node:net`.
 * Evalúa lecturas, ediciones, búsquedas y lectores de shell reconocidos contra rutas sensibles ya resueltas por el
 * adaptador. En `enforce` una coincidencia, o una lectura reconocida cuyo destino no se puede verificar, se deniega;
 * en `shadow` se permite con un aviso redactado. Los diagnósticos nombran el patrón y la acción, nunca el contenido
 * ni la ruta completa. Se desactiva con `policy.optOuts: [read]` sin afectar a las demás guardias.
 */

export const READ_OPT_OUT = 'read';

export type SensitivePattern = 'ssh_key' | 'cloud_credentials' | 'env_file' | 'private_key' | 'hermes_profile';

/** Un destino de lectura: la ruta pedida y su destino real, ya normalizados (`/`), o null si no se pudo verificar. */
export interface ReadTarget {
  requested: string | null;
  real: string | null;
}

/** Una lectura reconocida. `targets: null` = no se pudo determinar el destino (variable, glob, sustitución). */
export interface RecognizedRead {
  tool: string;
  action: 'read' | 'edit' | 'search';
  targets: ReadTarget[] | null;
}

export interface ReadDecision {
  decision: 'allow' | 'deny';
  /** Aviso redactado (patrón y acción) en `shadow`, o el motivo de la denegación. */
  warning: string | null;
  rule: string | null;
}

const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults']);
const CLOUD_FILES: ReadonlyArray<RegExp> = [
  /(^|\/)\.aws\/(credentials|config)$/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.azure(\/|$)/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)_netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/,
];

/**
 * Patrón sensible de una ruta normalizada con `/`. `caseInsensitive` solo donde el sistema de archivos lo es:
 * en Windows `..\Project\.ENV` coincide con `.env`; en un sistema sensible a mayúsculas `.ENVIRONMENT.md` no.
 */
export function matchSensitive(file: string, caseInsensitive: boolean): SensitivePattern | null {
  const normalized = caseInsensitive ? file.toLowerCase() : file;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (/(^|\/)\.ssh(\/|$)/.test(normalized) && !base.endsWith('.pub') && base !== 'known_hosts') {
    return 'ssh_key';
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(base)) {
    return 'ssh_key';
  }
  if (CLOUD_FILES.some((pattern) => pattern.test(normalized))) {
    return 'cloud_credentials';
  }
  if (/^\.env(\..+)?$/.test(base) && !ENV_EXAMPLES.has(base)) {
    return 'env_file';
  }
  if (/\.(pem|key|p12|pfx|ppk|jks|keystore)$/.test(base)) {
    return 'private_key';
  }
  if (/(^|\/)\.?hermes(\/profiles\/[^/]+)?\/(config\.yaml|\.env)$/.test(normalized)) {
    return 'hermes_profile';
  }
  return null;
}

// --- Lectores de shell reconocidos (R-051). Cualquier otro programa no se evalúa ni se declara protegido. --------
const READERS: Readonly<Record<string, { action: RecognizedRead['action']; skipFirst?: boolean; pathFlags?: string[] }>> = {
  cat: { action: 'read' },
  head: { action: 'read' },
  tail: { action: 'read' },
  less: { action: 'read' },
  more: { action: 'read' },
  bat: { action: 'read' },
  nl: { action: 'read' },
  type: { action: 'read' },
  'get-content': { action: 'read', pathFlags: ['-path', '-literalpath'] },
  gc: { action: 'read', pathFlags: ['-path', '-literalpath'] },
  grep: { action: 'search', skipFirst: true },
  egrep: { action: 'search', skipFirst: true },
  rg: { action: 'search', skipFirst: true },
  findstr: { action: 'search', skipFirst: true },
  'select-string': { action: 'search', pathFlags: ['-path', '-literalpath'] },
  sls: { action: 'search', pathFlags: ['-path', '-literalpath'] },
};

/** Un argumento cuyo destino no se puede conocer sin ejecutar el shell: variables, sustituciones o comodines. */
export function unverifiableArgument(arg: string): boolean {
  return /[$`%*?[\]{}]|^~[^/\\]/.test(arg);
}

function tokenize(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of segment) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== '') {
        tokens.push(current);
      }
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    return null;
  }
  if (started || current !== '') {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Lecturas de un comando de shell: cada segmento (`|`, `;`, `&&`, `||`) cuyo programa es un lector reconocido.
 * Devuelve las rutas tal cual (el adaptador las resuelve); `null` como destino si alguna no es verificable.
 */
export function shellReads(command: string): Array<{ program: string; action: RecognizedRead['action']; paths: string[] | null }> {
  const reads: Array<{ program: string; action: RecognizedRead['action']; paths: string[] | null }> = [];
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const tokens = tokenize(segment.trim().replace(/[<>]\s*\S+/g, ''));
    if (tokens === null || tokens.length === 0) {
      continue;
    }
    const program = tokens[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    const reader = READERS[program];
    if (!reader) {
      continue;
    }
    const paths: string[] = [];
    let unverifiable = false;
    let skippedPattern = !reader.skipFirst;
    const args = tokens.slice(1);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const lower = arg.toLowerCase();
      if (reader.pathFlags?.includes(lower)) {
        const value = args[index + 1];
        index += 1;
        if (value === undefined || unverifiableArgument(value)) {
          unverifiable = true;
        } else {
          paths.push(value);
        }
        continue;
      }
      if (arg.startsWith('-') || (program === 'findstr' && arg.startsWith('/'))) {
        // Opciones con valor pegado o separado: se ignoran salvo las de ruta.
        if (/^-(e|f|g|m|A|B|C|-regexp|-file|-glob|-max-count)$/.test(arg)) {
          index += 1;
        }
        continue;
      }
      if (!skippedPattern) {
        skippedPattern = true;
        continue;
      }
      if (unverifiableArgument(arg)) {
        unverifiable = true;
        continue;
      }
      paths.push(arg);
    }
    reads.push({ program, action: reader.action, paths: unverifiable ? null : paths });
  }
  return reads;
}

/**
 * Decisión pura sobre una lectura reconocida. Sin política activa no decide nada; con ella, una coincidencia o un
 * destino no verificable se deniega en `enforce` y se permite con aviso en `shadow`.
 */
export function evaluateRead(read: RecognizedRead, mode: GuardMode, caseInsensitive: boolean): ReadDecision {
  let pattern: SensitivePattern | 'unverifiable' | null = null;
  if (read.targets === null || read.targets.some((target) => target.requested === null && target.real === null)) {
    pattern = 'unverifiable';
  } else {
    for (const target of read.targets) {
      for (const candidate of [target.requested, target.real]) {
        const found = candidate === null ? null : matchSensitive(candidate, caseInsensitive);
        if (found !== null) {
          pattern = found;
          break;
        }
      }
      if (pattern !== null) {
        break;
      }
    }
  }
  if (pattern === null) {
    return { decision: 'allow', warning: null, rule: null };
  }
  const rule = `read:${pattern}`;
  const what = pattern === 'unverifiable' ? 'destino no verificable' : `patrón ${pattern}`;
  if (mode === 'enforce') {
    return { decision: 'deny', warning: `${rule}: ${read.action} denegada (${what}, ${read.tool}); el destino y su contenido no se muestran`, rule };
  }
  return { decision: 'allow', warning: `[shadow] ${rule}: ${read.action} permitida con aviso (${what}, ${read.tool})`, rule };
}

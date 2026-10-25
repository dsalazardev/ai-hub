import type { GuardResult, PresetDangerPattern } from './types.js';

interface DangerRule {
  id: string;
  decision: 'ask' | 'deny';
  reason: string;
  matches: (command: string) => boolean;
}

/**
 * Removes single-, double- and backtick-quoted spans so literal examples such as
 * `echo "rm -rf /"` are not mistaken for commands.
 */
export function stripQuoted(command: string): string {
  return command.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
}

function hasRecursiveForceDelete(command: string): boolean {
  const unix = /\brm\s+((?:-[a-zA-Z-]+\s+)+)(\S.*)?$/i.exec(command);
  if (unix) {
    const flags = unix[1].toLowerCase();
    if (flags.includes('r') && flags.includes('f')) {
      return true;
    }
  }
  if (/\brm\s+(?:-[a-z-]*[rf][a-z-]*\s+){2,}\S/i.test(command)) {
    return true;
  }
  if (/\b(?:rmdir|rd)\s+\/s\b[^\n]*\/q\b/i.test(command)) {
    return true;
  }
  return /\bremove-item\b[^\n]*-recurse\b[^\n]*-force\b/i.test(command);
}

const RULES: DangerRule[] = [
  {
    id: 'danger:mkfs',
    decision: 'deny',
    reason: 'formatear un dispositivo destruye datos de forma irreversible; usa el disco o la ruta correcta y pide autorización humana.',
    matches: (command) => /\bmkfs(?:\.[a-z0-9]+)?\b/i.test(command),
  },
  {
    id: 'danger:raw-device-write',
    decision: 'deny',
    reason: 'escribir directamente en /dev/sd* o /dev/nvme* destruye el disco; revisa el destino antes de repetir.',
    matches: (command) =>
      /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd)/i.test(command) ||
      />\s*\/dev\/(?:sd|nvme|hd)/i.test(command),
  },
  {
    id: 'danger:fork-bomb',
    decision: 'deny',
    reason: 'la expresión es una fork bomb y agota el equipo; no se ejecuta.',
    matches: (command) => /:\s*\(\s*\)\s*\{[^}]*\|[^}]*\}\s*;\s*:/i.test(command),
  },
  {
    id: 'danger:recursive-force-delete',
    decision: 'ask',
    reason: 'un borrado recursivo y forzado no se puede deshacer; confirma la ruta exacta antes de continuar.',
    matches: hasRecursiveForceDelete,
  },
  {
    id: 'danger:force-push',
    decision: 'ask',
    reason: 'un push forzado reescribe historia remota; confirma la rama y avisa al equipo antes de continuar.',
    matches: (command) => /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/i.test(command),
  },
  {
    id: 'danger:hard-reset',
    decision: 'ask',
    reason: 'git reset --hard descarta cambios sin commit; guarda o confirma antes de continuar.',
    matches: (command) => /\bgit\s+reset\s+--hard\b/i.test(command),
  },
  {
    id: 'danger:git-clean',
    decision: 'ask',
    reason: 'git clean elimina archivos no rastreados; revisa la lista con --dry-run antes de continuar.',
    matches: (command) => /\bgit\s+clean\s+-[a-z]*[fd]/i.test(command),
  },
  {
    id: 'danger:discard-local-changes',
    decision: 'ask',
    reason: 'el comando descarta cambios locales; confirma que no hay trabajo sin guardar.',
    matches: (command) =>
      /\bgit\s+(?:checkout|restore)\s+--\s+\./i.test(command) ||
      /\bgit\s+restore\s+\./i.test(command),
  },
  {
    id: 'danger:pipe-to-shell',
    decision: 'ask',
    reason: 'ejecutar un script remoto sin revisarlo permite código arbitrario; descarga y revisa primero.',
    matches: (command) => /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i.test(command),
  },
  {
    id: 'danger:destructive-sql',
    decision: 'ask',
    reason: 'DROP o TRUNCATE elimina datos permanentemente; confirma la base y haz backup antes de continuar.',
    matches: (command) => /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i.test(command),
  },
  {
    id: 'danger:permissions-root',
    decision: 'ask',
    reason: 'chmod -R 777 sobre la raíz rompe la seguridad del sistema; aplica permisos mínimos.',
    matches: (command) => /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i.test(command),
  },
  {
    id: 'danger:power-state',
    decision: 'ask',
    reason: 'apagar o reiniciar el equipo interrumpe el trabajo en curso; confirma antes de continuar.',
    matches: (command) => /\b(?:shutdown|reboot|halt|poweroff)\b/i.test(command),
  },
  {
    id: 'danger:disk-partition',
    decision: 'deny',
    reason: 'reparticionar discos puede destruir el sistema; requiere intervención humana fuera del agente.',
    matches: (command) => /\b(?:fdisk|parted|diskpart)\b/i.test(command),
  },
  {
    id: 'danger:npm-token-leak',
    decision: 'ask',
    reason: 'el comando imprime o publica credenciales; revisa que no exponga secretos en logs.',
    matches: (command) => /\bnpm\s+token\s+(?:list|create|revoke)\b/i.test(command) || /\bcat\s+\.env\b/i.test(command),
  },
];

/**
 * Shells execute the string inside `bash -c "..."`, so that string must be judged
 * as a command, not as quoted prose. `echo "rm -rf /"` stays ignored.
 */
export function expandShell(command: string): string[] {
  const expanded: string[] = [];
  const shell = /\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+(["'])([\s\S]*?)\1/g;
  for (const match of command.matchAll(shell)) {
    if (match[2].trim() !== '') {
      expanded.push(match[2]);
    }
  }
  return expanded.length > 0 ? expanded : [command];
}

export function classifyDanger(
  command: string,
  extra: PresetDangerPattern[] = [],
): GuardResult | null {
  for (const segment of expandShell(command)) {
    const sanitized = stripQuoted(segment).replace(/\s+/g, ' ').trim();
    if (sanitized === '') {
      continue;
    }
    // Core rules run first: a preset may add stricter rules, never weaken one.
    for (const rule of RULES) {
      if (rule.matches(sanitized)) {
        return { decision: rule.decision, rule: rule.id, reason: rule.reason };
      }
    }
    for (const pattern of extra) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern.pattern, 'i');
      } catch {
        continue;
      }
      if (regex.test(sanitized)) {
        return {
          decision: pattern.decision,
          rule: `preset:${pattern.id}`,
          reason: pattern.reason,
        };
      }
    }
  }
  return null;
}

export const DANGER_RULE_IDS = RULES.map((rule) => rule.id);

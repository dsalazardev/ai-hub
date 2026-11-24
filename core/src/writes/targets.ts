/**
 * Registro de destinos de escritura (harden-harness-orchestration, R-031): cada archivo que el motor
 * escribe declara propiedad, sensibilidad y regenerabilidad como atributos independientes, con su
 * escritor y su retención. La sensibilidad se declara; una comprobación por nombre de clave solo
 * puede subirla, nunca bajarla, y jamás imprime valores.
 */

export type Ownership = 'foreign' | 'generated' | 'harness-state';
export type Sensitivity = 'public' | 'internal' | 'sensitive';

export interface TargetDeclaration {
  id: string;
  /** Patrón relativo a la raíz (separador `/`, `*` = un segmento, `**` = varios) o `external:<tipo>`. */
  pattern: string;
  ownership: Ownership;
  sensitivity: Sensitivity;
  /** Se puede regenerar desde las fuentes del motor. */
  regenerable: boolean;
  /** Módulo que lo escribe (ruta bajo `core/src`). */
  writers: readonly string[];
  /** Copias conservadas antes de reemplazar (0 = ninguna). */
  retention: number;
}

export const DEFAULT_BACKUP_RETENTION = 5;
export const MAX_BACKUP_RETENTION = 20;

export const TARGETS: readonly TargetDeclaration[] = [
  { id: 'root-gitignore', pattern: '.gitignore', ownership: 'foreign', sensitivity: 'internal', regenerable: false, writers: ['cli/onboarding.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'claude-settings', pattern: '.claude/settings.json', ownership: 'foreign', sensitivity: 'sensitive', regenerable: false, writers: ['sync/hooks.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'agents-md-region', pattern: 'AGENTS.md', ownership: 'foreign', sensitivity: 'internal', regenerable: false, writers: ['sync/sync.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'region-files', pattern: '**/AGENTS.md', ownership: 'foreign', sensitivity: 'internal', regenerable: false, writers: ['sync/sync.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'mcp-manifest', pattern: 'mcp-manifest.yaml', ownership: 'foreign', sensitivity: 'sensitive', regenerable: false, writers: ['adopt/convert.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'git-hooks', pattern: '.git/hooks/*', ownership: 'foreign', sensitivity: 'internal', regenerable: false, writers: ['cli/githooks.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'mcp-generated', pattern: '.mcp.json', ownership: 'generated', sensitivity: 'sensitive', regenerable: true, writers: ['sync/sync.ts'], retention: 0 },
  { id: 'mcp-generated-cursor', pattern: '.cursor/mcp.json', ownership: 'generated', sensitivity: 'sensitive', regenerable: true, writers: ['sync/sync.ts'], retention: 0 },
  { id: 'mcp-generated-vscode', pattern: '.vscode/mcp.json', ownership: 'generated', sensitivity: 'sensitive', regenerable: true, writers: ['sync/sync.ts'], retention: 0 },
  { id: 'sync-lock', pattern: 'sync.lock.json', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['sync/lock.ts'], retention: 0 },
  { id: 'opencode-plugin', pattern: '.opencode/plugins/ai-hub.js', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['sync/sync.ts'], retention: 0 },
  { id: 'generated-targets', pattern: 'external:sync-lock-listed', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['sync/sync.ts'], retention: 0 },
  { id: 'ci-templates', pattern: '.github/workflows/*', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['ci/templates.ts'], retention: 0 },
  { id: 'harness-env', pattern: '.ai-hub/.env', ownership: 'foreign', sensitivity: 'sensitive', regenerable: false, writers: ['cli/assistant.ts'], retention: 0 },
  { id: 'harness-gitignore', pattern: '.ai-hub/.gitignore', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['writes/credential-ignore.ts'], retention: 0 },
  { id: 'harness-preset', pattern: '.ai-hub/**', ownership: 'harness-state', sensitivity: 'internal', regenerable: true, writers: ['presets/materialize.ts'], retention: 0 },
  { id: 'manifest', pattern: 'manifest.yaml', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['manifest/write.ts'], retention: 0 },
  { id: 'engine-inventory', pattern: 'core/manifest.json', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['manifest/manifest.ts'], retention: 0 },
  { id: 'ai-hubrc', pattern: '.ai-hubrc.json', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['paths.ts'], retention: 0 },
  { id: 'decision-ledger', pattern: '.ai-hub/runs/control/decisions.jsonl', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['control/ledger.ts'], retention: 0 },
  { id: 'durable-state', pattern: '.ai-hub/runs/control/state/**', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['harness/state-store.ts'], retention: 0 },
  { id: 'poll-health', pattern: '.ai-hub/runs/health.json', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['control/health.ts'], retention: 0 },
  { id: 'poll-health-notice', pattern: '.ai-hub/runs/health.json.reported', ownership: 'harness-state', sensitivity: 'internal', regenerable: true, writers: ['control/health.ts'], retention: 0 },
  { id: 'run-telemetry', pattern: '.ai-hub/runs/*/events.jsonl', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['harness/runs.ts'], retention: 0 },
  { id: 'scope-snapshots', pattern: '.ai-hub/runs/scope/*', ownership: 'harness-state', sensitivity: 'internal', regenerable: true, writers: ['cli/hook.ts'], retention: 0 },
  { id: 'review-seal', pattern: '.ai-hub/runs/review-seal.json', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['cli/seal.ts'], retention: 0 },
  { id: 'review-panel', pattern: '.ai-hub/runs/review-panel.json', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['review/candidate.ts'], retention: 0 },
  { id: 'backlog-preprompt', pattern: 'backlog/pre-prompt.md', ownership: 'harness-state', sensitivity: 'internal', regenerable: true, writers: ['presets/materialize.ts'], retention: 0 },
  { id: 'devcontainer', pattern: '.devcontainer/devcontainer.json', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['ci/templates.ts'], retention: 0 },
  { id: 'gitlab-ci-template', pattern: '.gitlab-ci.ai-hub.yml', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['ci/templates.ts'], retention: 0 },
  { id: 'backlog-seed', pattern: 'backlog/seed.md', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['cli/assistant.ts'], retention: 0 },
  { id: 'snapshots', pattern: '.backups/**', ownership: 'harness-state', sensitivity: 'internal', regenerable: false, writers: ['backup/snapshots.ts'], retention: 0 },
  { id: 'hermes-profile-config', pattern: 'external:hermes-profile/config.yaml', ownership: 'foreign', sensitivity: 'sensitive', regenerable: false, writers: ['control/webhook-config.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'hermes-profile-env', pattern: 'external:hermes-profile/.env', ownership: 'foreign', sensitivity: 'sensitive', regenerable: false, writers: ['control/profile-env.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'hermes-profile-scripts', pattern: 'external:hermes-profile/scripts', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['control/scripts.ts'], retention: 1 },
  { id: 'hermes-profile-skill', pattern: 'external:hermes-profile/skills/ai-hub-control', ownership: 'generated', sensitivity: 'internal', regenerable: true, writers: ['control/scripts.ts'], retention: 1 },
  { id: 'hermes-profile-soul', pattern: 'external:hermes-profile/SOUL.md', ownership: 'foreign', sensitivity: 'internal', regenerable: false, writers: ['control/identity.ts'], retention: DEFAULT_BACKUP_RETENTION },
  { id: 'advisor-drafts', pattern: 'external:private/advisor-drafts', ownership: 'harness-state', sensitivity: 'sensitive', regenerable: false, writers: ['advisor/drafts.ts'], retention: 0 },
];

export class UndeclaredTargetError extends Error {
  constructor(
    readonly module: string,
    readonly target: string,
  ) {
    super(`destino no declarado: ${target} (escritor ${module}); declara propiedad, sensibilidad y regenerabilidad en writes/targets.ts`);
    this.name = 'UndeclaredTargetError';
  }
}

function patternToRegExp(pattern: string): RegExp {
  const parts = pattern.split('/');
  let source = '';
  parts.forEach((segment, index) => {
    const last = index === parts.length - 1;
    if (segment === '**') {
      source += last ? '.+' : '(?:[^/]+/)*';
      return;
    }
    source += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
    if (!last) {
      source += '/';
    }
  });
  return new RegExp(`^${source}$`);
}

/** Declaración más específica que cubre `relative` (las específicas van antes que los comodines). */
export function findTarget(relative: string): TargetDeclaration | null {
  const rel = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  const matches = TARGETS.filter((target) => !target.pattern.startsWith('external:') && patternToRegExp(target.pattern).test(rel));
  if (matches.length === 0) {
    return null;
  }
  return matches.sort((a, b) => specificity(b.pattern) - specificity(a.pattern))[0];
}

function specificity(pattern: string): number {
  return pattern.length - (pattern.split('*').length - 1) * 10;
}

export function externalTarget(id: string): TargetDeclaration {
  const target = TARGETS.find((item) => item.id === id && item.pattern.startsWith('external:'));
  if (!target) {
    throw new Error(`destino externo no declarado: ${id}`);
  }
  return target;
}

/** Destino declarado o error que nombra módulo y destino. */
export function requireTarget(module: string, relative: string): TargetDeclaration {
  const target = findTarget(relative);
  if (target === null) {
    throw new UndeclaredTargetError(module, relative);
  }
  return target;
}

const SECRET_KEY = /(^|[_.-])(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)([_.-]|$)/i;

/** Nombres de clave (nunca valores) que parecen secretos, en JSON, YAML o dotenv. */
export function secretLikeKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const match of content.matchAll(/"([A-Za-z0-9_.-]{1,80})"\s*:/g)) {
    keys.add(match[1]);
  }
  for (const match of content.matchAll(/^\s*(?:export\s+)?([A-Za-z0-9_.-]{1,80})\s*[:=]/gm)) {
    keys.add(match[1]);
  }
  return [...keys].filter((key) => SECRET_KEY.test(key));
}

const PLACEHOLDER = /^(|CHANGEME|changeme|<[^>]*>|x+|\*+|\$\{[^}]*\})$/;

/**
 * Claves con nombre de secreto cuyo valor no es un marcador (`CHANGEME`, vacío, `<…>`, `${…}`): un
 * `.env.example` con marcadores no eleva la sensibilidad; un valor real sí. Nunca devuelve valores.
 */
export function secretLikeValuedKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const match of content.matchAll(/"([A-Za-z0-9_.-]{1,80})"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (SECRET_KEY.test(match[1]) && !PLACEHOLDER.test(match[2].trim())) {
      keys.add(match[1]);
    }
  }
  for (const match of content.matchAll(/^\s*(?:export\s+)?([A-Za-z0-9_.-]{1,80})\s*[:=]\s*(.*)$/gm)) {
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (SECRET_KEY.test(match[1]) && !PLACEHOLDER.test(value)) {
      keys.add(match[1]);
    }
  }
  return [...keys];
}

/** Sensibilidad efectiva: la declarada, elevada a `sensitive` si una clave con nombre de secreto tiene valor real. */
export function effectiveSensitivity(target: TargetDeclaration, content: string | null): Sensitivity {
  if (target.sensitivity === 'sensitive' || content === null) {
    return target.sensitivity;
  }
  return secretLikeValuedKeys(content).length > 0 ? 'sensitive' : target.sensitivity;
}

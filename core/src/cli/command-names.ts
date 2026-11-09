/**
 * Nombres que `ai-hub` acepta como primer argumento: los comandos del catálogo más los de
 * compatibilidad. Es una hoja sin dependencias para que el gate de referencias del catálogo
 * (`engine/references.ts`) los conozca sin importar el despachador (evita un ciclo
 * run → doctor → gates → run). Un test exige que coincida con `COMMANDS` + `LEGACY_COMMANDS`.
 */
export const CLI_COMMAND_NAMES: readonly string[] = [
  'init',
  'install',
  'add',
  'sync',
  'drift',
  'list',
  'doctor',
  'check',
  'backups',
  'restore',
  'uninstall',
  'purge',
  'upgrade',
  'repair',
  'worktrees',
  'trunk',
  'memory',
  'context',
  'env',
  'ci',
  'hooks',
  'gate',
  'hook',
  'runs',
  'control',
  'review',
  'adopt',
  'seal',
  'verify',
  'judge',
];

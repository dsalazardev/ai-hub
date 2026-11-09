import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup } from '../backup/snapshots.js';
import { flagString, parseArgs } from '../cli/args.js';
import { diagnose } from '../cli/doctor.js';
import { cmdAdd } from '../cli/maintenance.js';
import { cmdInit, writeManifest } from '../cli/onboarding.js';
import type { CliContext, ParsedArgs } from '../cli/types.js';
import { isAreaRole, type AreaSpec } from '../engine/scopes.js';
import { loadManifestContext, writeInventory } from '../manifest/manifest.js';
import { runSync } from '../sync/sync.js';
import { isToolId } from '../sync/targets.js';
import { detectLegacy, LEGACY_CORE, LEGACY_LOCK, LEGACY_MANIFEST, LEGACY_MCP, type LegacyDetection } from './detect.js';
import { convertLegacyMcp } from './mcp.js';

/**
 * `ai-hub adopt` (factory-evolution E1, M-08, cierra F-16 por diseño): adopta un arnés heredado en
 * fases. F0 detecta y no escribe; F1 toma un snapshot ANTES de tocar nada y convierte; F2 deja la
 * metodología anterior en convivencia con caducidad; F3 retira el núcleo vendorizado y solo SUGIERE
 * cambios en archivos del usuario (`package.json`, `.githooks`); F4 verifica con doctor y drift.
 */
export const LEGACY_ARCHIVE_DIR = '.ai-hub/legacy';
const DEFAULT_COEXISTENCE_DAYS = 90;

/** Sustitutos sugeridos para los scripts `ai:*` del núcleo vendorizado. */
const SCRIPT_SUGGESTIONS: Record<string, string> = {
  'ai:setup': 'npx ai-hub install --yes',
  'ai:sync': 'npx ai-hub sync',
  'ai:check': 'npx ai-hub doctor',
  'ai:verify': 'npx ai-hub gate',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function plan(detection: LegacyDetection): string[] {
  const has = (id: string): boolean => detection.items.some((item) => item.id === id);
  return [
    'Plan de adopción (nada se ha escrito):',
    '  F0 detectar — solo lectura (este informe).',
    `  F1 convertir — snapshot en .backups/ primero; ${has('manifest-v1') ? 'manifiesto v1 → v2 (rule_sources → rules, agents.can_modify → paths.areas)' : 'manifiesto v2 nuevo'}; .ai-hubrc.json; ${has('harness-mcp') ? 'MCP de .ai-hub/ → mcp-manifest.yaml en la raíz' : 'sin MCP que mover'}; artefactos v1 archivados en ${LEGACY_ARCHIVE_DIR}/.`,
    `  F2 convivir — ${has('openspec') ? 'openspec/ queda como histórico de solo lectura; ' : ''}policy.legacy.openspec: archive con caducidad (los artefactos anteriores son aviso, no fallo, hasta la fecha).`,
    `  F3 retirar — ${has('vendored-core') ? `${LEGACY_CORE}/ se elimina (ya está en el snapshot); ` : ''}package.json y .githooks/ NO se editan: se imprime el diff sugerido.`,
    '  F4 verificar — doctor y drift.',
    'Repite con --yes para aplicar.',
  ];
}

/** Áreas desde el `agents.can_modify` v1 (`implementer-*: [ruta/**]`). */
export function areasFromLegacy(manifest: Record<string, unknown> | null): AreaSpec[] {
  const canModify = isRecord(manifest?.agents) && isRecord(manifest.agents.can_modify) ? manifest.agents.can_modify : {};
  const areas: AreaSpec[] = [];
  for (const [role, paths] of Object.entries(canModify)) {
    if (!isAreaRole(role) || !Array.isArray(paths)) {
      continue;
    }
    const clean = paths.filter((item): item is string => typeof item === 'string').map((item) => item.replace(/\/\*\*$/, ''));
    if (clean.length > 0) {
      areas.push({ id: role.replace(/^implementer-/, ''), paths: clean, role });
    }
  }
  return areas;
}

/** Reglas v1 (`rule_sources` dentro de `.ai-hub/rules/`) que pasan a `rules.publish`. */
export function rulesFromLegacy(manifest: Record<string, unknown> | null): string[] {
  const sources = Array.isArray(manifest?.rule_sources) ? manifest.rule_sources : [];
  return sources
    .filter((item): item is string => typeof item === 'string')
    .map((item) => /^\.ai-hub\/rules\/(.+)\.md$/.exec(item.replace(/\\/g, '/'))?.[1] ?? null)
    .filter((id): id is string => id !== null);
}

function targetsFromLegacy(manifest: Record<string, unknown> | null): string[] {
  const sync = isRecord(manifest?.sync) ? manifest.sync : {};
  return (Array.isArray(sync.targets) ? sync.targets : []).filter((item): item is string => typeof item === 'string' && isToolId(item));
}

function addDays(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

async function archive(root: string, rel: string, name: string): Promise<boolean> {
  const from = path.join(root, ...rel.split('/'));
  if (!(await exists(from))) {
    return false;
  }
  const to = path.join(root, ...LEGACY_ARCHIVE_DIR.split('/'), name);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return true;
}

export async function cmdAdopt(args: ParsedArgs, ctx: CliContext): Promise<number> {
  // adopt opera sobre el directorio actual: el manifiesto v1 de .ai-hub/ no debe resolverse como raíz.
  const root = ctx.cwd;
  const local: CliContext = { ...ctx, root };
  const detection = await detectLegacy(root);
  for (const item of detection.items) {
    ctx.io.out(`[DETECTADO] ${item.id}: ${item.path} — ${item.detail}`);
  }
  if (!detection.legacy) {
    ctx.io.err('no se detectó un arnés heredado (ni núcleo vendorizado ni manifiesto v1); usa ai-hub init');
    return 1;
  }
  if (args.flags['dry-run'] || !args.flags.yes) {
    for (const line of plan(detection)) {
      ctx.io.out(line);
    }
    return 0;
  }
  const until = flagString(args, 'legacy-until') ?? addDays(DEFAULT_COEXISTENCE_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    ctx.io.err('--legacy-until debe ser una fecha YYYY-MM-DD');
    return 2;
  }

  // F1 — snapshot ANTES de tocar nada (excluye .ai-hub/.env y .ai-hub/runs/).
  const snapshot = await createBackup(root, 'adopt');
  ctx.io.out(`[F1] snapshot ${snapshot.id} (${snapshot.files.length} archivos); ai-hub restore ${snapshot.id} lo revierte`);
  const legacyManifest = detection.manifest;
  await archive(root, LEGACY_MANIFEST, 'manifest.v1.yaml');
  await archive(root, LEGACY_LOCK, 'sync.lock.v1.json');
  let mcpSkills: string[] = [];
  const mcpText = await fs.readFile(path.join(root, ...LEGACY_MCP.split('/')), 'utf8').catch(() => null);
  if (mcpText !== null) {
    const converted = convertLegacyMcp(mcpText);
    mcpSkills = converted.skills;
    const rootMcp = path.join(root, 'mcp-manifest.yaml');
    if (!(await exists(rootMcp))) {
      await fs.writeFile(rootMcp, converted.yaml, 'utf8');
    }
    await archive(root, LEGACY_MCP, 'mcp-manifest.v1.yaml');
    ctx.io.out(
      `[F1] MCP → mcp-manifest.yaml: ${converted.servers.join(', ') || 'sin servidores'}${converted.dropped.length > 0 ? ` · sin equivalente: ${converted.dropped.join(', ')}` : ''}`,
    );
  }
  const initArgs: string[] = ['--yes', '--preset-only'];
  const preset = flagString(args, 'preset');
  if (preset !== null) {
    initArgs.push('--preset', preset);
  }
  const targets = targetsFromLegacy(legacyManifest);
  if (targets.length > 0) {
    initArgs.push('--targets', targets.join(','));
  }
  if (args.flags['no-speckit']) {
    initArgs.push('--no-speckit');
  }
  const initCode = await cmdInit(parseArgs(initArgs), local);
  if (initCode !== 0) {
    ctx.io.err(`[F1] init falló (exit ${initCode}); ai-hub restore ${snapshot.id} revierte la adopción`);
    return initCode;
  }
  const context = await loadManifestContext(root);
  const manifest = context.manifest;
  const legacyRules = [];
  for (const id of rulesFromLegacy(legacyManifest)) {
    if (await exists(path.join(root, manifest.rules.source, `${id}.md`))) {
      legacyRules.push(id);
    }
  }
  if (legacyRules.length > 0) {
    // Reglas propias del proyecto sobre las del preset: la selección deja de ser la del preset.
    manifest.rules.publish = [...new Set([...manifest.rules.publish, ...legacyRules])];
    manifest.rules.selection = 'custom';
  }
  const areas = areasFromLegacy(legacyManifest);
  if (areas.length > 0) {
    manifest.paths.areas = areas;
  }
  // F2 — convivencia con caducidad.
  manifest.policy.legacy = { openspec: 'archive', until };
  await writeManifest(root, manifest);
  await writeInventory(root);
  for (const skill of mcpSkills) {
    const code = await cmdAdd(parseArgs(['skill', skill]), local);
    ctx.io.out(`[F1] integración de tipo skill "${skill}": ${code === 0 ? 'publicada' : 'no está en el catálogo; revísala a mano'}`);
  }
  await runSync(root, { check: false });
  ctx.io.out(`[F2] convivencia hasta ${until}: los artefactos de la metodología anterior son aviso, no fallo; openspec/ queda como histórico`);

  // F3 — retirar el núcleo vendorizado; jamás editar archivos del usuario.
  const core = path.join(root, ...LEGACY_CORE.split('/'));
  if (await exists(core)) {
    await fs.rm(core, { recursive: true, force: true });
    ctx.io.out(`[F3] ${LEGACY_CORE}/ eliminado (está en el snapshot)`);
  }
  if (Object.keys(detection.scripts).length > 0) {
    ctx.io.out('[F3] package.json NO se edita. Diff sugerido de scripts:');
    for (const [name, command] of Object.entries(detection.scripts)) {
      ctx.io.out(`-   "${name}": ${JSON.stringify(command)},`);
      if (SCRIPT_SUGGESTIONS[name]) {
        ctx.io.out(`+   "${name}": ${JSON.stringify(SCRIPT_SUGGESTIONS[name])},`);
      }
    }
  }
  if (detection.items.some((item) => item.id === 'githooks')) {
    ctx.io.out('[F3] .githooks/ NO se edita; para el hook gestionado: npx ai-hub hooks install --pre-commit');
  }
  if (args.flags['archive-planning'] && (await exists(path.join(root, '.planning')))) {
    await fs.mkdir(path.join(root, '.ai-hub', 'work'), { recursive: true });
    await fs.rename(path.join(root, '.planning'), path.join(root, '.ai-hub', 'work', 'legacy-planning'));
    ctx.io.out('[F3] .planning/ archivado en .ai-hub/work/legacy-planning/');
  }

  // F4 — verificar.
  const drift = await runSync(root, { check: true });
  const report = await diagnose(local);
  const failing = report.checks.filter((check) => !check.ok);
  ctx.io.out(`[F4] drift: ${drift.problems.length === 0 ? 'sin deriva' : `${drift.problems.length} problemas`}`);
  ctx.io.out(`[F4] doctor: ${failing.length === 0 ? 'sano' : `fallan ${failing.map((check) => check.id).join(', ')}`}`);
  return drift.problems.length === 0 && failing.length === 0 ? 0 : 1;
}

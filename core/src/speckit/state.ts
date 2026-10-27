import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { TARGETS, isToolId, type SpeckitTarget, type ToolId } from '../sync/targets.js';
import type { SpeckitSettings } from './settings.js';

/**
 * Lectura de `.specify/` sin ejecutar Python. Los timestamps `installed_at` de los manifiestos
 * de integración y del registro de extensiones nunca se comparan ni se hashean.
 */
export const SPECIFY_DIR = '.specify';

export interface IntegrationManifest {
  integration: string;
  files: Record<string, string>;
}

export interface SpeckitState {
  present: boolean;
  initOptions: { speckit_version?: string; script?: string } | null;
  integration: { installed_integrations: string[]; default_integration?: string } | null;
  installedExtensions: string[];
  registry: Record<string, { version?: string; registered_commands?: Record<string, string[]> }>;
  manifests: IntegrationManifest[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function readSpeckitState(root: string): Promise<SpeckitState> {
  const dir = path.join(root, SPECIFY_DIR);
  const present = await exists(dir);
  const initRaw = await readJson(path.join(dir, 'init-options.json'));
  const integrationRaw = await readJson(path.join(dir, 'integration.json'));
  const registryRaw = await readJson(path.join(dir, 'extensions', '.registry'));
  const extensionsText = await fs.readFile(path.join(dir, 'extensions.yml'), 'utf8').catch(() => null);
  let installedExtensions: string[] = [];
  if (extensionsText !== null) {
    try {
      const parsed = parse(extensionsText) as unknown;
      if (isRecord(parsed) && Array.isArray(parsed.installed)) {
        installedExtensions = parsed.installed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      installedExtensions = [];
    }
  }
  const manifests: IntegrationManifest[] = [];
  const integrationsDir = path.join(dir, 'integrations');
  for (const name of (await fs.readdir(integrationsDir).catch(() => [])).sort()) {
    if (!name.endsWith('.manifest.json')) {
      continue;
    }
    const raw = await readJson(path.join(integrationsDir, name));
    if (isRecord(raw) && isRecord(raw.files)) {
      manifests.push({
        integration: typeof raw.integration === 'string' ? raw.integration : name.replace(/\.manifest\.json$/, ''),
        files: Object.fromEntries(
          Object.entries(raw.files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
      });
    }
  }
  const registry: SpeckitState['registry'] = {};
  if (isRecord(registryRaw) && isRecord(registryRaw.extensions)) {
    for (const [id, entry] of Object.entries(registryRaw.extensions)) {
      if (!isRecord(entry)) {
        continue;
      }
      const commands: Record<string, string[]> = {};
      if (isRecord(entry.registered_commands)) {
        for (const [integration, list] of Object.entries(entry.registered_commands)) {
          if (Array.isArray(list)) {
            commands[integration] = list.filter((item): item is string => typeof item === 'string');
          }
        }
      }
      registry[id] = {
        ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
        registered_commands: commands,
      };
    }
  }
  return {
    present,
    initOptions: isRecord(initRaw)
      ? {
          ...(typeof initRaw.speckit_version === 'string' ? { speckit_version: initRaw.speckit_version } : {}),
          ...(typeof initRaw.script === 'string' ? { script: initRaw.script } : {}),
        }
      : null,
    integration:
      isRecord(integrationRaw) && Array.isArray(integrationRaw.installed_integrations)
        ? {
            installed_integrations: integrationRaw.installed_integrations.filter(
              (item): item is string => typeof item === 'string',
            ),
            ...(typeof integrationRaw.default_integration === 'string'
              ? { default_integration: integrationRaw.default_integration }
              : {}),
          }
        : null,
    installedExtensions,
    registry,
    manifests,
  };
}

/** Ruta de un comando de Spec Kit en un destino: `<dir>/speckit-bug-assess/SKILL.md` o `<dir>/speckit.bug.assess.md`. */
export function commandPath(target: SpeckitTarget, canonical: string): string {
  return target.layout === 'skill-dir'
    ? `${target.commandsDir}/${canonical.replace(/\./g, '-')}/SKILL.md`
    : `${target.commandsDir}/${canonical}.md`;
}

/** Ids canónicos de los comandos de una extensión, leídos de `.specify/extensions/<id>/commands/`. */
export async function extensionCommands(root: string, extension: string): Promise<string[]> {
  const dir = path.join(root, SPECIFY_DIR, 'extensions', extension, 'commands');
  return (await fs.readdir(dir).catch(() => []))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

/** Destinos declarados que reciben Spec Kit, con su fila del registro. */
function enabledTargets(tools: readonly string[]): Array<[ToolId, SpeckitTarget]> {
  const rows: Array<[ToolId, SpeckitTarget]> = [];
  for (const tool of tools) {
    if (!isToolId(tool)) {
      continue;
    }
    const speckit = TARGETS[tool].speckit;
    if (speckit !== null) {
      rows.push([tool, speckit]);
    }
  }
  return rows;
}

/** `true` si la ruta cae en el espacio de nombres reservado de algún destino con Spec Kit declarado. */
export function inReservedNamespace(rel: string, tools: readonly string[]): boolean {
  return enabledTargets(tools).some(([, speckit]) => {
    const prefix = `${speckit.commandsDir}/`;
    if (!rel.startsWith(prefix)) {
      return false;
    }
    const name = rel.slice(prefix.length);
    return name.startsWith('speckit-') || name.startsWith('speckit.');
  });
}

/**
 * Rutas que pertenecen a Spec Kit (agent-guardrails "Every generated file has one owner"):
 * las de sus manifiestos de integración y los comandos de sus extensiones en cada destino con Spec Kit.
 * El espacio de nombres reservado se evalúa aparte con `inReservedNamespace`.
 */
export async function speckitOwnedPaths(root: string, tools: readonly string[]): Promise<Set<string>> {
  const owned = new Set<string>();
  const state = await readSpeckitState(root);
  if (!state.present) {
    return owned;
  }
  for (const manifest of state.manifests) {
    for (const rel of Object.keys(manifest.files)) {
      owned.add(rel);
    }
  }
  const extensions = new Set([...state.installedExtensions, ...Object.keys(state.registry)]);
  for (const extension of extensions) {
    const commands = await extensionCommands(root, extension);
    for (const [, speckit] of enabledTargets(tools)) {
      for (const canonical of commands) {
        owned.add(commandPath(speckit, canonical));
      }
    }
  }
  return owned;
}

/** Decide si una ruta es de Spec Kit, sea por manifiesto, por extensión o por espacio de nombres. */
export function ownedBySpeckit(rel: string, owned: Set<string>, tools: readonly string[], present: boolean): boolean {
  return owned.has(rel) || (present && inReservedNamespace(rel, tools));
}

/** speckit:integrations — exactamente las integraciones de los destinos declarados, sin Copilot. */
export function checkIntegrations(settings: SpeckitSettings, state: SpeckitState): string[] {
  if (state.integration === null) {
    return ['falta .specify/integration.json'];
  }
  const problems: string[] = [];
  const installed = state.integration.installed_integrations;
  for (const [index, integration] of settings.integrations.entries()) {
    if (!installed.includes(integration)) {
      problems.push(`${settings.targets[index]}: falta la integración ${integration}`);
    }
  }
  for (const integration of installed) {
    if (!settings.integrations.includes(integration)) {
      problems.push(
        integration === 'copilot'
          ? 'copilot: integración instalada aunque Copilot no recibe Spec Kit; ejecuta specify integration uninstall copilot'
          : `integración no declarada: ${integration}`,
      );
    }
  }
  if (settings.defaultIntegration !== null && state.integration.default_integration !== settings.defaultIntegration) {
    problems.push(
      `integración por defecto ${state.integration.default_integration ?? '(ninguna)'}; se esperaba ${settings.defaultIntegration}`,
    );
  }
  return problems;
}

/** speckit:extensions — extensiones fijadas, con su versión y sus comandos en cada destino con Spec Kit. */
export async function checkExtensions(
  root: string,
  settings: SpeckitSettings,
  state: SpeckitState,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [extension, version] of Object.entries(settings.extensions).sort()) {
    if (!state.installedExtensions.includes(extension)) {
      problems.push(`${extension}: extensión no instalada`);
      continue;
    }
    const registered = state.registry[extension]?.version;
    if (registered !== version) {
      problems.push(`${extension}: versión ${registered ?? '(desconocida)'}; se esperaba ${version}`);
    }
    const commands = await extensionCommands(root, extension);
    if (commands.length === 0) {
      problems.push(`${extension}: no hay comandos en .specify/extensions/${extension}/commands`);
      continue;
    }
    for (const tool of settings.targets) {
      const speckit = TARGETS[tool].speckit;
      if (speckit === null) {
        continue;
      }
      // Un mensaje por extensión y destino, para que el informe nombre todos los destinos afectados.
      const registeredFor = state.registry[extension]?.registered_commands?.[speckit.integration] ?? [];
      const unregistered: string[] = [];
      const absent: string[] = [];
      for (const canonical of commands) {
        if (!registeredFor.includes(canonical)) {
          unregistered.push(canonical);
        } else if (!(await exists(path.join(root, ...commandPath(speckit, canonical).split('/'))))) {
          absent.push(canonical);
        }
      }
      if (unregistered.length > 0) {
        problems.push(`${extension}: ${tool} (${speckit.integration}) no tiene registrados ${unregistered.join(', ')}`);
      }
      if (absent.length > 0) {
        problems.push(`${extension}: ${tool} no tiene en ${speckit.commandsDir} ${absent.join(', ')}`);
      }
    }
  }
  return problems;
}

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface IntegrityReport {
  missing: string[];
  modified: string[];
  checked: number;
}

/**
 * speckit:integrity — cada ruta de los manifiestos de integración existe y conserva su hash.
 * Un archivo con finales de línea CRLF (autocrlf de git) se compara también normalizado a LF.
 */
export async function checkIntegrity(root: string, state: SpeckitState): Promise<IntegrityReport> {
  const missing: string[] = [];
  const modified: string[] = [];
  let checked = 0;
  for (const manifest of state.manifests) {
    for (const [rel, expected] of Object.entries(manifest.files).sort()) {
      checked += 1;
      const bytes = await fs.readFile(path.join(root, ...rel.split('/'))).catch(() => null);
      if (bytes === null) {
        missing.push(rel);
        continue;
      }
      if (sha(bytes) !== expected && sha(bytes.toString('utf8').replace(/\r\n/g, '\n')) !== expected) {
        modified.push(rel);
      }
    }
  }
  return { missing: [...new Set(missing)].sort(), modified: [...new Set(modified)].sort(), checked };
}

/** speckit:constitution — `true` si la constitución sigue siendo la plantilla. */
export async function constitutionIsTemplate(root: string): Promise<boolean | null> {
  const memory = path.join(root, SPECIFY_DIR, 'memory');
  const marker = await readJson(path.join(memory, '.constitution-template.json'));
  const constitution = await fs.readFile(path.join(memory, 'constitution.md')).catch(() => null);
  if (constitution === null) {
    return null;
  }
  if (!isRecord(marker) || typeof marker.sha256 !== 'string') {
    return false;
  }
  return sha(constitution) === marker.sha256 || sha(constitution.toString('utf8').replace(/\r\n/g, '\n')) === marker.sha256;
}

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { EngineManifest, SpeckitScript } from '../engine/engine.js';
import type { ProjectManifest } from '../manifest/manifest.js';
import { readLock } from '../sync/lock.js';
import { probeShell, type ShellProbe } from './commands.js';
import type { ProcessRunner } from './runner.js';
import { effectiveSpeckit } from './settings.js';
import { satisfiesRange } from './version.js';
import {
  checkExtensions,
  checkIntegrations,
  checkIntegrity,
  constitutionIsTemplate,
  inReservedNamespace,
  readSpeckitState,
  speckitOwnedPaths,
} from './state.js';

export interface SpeckitCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Ids de los checks de Spec Kit, en el orden en que `doctor` los imprime. */
export const SPECKIT_CHECK_IDS = [
  'speckit:managed',
  'speckit:installed',
  'speckit:version',
  'speckit:script',
  'speckit:shell',
  'speckit:integrations',
  'speckit:extensions',
  'speckit:integrity',
  'speckit:collision',
  'speckit:constitution',
  'speckit:versioning',
] as const;

/** Estado de Spec Kit que el consumidor debe versionar: si git lo ignora, se pierde. */
const VERSIONED_STATE = ['.specify/memory/constitution.md', '.specify/init-options.json', 'specs/'];

function list(items: string[], limit = 5): string {
  return items.slice(0, limit).join('; ') + (items.length > limit ? ` (+${items.length - limit})` : '');
}

/** Detalle del check `speckit:shell`: distingue el shell resuelto fuera del PATH del que está en el PATH. */
export function speckitShellDetail(probe: ShellProbe, script: SpeckitScript): string {
  if (probe.ok) {
    return path.isAbsolute(probe.command)
      ? `${probe.command} (resuelto fuera del PATH) ejecuta los scripts ${script}`
      : `${probe.command} ejecuta los scripts ${script}`;
  }
  return script === 'ps'
    ? `PowerShell no ejecuta (probados: ${probe.tried.join(', ')}); instala PowerShell, o ejecuta ai-hub install --script sh`
    : `bash no está disponible o no ejecuta (probados: ${probe.tried.join(', ')}); en Windows instala Git for Windows, o ejecuta ai-hub install --script ps`;
}

function gitIgnored(root: string, rel: string): boolean | null {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', shell: false });
  if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') {
    return null;
  }
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: root, encoding: 'utf8', shell: false });
  return result.status === 0;
}

/** Checks de doctor para una instalación (dev-cli "Doctor verifies the Spec Kit installation"). */
export async function speckitDoctorChecks(
  root: string,
  manifest: ProjectManifest,
  engine: EngineManifest,
  runner: ProcessRunner,
): Promise<SpeckitCheck[]> {
  const checks: SpeckitCheck[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const settings = effectiveSpeckit(manifest, engine);
  const copilot = manifest.targets.includes('copilot');

  if (!settings.managed) {
    add(
      'speckit:managed',
      false,
      'degradado: speckit.managed es false (--no-speckit); ejecuta ai-hub install para instalar Spec Kit',
    );
    for (const id of SPECKIT_CHECK_IDS.slice(1)) {
      add(id, true, 'no aplica: Spec Kit no gestionado');
    }
    return checks;
  }
  add('speckit:managed', true, `gestionado: ${settings.package} ${settings.supported} vía uvx`);

  const state = await readSpeckitState(root);
  add(
    'speckit:installed',
    state.initOptions !== null,
    state.initOptions !== null ? '.specify/init-options.json presente' : 'falta .specify/init-options.json; ejecuta ai-hub install',
  );

  // speckit:version (design D4): la instalada debe caer dentro del rango soportado.
  const installed = state.initOptions?.speckit_version;
  const inRange = installed !== undefined && satisfiesRange(installed, settings.supported);
  add(
    'speckit:version',
    inRange,
    inRange
      ? `${installed} dentro del rango ${settings.supported}`
      : `instalada ${installed ?? '(ninguna)'}; se admite el rango ${settings.supported}; ejecuta ai-hub install`,
  );

  // speckit:script (design D7): el manifest y la instalación deben declarar el mismo script.
  const installedScript = state.initOptions?.script ?? null;
  add(
    'speckit:script',
    state.initOptions === null || installedScript === settings.script,
    state.initOptions === null
      ? 'no aplica: falta .specify/init-options.json'
      : installedScript === settings.script
        ? `manifest e instalación coinciden: ${settings.script}`
        : `desvío: manifest ${settings.script}, instalación ${installedScript}; ejecuta ai-hub install`,
  );

  const shell = await probeShell(settings, runner, root);
  add('speckit:shell', shell.ok, speckitShellDetail(shell, settings.script));

  const integrations = checkIntegrations(settings, state);
  add(
    'speckit:integrations',
    integrations.length === 0,
    integrations.length === 0
      ? `${settings.integrations.join(', ')} (por defecto ${settings.defaultIntegration ?? '-'})`
      : list(integrations),
  );
  if (copilot) {
    add('speckit:targets', true, 'copilot: sin Spec Kit (recibe agentes y reglas de AI-Hub; sus comandos se ejecutan en otro destino)');
  }

  const extensions = await checkExtensions(root, settings, state);
  add(
    'speckit:extensions',
    extensions.length === 0,
    extensions.length === 0
      ? Object.entries(settings.extensions)
          .map(([id, version]) => `${id} ${version}`)
          .join(', ') + ` en ${settings.targets.length} destinos`
      : list(extensions),
  );

  const integrity = await checkIntegrity(root, state);
  add(
    'speckit:integrity',
    integrity.missing.length === 0,
    integrity.missing.length > 0
      ? `faltan ${integrity.missing.length} archivos de Spec Kit: ${list(integrity.missing)}; ejecuta ai-hub install`
      : integrity.modified.length > 0
        ? `aviso: ${integrity.modified.length} archivos de Spec Kit modificados; el próximo init los sobrescribe (usa overrides): ${list(integrity.modified)}`
        : `${integrity.checked} archivos de Spec Kit íntegros`,
  );

  const owned = await speckitOwnedPaths(root, manifest.targets);
  const lock = await readLock(root).catch(() => null);
  const shared = Object.keys(lock?.files ?? {})
    .filter((rel) => owned.has(rel) || (state.present && inReservedNamespace(rel, manifest.targets)))
    .sort();
  add(
    'speckit:collision',
    shared.length === 0,
    shared.length === 0 ? 'ninguna ruta de sync.lock.json pertenece a Spec Kit' : `rutas compartidas con Spec Kit: ${list(shared)}`,
  );

  const template = await constitutionIsTemplate(root);
  add(
    'speckit:constitution',
    true,
    template === true
      ? 'aviso: la constitución sigue siendo la plantilla; ejecuta /speckit.constitution'
      : template === null
        ? 'aviso: no hay .specify/memory/constitution.md'
        : 'constitución propia del proyecto',
  );

  const ignored = VERSIONED_STATE.filter((rel) => gitIgnored(root, rel) === true);
  const applicable = gitIgnored(root, VERSIONED_STATE[0]) !== null;
  add(
    'speckit:versioning',
    ignored.length === 0,
    !applicable
      ? 'no aplica (sin repositorio git)'
      : ignored.length === 0
        ? 'constitución, init-options.json y specs/ versionables'
        : `git ignora estado del proyecto: ${ignored.join(', ')}; quítalo de .gitignore`,
  );
  return checks;
}

/** En el checkout del motor los checks de Spec Kit no aplican: su .specify/ es del mantenedor. */
export function speckitNotApplicable(): SpeckitCheck[] {
  return SPECKIT_CHECK_IDS.map((id) => ({ id, ok: true, detail: 'no aplica en el checkout del motor' }));
}

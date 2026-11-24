import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Almacenamiento privado validado (R-039): única custodia de copias de destinos sensibles.
 * Se configura explícitamente por host con `AI_HUB_PRIVATE_DIR` (nunca en el repositorio), debe
 * quedar fuera del repositorio y de carpetas sincronizadas detectadas, y su acceso se verifica:
 * modo 700 y dueño en POSIX; en Windows, la lista de acceso solo con el usuario y cuentas del
 * sistema (SYSTEM, Administradores). La confirmación de una persona no cuenta como verificación.
 */

export const PRIVATE_DIR_ENV = 'AI_HUB_PRIVATE_DIR';
const SYSTEM_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const SYNC_SEGMENTS = ['onedrive', 'dropbox', 'google drive', 'googledrive', 'icloud drive', 'iclouddrive', 'icloud', 'box sync', 'mega'];

export type PrivateStorageResult =
  | { ok: true; dir: string }
  | { ok: false; reason: 'private_storage_unconfigured' | 'private_storage_invalid'; detail: string };

export interface AclEntry {
  sid: string;
  allow: boolean;
}

export interface PrivateStorageHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** SID del usuario actual (Windows). */
  userSid?: () => string | null;
  /** Lista de acceso por SID (Windows); `null` si no se puede leer. */
  readAcl?: (dir: string) => AclEntry[] | null;
  uid?: () => number | null;
}

function windowsPowerShell(script: string): string | null {
  // Sin el PSModulePath heredado: desde PowerShell 7, Windows PowerShell 5.1 no carga sus módulos.
  const env = { ...process.env };
  delete env.PSModulePath;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, env });
  return result.status === 0 ? result.stdout : null;
}

export function defaultHost(): PrivateStorageHost {
  return {
    platform: process.platform,
    env: process.env,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    userSid: () => windowsPowerShell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')?.trim() || null,
    readAcl: (dir) => {
      const escaped = dir.replace(/'/g, "''");
      const out = windowsPowerShell(
        // API .NET directa (sin el módulo de Get-Acl) y por SID, independiente del idioma.
        `([System.IO.DirectoryInfo]::new('${escaped}')).GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + '|' + $_.AccessControlType }`,
      );
      if (out === null) {
        return null;
      }
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [sid, type] = line.split('|');
          return { sid, allow: type === 'Allow' };
        });
    },
  };
}

/** ¿Está dentro de una carpeta sincronizada detectable (OneDrive, Dropbox, iCloud…)? */
export function detectSyncedFolder(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const resolved = path.resolve(target).toLowerCase();
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const base = env[key];
    if (base && (resolved === path.resolve(base).toLowerCase() || resolved.startsWith(`${path.resolve(base).toLowerCase()}${path.sep}`))) {
      return key;
    }
  }
  for (const segment of resolved.split(/[\\/]/)) {
    const name = segment.trim();
    const hit = SYNC_SEGMENTS.find((sync) => name === sync || name.startsWith(`${sync} -`) || name.startsWith(`${sync}-`));
    if (hit) {
      return segment;
    }
  }
  return null;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function resolvePrivateStorage(root: string, host: PrivateStorageHost = defaultHost()): Promise<PrivateStorageResult> {
  const configured = host.env[PRIVATE_DIR_ENV];
  if (!configured || configured.trim() === '') {
    return { ok: false, reason: 'private_storage_unconfigured', detail: `configura ${PRIVATE_DIR_ENV} con una carpeta privada fuera del repositorio` };
  }
  if (!path.isAbsolute(configured)) {
    return { ok: false, reason: 'private_storage_invalid', detail: `${PRIVATE_DIR_ENV} debe ser una ruta absoluta` };
  }
  const dir = path.resolve(configured);
  if (inside(dir, root)) {
    return { ok: false, reason: 'private_storage_invalid', detail: `${PRIVATE_DIR_ENV} está dentro del repositorio` };
  }
  const synced = detectSyncedFolder(dir, host.env);
  if (synced !== null) {
    return { ok: false, reason: 'private_storage_invalid', detail: `${PRIVATE_DIR_ENV} está dentro de una carpeta sincronizada (${synced})` };
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (host.platform === 'win32') {
    const acl = host.readAcl?.(dir) ?? null;
    const user = host.userSid?.() ?? null;
    if (acl === null || user === null) {
      return { ok: false, reason: 'private_storage_invalid', detail: 'no se pudo leer la lista de acceso de la carpeta privada' };
    }
    const foreign = acl.filter((entry) => entry.allow && entry.sid !== user && !SYSTEM_SIDS.has(entry.sid));
    if (foreign.length > 0) {
      return { ok: false, reason: 'private_storage_invalid', detail: `la carpeta privada concede acceso a ${foreign.length} identidad(es) además del usuario y el sistema` };
    }
    return { ok: true, dir };
  }
  const stat = await fs.stat(dir);
  const uid = host.uid?.() ?? null;
  if ((stat.mode & 0o077) !== 0) {
    return { ok: false, reason: 'private_storage_invalid', detail: `la carpeta privada tiene permisos ${(stat.mode & 0o777).toString(8)}; se exige 700` };
  }
  if (uid !== null && stat.uid !== uid) {
    return { ok: false, reason: 'private_storage_invalid', detail: 'la carpeta privada pertenece a otro usuario' };
  }
  return { ok: true, dir };
}

/** Ruta privada de una copia: nombre derivado de la ruta canónica, sin exponer el contenido. */
export function privateCopyName(canonical: string, basename: string): string {
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, '_');
  let hash = 0;
  for (const char of canonical) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${safe}`;
}

export { os as _os };

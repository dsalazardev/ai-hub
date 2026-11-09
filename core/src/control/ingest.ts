import { createHash } from 'node:crypto';
import { loadManifestContext } from '../manifest/manifest.js';
import { requireSettings, runDecide } from './decide.js';
import { hasSeenEvent, openDecisionsFor, readDecisions, recordEvent, recordStatus } from './ledger.js';
import type { DecisionView } from './render.js';
import { GitlabTracker, defaultTrackerFetch, type TrackerFetch } from './tracker.js';

/**
 * `ai-hub control ingest`: un evento de GitLab (payload por stdin, desde el route script de Hermes, sin LLM)
 * → decisiones nuevas. Solo eventos de issues y merge requests del proyecto configurado; deduplica por
 * contenido; un cambio manual de etiqueta supersede lo pendiente de esa issue (manda GitLab).
 */
export const INGEST_KINDS = ['issue', 'merge_request'] as const;

export interface IngestOptions {
  trackerFetch?: TrackerFetch;
  now?: Date;
  limit?: number;
}

export interface IngestResult {
  outcome: 'ignored' | 'duplicate' | 'processed';
  expire: 'block' | 'notify';
  reason?: string;
  superseded: string[];
  fresh: DecisionView[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function labelTitles(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((label) => (typeof label === 'string' ? label : record(label).title))
    .filter((title): title is string => typeof title === 'string')
    .sort();
}

/** Clave de deduplicación por contenido: el route script no recibe las cabeceras de entrega. */
export function eventKey(payload: Record<string, unknown>): string {
  const attributes = record(payload.object_attributes);
  const canon = JSON.stringify([
    payload.object_kind ?? null,
    attributes.id ?? null,
    attributes.updated_at ?? null,
    attributes.action ?? null,
    labelTitles(payload.labels),
    labelTitles(record(record(payload.changes).labels).current),
  ]);
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

function sameProject(payload: Record<string, unknown>, configured: string): boolean {
  const project = record(payload.project);
  return project.path_with_namespace === configured || (typeof project.id === 'number' && String(project.id) === configured);
}

export async function runIngest(root: string, text: string, options: IngestOptions = {}): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const ignored = (reason: string): IngestResult => ({ outcome: 'ignored', expire: 'block', reason, superseded: [], fresh: [] });
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(text));
  } catch {
    return ignored('invalid_payload');
  }
  const kind = payload.object_kind;
  if (typeof kind !== 'string' || !(INGEST_KINDS as readonly string[]).includes(kind)) {
    return ignored('event_kind');
  }
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  const tracker = await GitlabTracker.fromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch);
  if (!sameProject(payload, tracker.projectPath)) {
    return { ...ignored('foreign_project'), expire: settings.expire };
  }
  const key = eventKey(payload);
  if (await hasSeenEvent(root, key)) {
    return { outcome: 'duplicate', expire: settings.expire, superseded: [], fresh: [] };
  }
  await recordEvent(root, key, now);
  const superseded: string[] = [];
  const attributes = record(payload.object_attributes);
  const iid = kind === 'issue' && typeof attributes.iid === 'number' ? attributes.iid : undefined;
  const labelChange = record(record(payload.changes).labels);
  const author = record(payload.user).id;
  if (iid !== undefined && Object.keys(labelChange).length > 0 && author !== (await tracker.currentUserId())) {
    // GitLab manda: una tarjeta movida a mano invalida todo lo pendiente de esa issue.
    for (const open of openDecisionsFor(await readDecisions(root), iid)) {
      await recordStatus(root, open.id, 'superseded', now, { reason: 'manual_label_change' });
      superseded.push(open.id);
    }
  }
  const { fresh } = await runDecide(root, {
    online: true,
    ...(iid !== undefined ? { issue: iid } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.trackerFetch ? { trackerFetch: options.trackerFetch } : {}),
    now,
  });
  return { outcome: 'processed', expire: settings.expire, superseded, fresh };
}

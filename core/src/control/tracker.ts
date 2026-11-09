import { readHarnessEnv } from '../env/dotenv.js';
import type { ProjectManifest } from '../manifest/manifest.js';

/**
 * Cliente mínimo de GitLab v4 para el plano de control. Solo conoce las peticiones que el contrato
 * permite: lecturas, la actualización de etiquetas de una issue existente y notas. El token se lee de
 * `.ai-hub/.env` dentro del proceso y viaja solo en la cabecera; nunca en la URL, un mensaje o un error.
 */
export type TrackerMethod = 'GET' | 'PUT' | 'POST';

export interface TrackerResponse {
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}

export type TrackerFetch = (
  url: string,
  init: { method?: TrackerMethod; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<TrackerResponse>;

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

export interface TrackerIssue {
  iid: number;
  title: string;
  labels: string[];
  description: string;
}

export interface TrackerNote {
  id: number;
  body: string;
  authorId: number | null;
}

export interface TrackerMergeRequest {
  iid: number;
}

const TIMEOUT_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toIssue(raw: unknown): TrackerIssue {
  const data = asRecord(raw);
  return {
    iid: typeof data.iid === 'number' ? data.iid : Number.NaN,
    title: typeof data.title === 'string' ? data.title : '',
    labels: asList(data.labels).filter((label): label is string => typeof label === 'string'),
    description: typeof data.description === 'string' ? data.description : '',
  };
}

function toNote(raw: unknown): TrackerNote {
  const data = asRecord(raw);
  const author = asRecord(data.author);
  return {
    id: typeof data.id === 'number' ? data.id : 0,
    body: typeof data.body === 'string' ? data.body : '',
    authorId: typeof author.id === 'number' ? author.id : null,
  };
}

/** `grupo/proyecto` se codifica; un id numérico o una ruta ya codificada se usan tal cual. */
export function projectSegment(project: string): string {
  return project.includes('/') ? encodeURIComponent(project) : project;
}

export class GitlabTracker {
  private userId: number | null = null;

  constructor(
    private readonly base: string,
    private readonly project: string,
    private readonly token: string,
    private readonly doFetch: TrackerFetch,
  ) {}

  /** Construye el cliente desde `manifest.tracker` y `.ai-hub/.env`; los errores nombran claves, nunca valores. */
  static async fromHarness(root: string, manifest: ProjectManifest, doFetch: TrackerFetch): Promise<GitlabTracker> {
    const tracker = manifest.tracker;
    if (!tracker) {
      throw new TrackerError('el plano de control necesita manifest.tracker', null);
    }
    const env = (await readHarnessEnv(root)) ?? {};
    const missing = [tracker.urlEnv, tracker.tokenEnv, 'GITLAB_PROJECT_PATH'].filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new TrackerError(`faltan en .ai-hub/.env: ${missing.join(', ')}`, null);
    }
    return new GitlabTracker(env[tracker.urlEnv], env.GITLAB_PROJECT_PATH, env[tracker.tokenEnv], doFetch);
  }

  /** Identidad del proyecto configurado (para filtrar eventos): ruta decodificada. */
  get projectPath(): string {
    return decodeURIComponent(this.project);
  }

  private url(pathname: string): string {
    return `${this.base.replace(/\/+$/, '')}/api/v4/projects/${projectSegment(this.project)}${pathname}`;
  }

  private async request(method: TrackerMethod, url: string, body?: Record<string, unknown>): Promise<unknown> {
    let response: TrackerResponse;
    try {
      response = await this.doFetch(url, {
        method,
        headers: { 'PRIVATE-TOKEN': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new TrackerError(`el tracker no responde (${method} ${redactPath(url)})`, null);
    }
    if (response.status === 429) {
      const raw = response.headers?.get('Retry-After') ?? null;
      const retryAfter = raw !== null && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
      throw new TrackerError(
        `el tracker limitó la petición (HTTP 429)${retryAfter !== null ? `; reintenta en ${retryAfter} s (Retry-After)` : ''}`,
        429,
        retryAfter,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TrackerError(`el tracker respondió HTTP ${response.status} (${method} ${redactPath(url)})`, response.status);
    }
    return response.json();
  }

  async currentUserId(): Promise<number | null> {
    if (this.userId === null) {
      const data = asRecord(await this.request('GET', `${this.base.replace(/\/+$/, '')}/api/v4/user`));
      this.userId = typeof data.id === 'number' ? data.id : null;
    }
    return this.userId;
  }

  /** Issues abiertas con alguna etiqueta `ai::` (el tablero). */
  async labelledIssues(): Promise<TrackerIssue[]> {
    const raw = await this.request('GET', this.url('/issues?state=opened&per_page=100'));
    return asList(raw)
      .map(toIssue)
      .filter((issue) => Number.isInteger(issue.iid) && issue.labels.some((label) => label.startsWith('ai::')));
  }

  async issue(iid: number): Promise<TrackerIssue> {
    return toIssue(await this.request('GET', this.url(`/issues/${iid}`)));
  }

  async issuesWithLabel(label: string): Promise<TrackerIssue[]> {
    const raw = await this.request('GET', this.url(`/issues?state=opened&per_page=100&labels=${encodeURIComponent(label)}`));
    return asList(raw).map(toIssue);
  }

  async issueNotes(iid: number): Promise<TrackerNote[]> {
    return asList(await this.request('GET', this.url(`/issues/${iid}/notes?sort=asc&order_by=created_at&per_page=100`))).map(toNote);
  }

  async relatedMergeRequests(iid: number): Promise<TrackerMergeRequest[]> {
    return asList(await this.request('GET', this.url(`/issues/${iid}/related_merge_requests`)))
      .map((raw) => ({ iid: Number(asRecord(raw).iid) }))
      .filter((mr) => Number.isInteger(mr.iid));
  }

  async mergeRequestNotes(iid: number): Promise<TrackerNote[]> {
    return asList(await this.request('GET', this.url(`/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=100`))).map(toNote);
  }

  /** Estado del pipeline más reciente del MR (`success`, `failed`…), o `null` si no hay. */
  async latestPipelineStatus(iid: number): Promise<string | null> {
    const first = asRecord(asList(await this.request('GET', this.url(`/merge_requests/${iid}/pipelines`)))[0]);
    return typeof first.status === 'string' ? first.status : null;
  }

  /** Única escritura de etiquetas: añade el destino y retira los demás `ai::` en la misma petición. */
  async moveLabel(iid: number, add: string, remove: string[]): Promise<void> {
    await this.request('PUT', this.url(`/issues/${iid}`), {
      add_labels: add,
      ...(remove.length > 0 ? { remove_labels: remove.join(',') } : {}),
    });
  }

  async postIssueNote(iid: number, body: string): Promise<void> {
    await this.request('POST', this.url(`/issues/${iid}/notes`), { body });
  }
}

/** Ruta de la petición sin host ni query, para mensajes de error. */
function redactPath(url: string): string {
  const match = /\/api\/v4\/projects\/[^/]+(\/[^?]*)/.exec(url);
  return match ? match[1] : '/api/v4';
}

export const defaultTrackerFetch: TrackerFetch = (url, init) => fetch(url, init);

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

/** Clases de fallo del tracker (R-015); `incomplete` = lectura paginada que no se pudo completar (R-014). */
export type TrackerFailureClass = 'network' | 'timeout' | 'http_4xx' | 'http_5xx' | 'auth' | 'rate_limit' | 'incomplete' | 'parse' | 'config';

export interface TrackerFailureDetail {
  failureClass: TrackerFailureClass;
  method?: TrackerMethod;
  /** Ruta saneada: sin host, credenciales ni query. */
  target?: string;
  durationMs?: number;
}

export class TrackerError extends Error {
  readonly failureClass: TrackerFailureClass;
  readonly method: TrackerMethod | null;
  readonly target: string | null;
  readonly durationMs: number | null;
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfter: number | null = null,
    detail: TrackerFailureDetail = { failureClass: status === null ? 'config' : classifyStatus(status) },
  ) {
    super(message);
    this.name = 'TrackerError';
    this.failureClass = detail.failureClass;
    this.method = detail.method ?? null;
    this.target = detail.target ?? null;
    this.durationMs = detail.durationMs ?? null;
  }
}

export function classifyStatus(status: number): TrackerFailureClass {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

/** Solo lecturas transitorias se reintentan (R-016). */
const RETRYABLE: readonly TrackerFailureClass[] = ['network', 'timeout', 'http_5xx', 'rate_limit'];
export const READ_RETRY_DELAYS_MS = [2000, 5000] as const;
export const MAX_RETRY_AFTER_S = 30;
export const DEFAULT_MAX_PAGES = 20;

let trackerSleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Costura de prueba: sustituye la espera entre reintentos (reloj inyectado). */
export function setTrackerSleep(sleep: ((ms: number) => Promise<void>) | null): void {
  trackerSleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

export type TrackerKind = 'gitlab' | 'github';

/** Nombre corto, largo y prefijo de referencia de la petición de cambio (`MR !12`, `PR #12`). */
export interface ChangeRequestName {
  short: string;
  long: string;
  ref: string;
}

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
  protected userId: number | null = null;

  constructor(
    protected readonly base: string,
    protected readonly project: string,
    protected readonly token: string,
    protected readonly doFetch: TrackerFetch,
    protected readonly maxPages: number = DEFAULT_MAX_PAGES,
  ) {}

  /** Tipo de tracker (4.68): decide el adaptador y los nombres visibles. */
  get kind(): TrackerKind {
    return 'gitlab';
  }

  /** Nombre de la petición de cambio en este tracker (4.70): GitLab la llama merge request y la referencia con `!`. */
  get changeRequestName(): ChangeRequestName {
    return { short: 'MR', long: 'merge request', ref: '!' };
  }

  /** Cabeceras de autenticación: el token viaja solo aquí, nunca en la URL ni en un mensaje. */
  protected authHeaders(): Record<string, string> {
    return TRACKER_DESCRIPTORS[this.kind].authHeaders(this.token);
  }

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

  /** URL base del tracker (sin barra final): parte de la identidad completa de una issue. */
  get baseUrl(): string {
    return this.base.replace(/\/+$/, '');
  }

  /** Identidad del proyecto configurado (para filtrar eventos): ruta decodificada. */
  get projectPath(): string {
    return decodeURIComponent(this.project);
  }

  private url(pathname: string): string {
    return `${this.base.replace(/\/+$/, '')}/api/v4/projects/${projectSegment(this.project)}${pathname}`;
  }

  /** Una petición, sin reintentos; los fallos llevan clase, estado, duración y ruta saneada. */
  protected async once(method: TrackerMethod, url: string, body?: Record<string, unknown>): Promise<{ data: unknown; response: TrackerResponse }> {
    const target = redactPath(url);
    const started = Date.now();
    let response: TrackerResponse;
    try {
      response = await this.doFetch(url, {
        method,
        headers: { ...this.authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = (error as { name?: string }).name === 'TimeoutError' || (error as { name?: string }).name === 'AbortError';
      throw new TrackerError(`el tracker no responde (${method} ${target})`, null, null, {
        failureClass: timeout ? 'timeout' : 'network',
        method,
        target,
        durationMs: Date.now() - started,
      });
    }
    const durationMs = Date.now() - started;
    if (response.status === 429) {
      const raw = response.headers?.get('Retry-After') ?? null;
      const retryAfter = raw !== null && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
      throw new TrackerError(
        `el tracker limitó la petición (HTTP 429)${retryAfter !== null ? `; reintenta en ${retryAfter} s (Retry-After)` : ''}`,
        429,
        retryAfter,
        { failureClass: 'rate_limit', method, target, durationMs },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TrackerError(`el tracker respondió HTTP ${response.status} (${method} ${target})`, response.status, null, {
        failureClass: classifyStatus(response.status),
        method,
        target,
        durationMs,
      });
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new TrackerError(`el tracker devolvió una respuesta ilegible (${method} ${target})`, response.status, null, {
        failureClass: 'parse',
        method,
        target,
        durationMs,
      });
    }
    return { data, response };
  }

  /**
   * Lecturas: hasta 3 intentos ante fallos transitorios (red, timeout, 5xx, 429), con esperas de 2 s y
   * 5 s, o `Retry-After` si es ≤ 30 s. Escrituras (PUT, POST): un solo intento, nunca se repiten (R-016).
   */
  protected async requestRaw(method: TrackerMethod, url: string, body?: Record<string, unknown>): Promise<{ data: unknown; response: TrackerResponse }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.once(method, url, body);
      } catch (error) {
        if (method !== 'GET' || !(error instanceof TrackerError) || !RETRYABLE.includes(error.failureClass) || attempt > READ_RETRY_DELAYS_MS.length) {
          throw error;
        }
        if (error.retryAfter !== null && error.retryAfter > MAX_RETRY_AFTER_S) {
          throw error;
        }
        await trackerSleep(error.retryAfter !== null ? error.retryAfter * 1000 : READ_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }

  protected async request(method: TrackerMethod, url: string, body?: Record<string, unknown>): Promise<unknown> {
    return (await this.requestRaw(method, url, body)).data;
  }

  /**
   * Lectura completa de una colección paginada (R-014): sigue `x-next-page` o `Link rel="next"` hasta el
   * final o hasta el tope de páginas; superarlo, o una página llena sin cabeceras de paginación, es
   * incompletitud explícita (`incomplete`) y nunca se trunca en silencio.
   */
  protected async readAll(url: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = url;
    for (let page = 1; next !== null; page += 1) {
      if (page > this.maxPages) {
        throw new TrackerError(`lectura incompleta: más de ${this.maxPages} páginas (GET ${redactPath(url)})`, null, null, {
          failureClass: 'incomplete',
          method: 'GET',
          target: redactPath(url),
        });
      }
      const { data, response } = await this.requestRaw('GET', next);
      const list = asList(data);
      items.push(...list);
      const following = nextPageUrl(next, response);
      // El token viaja en cada petición: nunca se sigue una página de otro origen.
      if (following !== null && new URL(following).origin !== new URL(url).origin) {
        throw new TrackerError(`lectura incompleta: la página siguiente apunta a otro origen (GET ${redactPath(url)})`, null, null, {
          failureClass: 'incomplete',
          method: 'GET',
          target: redactPath(url),
        });
      }
      next = following;
      if (next === null && !hasPaginationHeaders(response) && list.length >= perPage(url)) {
        throw new TrackerError(`lectura incompleta: página llena sin cabeceras de paginación (GET ${redactPath(url)})`, null, null, {
          failureClass: 'incomplete',
          method: 'GET',
          target: redactPath(url),
        });
      }
    }
    return items;
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
    const raw = await this.readAll(this.url('/issues?state=opened&per_page=100'));
    return raw
      .map(toIssue)
      .filter((issue) => Number.isInteger(issue.iid) && issue.labels.some((label) => label.startsWith('ai::')));
  }

  async issue(iid: number): Promise<TrackerIssue> {
    return toIssue(await this.request('GET', this.url(`/issues/${iid}`)));
  }

  async issuesWithLabel(label: string): Promise<TrackerIssue[]> {
    const raw = await this.readAll(this.url(`/issues?state=opened&per_page=100&labels=${encodeURIComponent(label)}`));
    return raw.map(toIssue);
  }

  async issueNotes(iid: number): Promise<TrackerNote[]> {
    return (await this.readAll(this.url(`/issues/${iid}/notes?sort=asc&order_by=created_at&per_page=100`))).map(toNote);
  }

  async relatedMergeRequests(iid: number): Promise<TrackerMergeRequest[]> {
    return (await this.readAll(this.url(`/issues/${iid}/related_merge_requests?per_page=100`)))
      .map((raw) => ({ iid: Number(asRecord(raw).iid) }))
      .filter((mr) => Number.isInteger(mr.iid));
  }

  async mergeRequestNotes(iid: number): Promise<TrackerNote[]> {
    return (await this.readAll(this.url(`/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=100`))).map(toNote);
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

  /**
   * Dueños del repositorio (R-018, 1.3): miembros con herencia y `access_level` 50, filtrados en el cliente (el
   * servidor no filtra). El objeto de miembro no documenta `bot`: se marca por el patrón documentado de los bots de
   * tokens (`project_<id>_bot_…`, `group_<id>_bot_…`) o por `GET /users/:id` › `bot`; si nada lo dice, `bot: null`
   * («no disponible»), nunca `false`.
   */
  async repositoryOwners(): Promise<RepositoryOwner[]> {
    const members = (await this.readAll(this.url('/members/all?per_page=100'))).map(asRecord);
    const owners: RepositoryOwner[] = [];
    for (const member of members.filter((item) => item.access_level === 50 && typeof item.id === 'number')) {
      const username = typeof member.username === 'string' ? member.username : '';
      let bot: boolean | null = /^(project|group)_\d+_bot_/.test(username) ? true : null;
      if (bot === null) {
        const user = await this.request('GET', `${this.base.replace(/\/+$/, '')}/api/v4/users/${member.id as number}`).catch(() => null);
        const flag = user === null ? undefined : asRecord(user).bot;
        bot = typeof flag === 'boolean' ? flag : null;
      }
      owners.push({ id: member.id as number, username, bot });
    }
    return owners;
  }

  /** Autor de la issue (id y usuario), o null si el tracker no lo da. */
  async issueAuthor(iid: number): Promise<{ id: number; username: string } | null> {
    const author = asRecord(asRecord(await this.request('GET', this.url(`/issues/${iid}`))).author);
    return typeof author.id === 'number' ? { id: author.id, username: typeof author.username === 'string' ? author.username : '' } : null;
  }

  /** Miembros con herencia y su nivel (para saber si un usuario tiene acceso). */
  async projectMembers(): Promise<Array<{ id: number; username: string; accessLevel: number }>> {
    return (await this.readAll(this.url('/members/all?per_page=100')))
      .map(asRecord)
      .filter((item) => typeof item.id === 'number' && typeof item.access_level === 'number')
      .map((item) => ({ id: item.id as number, username: typeof item.username === 'string' ? item.username : '', accessLevel: item.access_level as number }));
  }

  /** MR existente de esa rama de origen cuya descripción lleva el marcador de la asociación. */
  async findMergeRequest(sourceBranch: string, marker: string): Promise<{ iid: number } | null> {
    const list = (await this.readAll(this.url(`/merge_requests?state=all&source_branch=${encodeURIComponent(sourceBranch)}&per_page=100`))).map(asRecord);
    const found = list.find((item) => typeof item.description === 'string' && item.description.includes(marker) && typeof item.iid === 'number');
    return found ? { iid: found.iid as number } : null;
  }

  /**
   * Abre un MR en draft (1.5: la API no tiene parámetro `draft`; se marca con el prefijo `Draft:` del título). Es la
   * única escritura de entrega: nunca aprueba ni fusiona.
   */
  async createDraftMergeRequest(input: DraftChangeRequestInput): Promise<{ iid: number }> {
    const data = asRecord(
      await this.request('POST', this.url('/merge_requests'), {
        source_branch: input.source,
        target_branch: input.target,
        title: `Draft: ${input.title}`,
        description: input.description,
        ...(input.reviewerIds.length > 0 ? { reviewer_ids: input.reviewerIds } : {}),
      }),
    );
    return { iid: Number(data.iid) };
  }

  /**
   * Evidencia de merge de un MR (R-073, 1.4): cabeza de origen (`sha`, o `diff_refs.head_sha`) y commit resultante
   * (`merge_commit_sha` o `squash_commit_sha`) por separado. Un commit resultante ausente se informa como no
   * disponible (p. ej. fast-forward), nunca se deduce.
   */
  async mergeEvidence(iid: number): Promise<MergeEvidence> {
    const data = asRecord(await this.request('GET', this.url(`/merge_requests/${iid}`)));
    const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
    const diffRefs = asRecord(data.diff_refs);
    const squash = typeof data.squash_on_merge === 'boolean' ? data.squash_on_merge : typeof data.squash === 'boolean' ? data.squash : null;
    const result = squash === true ? (text(data.squash_commit_sha) ?? text(data.merge_commit_sha)) : (text(data.merge_commit_sha) ?? text(data.squash_commit_sha));
    return {
      state: text(data.state) ?? 'unknown',
      sourceHead: text(data.sha) ?? text(diffRefs.head_sha),
      result,
      squash,
    };
  }
}

/** Petición de cambio en draft: GitLab pide revisores por id; GitHub, por login. */
export interface DraftChangeRequestInput {
  source: string;
  target: string;
  title: string;
  description: string;
  reviewerIds: number[];
  reviewerLogins?: string[];
}

export interface RepositoryOwner {
  id: number;
  username: string;
  /** `null`: el adaptador no puede saberlo con campos documentados («no disponible»). */
  bot: boolean | null;
}

export interface MergeEvidence {
  state: string;
  /** Cabeza integrada de la rama de origen; `null` si el tracker no la da. */
  sourceHead: string | null;
  /** Commit resultante (merge o squash); `null` = no disponible. */
  result: string | null;
  squash: boolean | null;
}

/** Ruta de la petición sin host ni query, para mensajes de error. */
function redactPath(url: string): string {
  const match = /\/api\/v4\/projects\/[^/]+(\/[^?]*)/.exec(url) ?? /\/repos\/[^/]+\/[^/]+(\/[^?]*)/.exec(url);
  return match ? match[1] : url.includes('/api/v4') ? '/api/v4' : '/';
}

export const defaultTrackerFetch: TrackerFetch = (url, init) => fetch(url, init);

function perPage(url: string): number {
  const raw = new URL(url).searchParams.get('per_page');
  return raw !== null && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 20;
}

function hasPaginationHeaders(response: TrackerResponse): boolean {
  return Boolean(response.headers && (response.headers.get('x-next-page') !== null || response.headers.get('Link') !== null || response.headers.get('link') !== null));
}

/** Siguiente página: `x-next-page` (GitLab) o `Link: <…>; rel="next"` (GitLab y GitHub). */
export function nextPageUrl(current: string, response: TrackerResponse): string | null {
  const nextPage = response.headers?.get('x-next-page') ?? null;
  if (nextPage !== null && /^\d+$/.test(nextPage.trim())) {
    const url = new URL(current);
    url.searchParams.set('page', nextPage.trim());
    return url.toString();
  }
  const link = response.headers?.get('Link') ?? response.headers?.get('link') ?? null;
  if (link) {
    for (const part of link.split(',')) {
      const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * Adaptador de GitHub (R-019, R-014, R-018; 4.69). Comparte con GitLab la lectura completa paginada (`Link rel=next`),
 * los reintentos solo de lectura y la clasificación de fallos. Campos según la documentación REST oficial
 * (https://docs.github.com/en/rest): issues y comentarios (`/repos/{o}/{r}/issues…`; los PR aparecen en el listado de
 * issues y se excluyen por `pull_request`), etiquetas (un único `PUT` del conjunto completo: las etiquetas que no son
 * `ai::` se conservan), colaboradores `admin` como dueños (el tipo `Bot` no está documentado en REST de usuarios:
 * `bot` queda «no disponible» salvo el sufijo `[bot]` de las apps), PR (`head.sha` y `merge_commit_sha`; el método de
 * merge aplicado no está documentado). Los PR de una issue salen de los eventos `cross-referenced` de su línea de
 * tiempo y el estado de CI de los check runs de la cabeza del PR. Ninguna escritura aprueba ni fusiona.
 */
export class GithubTracker extends GitlabTracker {
  override get kind(): TrackerKind {
    return 'github';
  }

  override get changeRequestName(): ChangeRequestName {
    return { short: 'PR', long: 'pull request', ref: '#' };
  }

  static async fromGithubHarness(root: string, manifest: ProjectManifest, doFetch: TrackerFetch): Promise<GithubTracker> {
    const tracker = manifest.tracker;
    if (!tracker) {
      throw new TrackerError('el plano de control necesita manifest.tracker', null);
    }
    const env = (await readHarnessEnv(root)) ?? {};
    const missing = [tracker.urlEnv, tracker.tokenEnv, 'GITHUB_REPOSITORY'].filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new TrackerError(`faltan en .ai-hub/.env: ${missing.join(', ')}`, null);
    }
    return new GithubTracker(env[tracker.urlEnv], env.GITHUB_REPOSITORY, env[tracker.tokenEnv], doFetch);
  }

  override get projectPath(): string {
    return this.project;
  }

  private repo(pathname: string): string {
    return `${this.baseUrl}/repos/${this.project}${pathname}`;
  }

  override async currentUserId(): Promise<number | null> {
    if (this.userId === null) {
      const data = asRecord(await this.request('GET', `${this.baseUrl}/user`));
      this.userId = typeof data.id === 'number' ? data.id : null;
    }
    return this.userId;
  }

  override async labelledIssues(): Promise<TrackerIssue[]> {
    return (await this.readAll(this.repo('/issues?state=open&per_page=100')))
      .filter((raw) => asRecord(raw).pull_request === undefined)
      .map(githubIssue)
      .filter((issue) => Number.isInteger(issue.iid) && issue.labels.some((label) => label.startsWith('ai::')));
  }

  override async issue(iid: number): Promise<TrackerIssue> {
    return githubIssue(await this.request('GET', this.repo(`/issues/${iid}`)));
  }

  override async issuesWithLabel(label: string): Promise<TrackerIssue[]> {
    return (await this.readAll(this.repo(`/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`)))
      .filter((raw) => asRecord(raw).pull_request === undefined)
      .map(githubIssue);
  }

  override async issueNotes(iid: number): Promise<TrackerNote[]> {
    return (await this.readAll(this.repo(`/issues/${iid}/comments?per_page=100`))).map(githubComment);
  }

  /**
   * PR que referencian la issue: eventos `cross-referenced` de la línea de tiempo (REST documentado) cuyo origen es un
   * PR del mismo repositorio (`source.issue.pull_request` y `repository_url`). Lectura completa paginada.
   */
  override async relatedMergeRequests(iid: number): Promise<TrackerMergeRequest[]> {
    const events = (await this.readAll(this.repo(`/issues/${iid}/timeline?per_page=100`))).map(asRecord);
    const numbers = events
      .filter((event) => event.event === 'cross-referenced')
      .map((event) => asRecord(asRecord(event.source).issue))
      .filter((issue) => issue.pull_request !== undefined && typeof issue.number === 'number' && typeof issue.repository_url === 'string' && issue.repository_url.endsWith(`/repos/${this.project}`))
      .map((issue) => issue.number as number);
    return [...new Set(numbers)].map((number) => ({ iid: number }));
  }

  override async mergeRequestNotes(iid: number): Promise<TrackerNote[]> {
    return (await this.readAll(this.repo(`/issues/${iid}/comments?per_page=100`))).map(githubComment);
  }

  /**
   * Estado de CI de la cabeza del PR a partir de sus check runs (REST documentado): `success` solo si todos terminaron
   * con `success`, `neutral` o `skipped` y al menos uno con `success`; `failed` si alguno falló; `running` si alguno no
   * terminó; `null` sin check runs. Una lista incompleta es incompletitud explícita, nunca un estado.
   */
  override async latestPipelineStatus(iid: number): Promise<string | null> {
    const head = text(asRecord(asRecord(await this.request('GET', this.repo(`/pulls/${iid}`))).head).sha);
    if (head === null) {
      return null;
    }
    const data = asRecord(await this.request('GET', this.repo(`/commits/${head}/check-runs?per_page=100`)));
    const runs = asList(data.check_runs).map(asRecord);
    if (typeof data.total_count === 'number' && data.total_count > runs.length) {
      throw new TrackerError(`lectura incompleta: más de ${runs.length} check runs (GET /commits/{sha}/check-runs)`, null, null, {
        failureClass: 'incomplete',
        method: 'GET',
        target: '/commits/{sha}/check-runs',
      });
    }
    if (runs.length === 0) {
      return null;
    }
    const conclusions = runs.map((run) => (run.status === 'completed' ? String(run.conclusion) : null));
    if (conclusions.some((conclusion) => conclusion !== null && !['success', 'neutral', 'skipped'].includes(conclusion))) {
      return 'failed';
    }
    if (conclusions.includes(null)) {
      return 'running';
    }
    return conclusions.includes('success') ? 'success' : 'skipped';
  }

  /** Única escritura de etiquetas: el conjunto completo en un `PUT` (las no `ai::` se conservan). */
  override async moveLabel(iid: number, add: string, remove: string[]): Promise<void> {
    const current = (await this.issue(iid)).labels;
    const next = [...current.filter((label) => !remove.includes(label) && label !== add), add];
    await this.request('PUT', this.repo(`/issues/${iid}/labels`), { labels: next });
  }

  override async postIssueNote(iid: number, body: string): Promise<void> {
    await this.request('POST', this.repo(`/issues/${iid}/comments`), { body });
  }

  override async repositoryOwners(): Promise<RepositoryOwner[]> {
    return (await this.readAll(this.repo('/collaborators?permission=admin&affiliation=all&per_page=100')))
      .map(asRecord)
      .filter((item) => typeof item.id === 'number')
      .map((item) => {
        const login = typeof item.login === 'string' ? item.login : '';
        return { id: item.id as number, username: login, bot: login.endsWith('[bot]') ? true : null };
      });
  }

  override async issueAuthor(iid: number): Promise<{ id: number; username: string } | null> {
    const user = asRecord(asRecord(await this.request('GET', this.repo(`/issues/${iid}`))).user);
    return typeof user.id === 'number' ? { id: user.id, username: typeof user.login === 'string' ? user.login : '' } : null;
  }

  override async projectMembers(): Promise<Array<{ id: number; username: string; accessLevel: number }>> {
    return (await this.readAll(this.repo('/collaborators?affiliation=all&per_page=100')))
      .map(asRecord)
      .filter((item) => typeof item.id === 'number')
      .map((item) => {
        const permissions = asRecord(item.permissions);
        const level = permissions.admin === true ? 50 : permissions.maintain === true ? 40 : permissions.push === true ? 30 : permissions.pull === true ? 10 : 0;
        return { id: item.id as number, username: typeof item.login === 'string' ? item.login : '', accessLevel: level };
      });
  }

  override async findMergeRequest(sourceBranch: string, marker: string): Promise<{ iid: number } | null> {
    const owner = this.project.split('/')[0];
    const list = (await this.readAll(this.repo(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${sourceBranch}`)}&per_page=100`))).map(asRecord);
    const found = list.find((item) => typeof item.body === 'string' && item.body.includes(marker) && typeof item.number === 'number');
    return found ? { iid: found.number as number } : null;
  }

  /** PR en draft con `draft: true` (documentado); los revisores se piden por login en una segunda petición. */
  override async createDraftMergeRequest(input: DraftChangeRequestInput): Promise<{ iid: number }> {
    const data = asRecord(await this.request('POST', this.repo('/pulls'), { title: input.title, head: input.source, base: input.target, body: input.description, draft: true }));
    const number = Number(data.number);
    if ((input.reviewerLogins ?? []).length > 0) {
      await this.request('POST', this.repo(`/pulls/${number}/requested_reviewers`), { reviewers: input.reviewerLogins });
    }
    return { iid: number };
  }

  override async mergeEvidence(iid: number): Promise<MergeEvidence> {
    const data = asRecord(await this.request('GET', this.repo(`/pulls/${iid}`)));
    const merged = data.merged === true;
    const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
    return {
      state: merged ? 'merged' : data.state === 'closed' ? 'closed' : 'opened',
      sourceHead: text(asRecord(data.head).sha),
      // `merge_commit_sha` documentado para merge, squash y rebase; sin merge no hay resultado.
      result: merged ? text(data.merge_commit_sha) : null,
      squash: null,
    };
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function githubIssue(raw: unknown): TrackerIssue {
  const data = asRecord(raw);
  return {
    iid: typeof data.number === 'number' ? data.number : Number.NaN,
    title: typeof data.title === 'string' ? data.title : '',
    labels: asList(data.labels)
      .map((label) => (typeof label === 'string' ? label : asRecord(label).name))
      .filter((label): label is string => typeof label === 'string'),
    description: typeof data.body === 'string' ? data.body : '',
  };
}

function githubComment(raw: unknown): TrackerNote {
  const data = asRecord(raw);
  const user = asRecord(data.user);
  return { id: typeof data.id === 'number' ? data.id : 0, body: typeof data.body === 'string' ? data.body : '', authorId: typeof user.id === 'number' ? user.id : null };
}

/** Cliente del tracker declarado en `manifest.tracker.kind` (4.68). */
export async function trackerFromHarness(root: string, manifest: ProjectManifest, doFetch: TrackerFetch): Promise<GitlabTracker> {
  if (manifest.tracker?.kind === 'github') {
    return GithubTracker.fromGithubHarness(root, manifest, doFetch);
  }
  return GitlabTracker.fromHarness(root, manifest, doFetch);
}

/**
 * Lo que cada producto documenta para las lecturas de diagnóstico que no pasan por el cliente (`doctor --online`,
 * `tick --online --labels-from`) y sus capacidades declaradas (R-019): el flujo compartido pregunta al descriptor y
 * nunca ramifica por el nombre del tracker.
 */
export interface TrackerDescriptor {
  kind: TrackerKind;
  /** Clave de `.ai-hub/.env` con el proyecto (`grupo/proyecto` o `propietario/repo`). */
  projectEnvKey: string;
  authHeaders(token: string): Record<string, string>;
  identityUrl(base: string): string;
  identityName(body: unknown): unknown;
  issueUrl(base: string, project: string, iid: number): string;
  labelsOf(body: unknown): string[];
  /** Introspección documentada de permisos del token; `false` = no verificada. */
  tokenIntrospection: boolean;
  /** `control ingest` entiende los webhooks de este producto (hermes-control › Webhook ingest: eventos de GitLab). */
  webhookIngest: boolean;
}

const trim = (base: string): string => base.replace(/\/+$/, '');

export const TRACKER_DESCRIPTORS: Readonly<Record<TrackerKind, TrackerDescriptor>> = {
  gitlab: {
    kind: 'gitlab',
    projectEnvKey: 'GITLAB_PROJECT_PATH',
    authHeaders: (token) => ({ 'PRIVATE-TOKEN': token }),
    identityUrl: (base) => `${trim(base)}/api/v4/user`,
    identityName: (body) => asRecord(body).username,
    issueUrl: (base, project, iid) => `${trim(base)}/api/v4/projects/${project}/issues/${iid}`,
    labelsOf: (body) => asList(asRecord(body).labels).filter((label): label is string => typeof label === 'string'),
    tokenIntrospection: true,
    webhookIngest: true,
  },
  github: {
    kind: 'github',
    projectEnvKey: 'GITHUB_REPOSITORY',
    authHeaders: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
    identityUrl: (base) => `${trim(base)}/user`,
    identityName: (body) => asRecord(body).login,
    issueUrl: (base, project, iid) => `${trim(base)}/repos/${project}/issues/${iid}`,
    labelsOf: (body) =>
      asList(asRecord(body).labels)
        .map((label) => (typeof label === 'string' ? label : asRecord(label).name))
        .filter((label): label is string => typeof label === 'string'),
    tokenIntrospection: false,
    webhookIngest: false,
  },
};

export function trackerDescriptor(kind: TrackerKind | undefined): TrackerDescriptor {
  return TRACKER_DESCRIPTORS[kind ?? 'gitlab'];
}

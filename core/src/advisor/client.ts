import type { TrackerFetch } from '../control/tracker.js';

/**
 * Cliente del tracker del advisor (R-079, R-084): solo leer issues, crear issues y publicar notas en el proyecto
 * configurado. Valida método, ruta, proyecto, campos del cuerpo, etiquetas, tamaños y ritmo antes de enviar nada;
 * actualizar etiquetas, hacer merge o cerrar falla en el propio cliente, sin petición de red. Las escrituras siguen
 * desactivadas mientras no haya una verificación de aislamiento (R-085): el cliente las rechaza también sin red.
 */

export const ADVISOR_LABEL = 'ai::todo';
export const LIMITS = { title: 255, description: 20_000, note: 5_000, writesPerHour: 10 } as const;

export class AdvisorClientError extends Error {
  constructor(
    readonly reasonCode: 'not_allowlisted' | 'capability_disabled' | 'invalid_body' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'AdvisorClientError';
  }
}

export interface AdvisorClientOptions {
  base: string;
  project: string;
  token: string;
  fetch: TrackerFetch;
  /** Escrituras habilitadas (solo con aislamiento verificado para este host y versión). */
  writesEnabled: boolean;
  now?: () => Date;
}

type Operation = { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> };

export class AdvisorClient {
  private readonly writes: number[] = [];

  constructor(private readonly options: AdvisorClientOptions) {}

  private get projectPath(): string {
    return `/projects/${encodeURIComponent(this.options.project)}`;
  }

  /** Única puerta hacia la red: lo que no casa con la allowlist no sale. */
  private async send(operation: Operation): Promise<unknown> {
    const allowed = [
      { method: 'GET', pattern: new RegExp(`^${escape(this.projectPath)}/issues(/\\d+(/notes)?)?(\\?[\\w=&%.-]*)?$`) },
      { method: 'POST', pattern: new RegExp(`^${escape(this.projectPath)}/issues$`) },
      { method: 'POST', pattern: new RegExp(`^${escape(this.projectPath)}/issues/\\d+/notes$`) },
    ];
    if (!allowed.some((rule) => rule.method === operation.method && rule.pattern.test(operation.path))) {
      throw new AdvisorClientError('not_allowlisted', `${operation.method} ${operation.path.replace(/\?.*$/, '')} está fuera de la allowlist del advisor; no se envía`);
    }
    if (operation.method === 'POST') {
      // Campos del cuerpo cerrados: una issue solo con título, descripción y `ai::todo`; una nota solo con su texto.
      const body = operation.body ?? {};
      const isNote = operation.path.endsWith('/notes');
      const fields = isNote ? ['body'] : ['title', 'description', 'labels'];
      if (Object.keys(body).some((key) => !fields.includes(key)) || (!isNote && body.labels !== ADVISOR_LABEL)) {
        throw new AdvisorClientError('invalid_body', `cuerpo fuera de la allowlist del advisor (${isNote ? 'nota: body' : `issue: title, description y labels=${ADVISOR_LABEL}`}); no se envía`);
      }
      if (!this.options.writesEnabled) {
        throw new AdvisorClientError('capability_disabled', 'las escrituras del advisor están desactivadas hasta verificar el aislamiento del perfil; no se envía');
      }
      const now = (this.options.now ?? (() => new Date()))().getTime();
      const recent = this.writes.filter((ts) => now - ts < 3_600_000);
      if (recent.length >= LIMITS.writesPerHour) {
        throw new AdvisorClientError('rate_limited', `más de ${LIMITS.writesPerHour} escrituras en una hora; no se envía`);
      }
      this.writes.splice(0, this.writes.length, ...recent, now);
    }
    const response = await this.options.fetch(`${this.options.base}/api/v4${operation.path}`, {
      method: operation.method,
      headers: { 'PRIVATE-TOKEN': this.options.token, 'Content-Type': 'application/json' },
      ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
    });
    return response.json();
  }

  async issue(iid: number): Promise<unknown> {
    return this.send({ method: 'GET', path: `${this.projectPath}/issues/${iid}` });
  }

  async createIssue(title: string, description: string): Promise<unknown> {
    if (title.trim() === '' || title.length > LIMITS.title || description.length > LIMITS.description) {
      throw new AdvisorClientError('invalid_body', `título (1–${LIMITS.title}) o descripción (≤ ${LIMITS.description}) fuera de límites`);
    }
    // Campos cerrados: título, descripción y la única etiqueta admitida al crear.
    return this.send({ method: 'POST', path: `${this.projectPath}/issues`, body: { title, description, labels: ADVISOR_LABEL } });
  }

  async note(iid: number, body: string): Promise<unknown> {
    if (body.trim() === '' || body.length > LIMITS.note) {
      throw new AdvisorClientError('invalid_body', `nota vacía o de más de ${LIMITS.note} caracteres`);
    }
    return this.send({ method: 'POST', path: `${this.projectPath}/issues/${iid}/notes`, body: { body } });
  }

  /** Operaciones que el advisor nunca puede hacer: fallan aquí, sin red. */
  async updateLabels(iid: number, labels: string[]): Promise<never> {
    void labels;
    return this.forbidden(`actualizar etiquetas de #${iid}`);
  }

  async merge(mr: number): Promise<never> {
    return this.forbidden(`hacer merge de !${mr}`);
  }

  async close(iid: number): Promise<never> {
    return this.forbidden(`cerrar #${iid}`);
  }

  /** Petición arbitraria (por ejemplo, la que sugiera el contenido de una issue): pasa por la misma allowlist. */
  async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (method !== 'GET' && method !== 'POST') {
      throw new AdvisorClientError('not_allowlisted', `${method} ${path} está fuera de la allowlist del advisor; no se envía`);
    }
    return this.send({ method, path, ...(body ? { body } : {}) });
  }

  private async forbidden(what: string): Promise<never> {
    throw new AdvisorClientError('not_allowlisted', `el advisor no puede ${what}; no se envía ninguna petición`);
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

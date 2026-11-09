import { parse, stringify } from 'yaml';

/**
 * Conversión del manifiesto MCP heredado (`.ai-hub/mcp-manifest.yaml`, campos planos `name`,
 * `command`/`args`/`url`) al formato actual de la raíz (`required_mcps: [{id, type, client}]`).
 * Las integraciones de tipo skill se devuelven aparte para publicarlas como skills; los `prompts`
 * no tienen equivalente y se informan.
 */
export interface McpConversion {
  yaml: string;
  servers: string[];
  skills: string[];
  dropped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function convertLegacyMcp(text: string): McpConversion {
  const data: unknown = parse(text);
  if (!isRecord(data)) {
    throw new Error('el manifiesto MCP heredado no es un objeto YAML');
  }
  const servers: Array<Record<string, unknown>> = [];
  for (const raw of Array.isArray(data.required_mcps) ? data.required_mcps : []) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : null;
    if (id === null) {
      continue;
    }
    const source = isRecord(raw.client) ? raw.client : raw;
    const client: Record<string, unknown> = {};
    if (typeof source.url === 'string') {
      client.url = source.url;
    } else if (typeof source.command === 'string') {
      client.command = source.command;
      if (Array.isArray(source.args)) {
        client.args = source.args.filter((arg): arg is string => typeof arg === 'string');
      }
    } else {
      continue;
    }
    servers.push({ id, type: typeof client.url === 'string' ? 'remote' : 'local', client });
  }
  const skills: string[] = [];
  for (const raw of Array.isArray(data.integrations) ? data.integrations : []) {
    if (isRecord(raw) && raw.type === 'skill' && typeof raw.skill === 'string') {
      skills.push(raw.skill);
    }
  }
  const dropped = Object.keys(data).filter((key) => key !== 'required_mcps' && key !== 'integrations');
  return {
    yaml: stringify({ required_mcps: servers }),
    servers: servers.map((server) => String(server.id)),
    skills,
    dropped,
  };
}

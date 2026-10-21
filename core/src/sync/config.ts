import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export interface SyncSkills {
  source: string;
  publish: string[];
  targets: string[];
}

export interface SyncAgents {
  source: string;
  publish: string[];
  targets: { claude: string; opencode: string };
}

export interface SyncRules {
  source: string;
}

export interface SyncMcp {
  source: string;
}

export interface SyncOpencode {
  instructions: string[];
}

export interface SyncConfig {
  skills: SyncSkills;
  agents: SyncAgents;
  rules: SyncRules;
  mcp: SyncMcp;
  opencode: SyncOpencode;
}

export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConfigError';
  }
}

export const MANIFEST_PATH = '.ai-hub/manifest.yaml';

export async function loadSyncConfig(root: string): Promise<SyncConfig> {
  const raw = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8').catch(() => {
    throw new SyncConfigError(`no se encuentra ${MANIFEST_PATH}`);
  });
  const manifest = asRecord(parse(raw), 'manifest');
  const sync = asRecord(manifest.sync, 'sync');
  return {
    skills: parseSkills(asRecord(sync.skills, 'sync.skills')),
    agents: parseAgents(asRecord(sync.agents, 'sync.agents')),
    rules: { source: asString(asRecord(sync.rules, 'sync.rules').source, 'sync.rules.source') },
    mcp: { source: asString(asRecord(sync.mcp, 'sync.mcp').source, 'sync.mcp.source') },
    opencode: {
      instructions: asStringArray(asRecord(sync.opencode, 'sync.opencode').instructions, 'sync.opencode.instructions'),
    },
  };
}

function parseSkills(section: Record<string, unknown>): SyncSkills {
  return {
    source: asString(section.source, 'sync.skills.source'),
    publish: asStringArray(section.publish, 'sync.skills.publish'),
    targets: asStringArray(section.targets, 'sync.skills.targets'),
  };
}

function parseAgents(section: Record<string, unknown>): SyncAgents {
  const targets = asRecord(section.targets, 'sync.agents.targets');
  return {
    source: asString(section.source, 'sync.agents.source'),
    publish: asStringArray(section.publish, 'sync.agents.publish'),
    targets: {
      claude: asString(targets.claude, 'sync.agents.targets.claude'),
      opencode: asString(targets.opencode, 'sync.agents.targets.opencode'),
    },
  };
}

function asRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncConfigError(`falta la clave "${key}" en ${MANIFEST_PATH}`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SyncConfigError(`"${key}" debe ser un texto no vacío en ${MANIFEST_PATH}`);
  }
  return value;
}

function asStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new SyncConfigError(`"${key}" debe ser una lista de textos en ${MANIFEST_PATH}`);
  }
  return value;
}

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { numberedBackup, probeWebhook, readWebhookBlock, removeEnvKeys, writeWebhookBlock } from '../src/control/webhook-config.js';
import { entryQuestion, ownerQuestion, validateConnectFlags } from '../src/control/onboard-step.js';
import { harness } from './control-harness.js';

/**
 * webhook-operativo 2.1, 2.4 y 2.7 (escritas después del código, declarado en impl): lector/escritor de config.yaml,
 * sonda real de GET /health contra servidores locales y validación de `--webhook-owner`.
 */

const servers: Array<http.Server | net.Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

describe('webhook-operativo 2.4 — GET /health probe against local servers', () => {
  it('the Hermes health document means listening', async () => {
    const port = await listen(http.createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', platform: 'webhook' }))));
    expect(await probeWebhook(port)).toBe('listening');
  });

  it('a closed port means refused', async () => {
    expect(await probeWebhook(await freePort())).toBe('refused');
  });

  it('another HTTP document on the port means foreign', async () => {
    const port = await listen(http.createServer((_req, res) => res.end('<html>otro servicio</html>')));
    expect(await probeWebhook(port)).toBe('foreign');
  });

  it('a TCP listener that never answers HTTP is foreign after the timeout, not refused', async () => {
    const sockets: net.Socket[] = [];
    const port = await listen(net.createServer((socket) => sockets.push(socket)));
    expect(await probeWebhook(port, 300)).toBe('foreign');
    sockets.forEach((socket) => socket.destroy());
  });
});

describe('webhook-operativo 2.1 — config.yaml reader and writer', () => {
  let dir: string;
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file when absent, preserves comments and keys, and keeps an existing port', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-webhook-'));
    const file = path.join(dir, 'config.yaml');
    await writeWebhookBlock(file, 8644);
    expect(await readWebhookBlock(file)).toEqual({ kind: 'enabled', port: 8644, hasSecret: false });
    await fs.writeFile(file, '# nota\nmodel: m\nplatforms:\n  webhook:\n    extra:\n      port: 9001\n');
    await writeWebhookBlock(file, 8644);
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('# nota');
    expect(text).toContain('model: m');
    expect(await readWebhookBlock(file)).toEqual({ kind: 'enabled', port: 9001, hasSecret: false });
    expect(text).not.toMatch(/secret|host|INSECURE/);
  });

  it('refuses to write a malformed file and leaves it byte-identical', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-webhook-'));
    const file = path.join(dir, 'config.yaml');
    for (const original of ['- a\n', 'k: 1\nk: 2\n', 'platforms: 3\n']) {
      await fs.writeFile(file, original);
      await expect(writeWebhookBlock(file, 8644)).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    }
  });

  it('numbered backups never overwrite and env key removal keeps every other byte', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-webhook-'));
    const env = path.join(dir, '.env');
    await fs.writeFile(env, 'A=1\r\nWEBHOOK_PORT=1\nB=2\n');
    expect(await numberedBackup(env)).toBe(`${env}.pre-ai-hub`);
    expect(await numberedBackup(env)).toBe(`${env}.pre-ai-hub.1`);
    expect(await removeEnvKeys(env, ['WEBHOOK_PORT'])).toBe(1);
    expect(await fs.readFile(env, 'utf8')).toBe('A=1\r\nB=2\n');
  });
});

describe('webhook-operativo 2.7 — --webhook-owner is validated before any write', () => {
  it('init rejects an empty owner value and --webhook-owner without --connect-hermes with exit 2', async () => {
    const base = { 'discord-token-stdin': true, 'discord-channel': '987654321098765432', approver: '123456789012345678' };
    expect(validateConnectFlags({ ...base, 'webhook-owner': true })).toContain('--webhook-owner');
    expect(validateConnectFlags({ ...base, 'webhook-owner': 'default' })).toBeNull();
    const h = await harness();
    try {
      await fs.writeFile(path.join(h.root, 'package.json'), '{"name":"demo"}');
      const before = await fs.readdir(h.root);
      const result = await h.cli(['init', '--yes', '--preset-only', '--webhook-owner', 'default']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('--webhook-owner solo se admite junto a --connect-hermes');
      expect(await fs.readdir(h.root)).toEqual(before);
    } finally {
      await h.dispose();
    }
  });

  it('control enroll rejects a --webhook-owner without a profile name with exit 2', async () => {
    const h = await harness();
    try {
      await h.consumer();
      const result = await h.cli(['control', 'enroll', '--yes', '--webhook-owner']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('--webhook-owner necesita el nombre del perfil');
    } finally {
      await h.dispose();
    }
  });

  it('the acceptance question names a shared owner, its scope and the move of legacy keys (CO-01)', () => {
    const plain = entryQuestion('0.23.0');
    expect(plain).toContain('platforms.webhook');
    expect(plain).not.toContain('WEBHOOK_ENABLED');
    const shared = entryQuestion('0.23.0', { sharedOwner: 'default', legacyKeys: true });
    expect(shared).toContain('perfil "default"');
    expect(shared).toContain('todos los perfiles');
    expect(shared).toContain('sesiones');
    expect(shared).toContain('mueve WEBHOOK_ENABLED y WEBHOOK_PORT');
    expect(ownerQuestion('default')).toContain('"default"');
  });
});

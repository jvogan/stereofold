import { chmod, mkdtemp, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readSceneRelayTarget, startSceneSocketRelay } from '../scripts/scene-socket-relay.js';
import { runBundledHeadsetHost } from '../scripts/quest-share.js';
import { headsetHostCommand } from '../src/headset-host-guidance.js';
import { createStereoStructureServer } from '../src/server.js';
import { LocalSceneService } from '../src/scene-service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function owner(label: string) {
  const server = net.createServer(client => client.end(label));
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
  return { port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>(done => server.close(() => done())) };
}

async function connect(socket: string): Promise<string> {
  return await new Promise((done, fail) => {
    const client = net.connect(socket);
    let reply = '';
    client.setEncoding('utf8');
    client.on('data', chunk => { reply += chunk; });
    client.once('end', () => done(reply));
    client.once('error', fail);
  });
}

it('reads the current validated owner on each relay connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-relay-'));
  const file = join(directory, 'owner.json');
  const socket = join(directory, 'scene.sock');
  const record = (port: number) => ({ version: 1, origin: `http://127.0.0.1:${port}`, token: 'a'.repeat(64), sceneId: 'scene', uid: process.getuid?.() });
  const first = await owner('first');
  const second = await owner('second');
  let stop: (() => Promise<void>) | undefined;
  try {
    await writeFile(file, JSON.stringify(record(first.port)), { mode: 0o600 });
    stop = await startSceneSocketRelay(file, socket);
    expect(await connect(socket)).toBe('first');
    const replacement = join(directory, 'replacement.json');
    await writeFile(replacement, JSON.stringify(record(second.port)), { mode: 0o600 });
    await rename(replacement, file);
    expect(await connect(socket)).toBe('second');
    await writeFile(file, JSON.stringify({ ...record(second.port), token: 'bad' }));
    await expect(readSceneRelayTarget(file)).rejects.toThrow(/usable token/);
    await chmod(file, 0o644);
    expect((await stat(file)).mode & 0o077).not.toBe(0);
    await expect(readSceneRelayTarget(file)).rejects.toThrow(/private regular file/);
  } finally { await stop?.(); await first.close(); await second.close(); }
});

it('serializes stale-socket cleanup and binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-relay-race-'));
  const file = join(directory, 'owner.json');
  const socket = join(directory, 'scene.sock');
  const lock = `${socket}.startup.lock`;
  const target = await owner('live');
  await writeFile(file, JSON.stringify({ version: 1, origin: `http://127.0.0.1:${target.port}`,
    token: 'a'.repeat(64), sceneId: 'scene', uid: process.getuid?.() }), { mode: 0o600 });
  execFileSync('python3', ['-c', 'import os, socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\nos._exit(0)', socket]);
  let stop: (() => Promise<void>) | undefined;
  try {
    await writeFile(lock, 'held', { flag: 'wx', mode: 0o600 });
    let started = 0;
    const pending = [startSceneSocketRelay(file, socket), startSceneSocketRelay(file, socket)]
      .map(promise => promise.then(value => { started += 1; return value; }));
    await new Promise(done => setTimeout(done, 100));
    expect(started).toBe(0);
    await unlink(lock);
    const results = await Promise.allSettled(pending);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    stop = results.find(result => result.status === 'fulfilled')?.value;
    expect(await connect(socket)).toBe('live');
  } finally { await stop?.(); await target.close(); }
});

it('clears a startup lock left by a relay that died', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-relay-abandoned-'));
  const file = join(directory, 'owner.json');
  const socket = join(directory, 'scene.sock');
  const target = await owner('live');
  await writeFile(file, JSON.stringify({ version: 1, origin: `http://127.0.0.1:${target.port}`,
    token: 'a'.repeat(64), sceneId: 'scene', uid: process.getuid?.() }), { mode: 0o600 });
  // A process that has already exited stands in for the relay that died holding the lock.
  const dead = spawnSync('true').pid;
  await writeFile(`${socket}.startup.lock`, `${dead}\n`, { flag: 'wx', mode: 0o600 });
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await startSceneSocketRelay(file, socket);
    expect(await connect(socket)).toBe('live');
  } finally { await stop?.(); await target.close(); }
});

it('runs no other script main block from inside the bundled host', () => {
  // dist/headset-host.mjs bundles several scripts, and every module in a bundle
  // sees the bundle's import.meta.url. A main block that checked only that URL
  // ran beside the host: setup-doctor printed its usage and ran its report.
  const bundle = fileURLToPath(new URL('../dist/headset-host.mjs', import.meta.url));
  const help = execFileSync(process.execPath, [bundle, '--help'], { encoding: 'utf8' });
  expect(help.match(/^Usage:/gmu)).toHaveLength(1);
  expect(help).toContain('headset-host.mjs');
});

it('gives the bundled host and its child a real require for CommonJS dependencies', async () => {
  // The MCP SDK's stdio client reaches child_process through cross-spawn, a
  // CommonJS module. Without a require of its own the ESM bundle stopped at
  // startup with "Dynamic require of child_process is not supported".
  for (const name of ['headset-host.mjs', 'serve-inspection.mjs']) {
    const head = (await readFile(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)), 'utf8')).slice(0, 200);
    expect(head, name).toMatch(/^import \{ createRequire as \w+ \} from 'node:module'; const require = \w+\(import\.meta\.url\);/u);
  }
});

async function continuation(denied: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-sandbox-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, {
    sceneServiceFile: join(directory, 'missing.json'), loopbackListenDenied: async () => denied,
  });
  const client = new Client({ name: 'headset-host-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await client.callTool({ name: 'stereo_structure.continue_session', arguments: {} }) as any; }
  finally { await client.close(); await server.close(); }
}

async function continuationWithLocalScene() {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-local-scene-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, {
    sceneServiceFile: join(directory, 'missing.json'), loopbackListenDenied: async () => true,
  });
  const client = new Client({ name: 'headset-host-local-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const structureText = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const opened = await client.callTool({ name: 'stereo_structure.inspect', arguments: { structureText } }) as any;
    expect(opened.isError).not.toBe(true);
    const denied = Object.assign(new Error('loopback listen denied'), { code: 'EPERM' });
    const share = vi.spyOn(LocalSceneService.prototype, 'share').mockRejectedValueOnce(denied);
    try { return await client.callTool({ name: 'stereo_structure.continue_session', arguments: {} }) as any; }
    finally { share.mockRestore(); }
  } finally { await client.close(); await server.close(); }
}

describe('continue_session without an owner', () => {
  it('gives a sandboxed server its absolute bundled host command', async () => {
    const result = await continuation(true);
    expect(result.structuredContent.kind).toBe('external-owner-unavailable');
    expect(result.structuredContent.command).toBe(headsetHostCommand());
    expect(result.structuredContent.command).toContain(process.execPath);
    expect(JSON.stringify(result.content)).toMatch(/headset host is not running/);
    expect(JSON.stringify(result.content)).not.toMatch(/Open a structure here first/);
  });

  it('keeps the ordinary unsandboxed advice', async () => {
    const result = await continuation(false);
    expect(result.structuredContent).toMatchObject({ kind: 'scene-continuation', role: 'none' });
    expect(JSON.stringify(result.content)).toMatch(/Open a structure here first/);
  });

  it('gives the host command when publishing an existing local scene is denied', async () => {
    const result = await continuationWithLocalScene();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ kind: 'external-owner-unavailable', role: 'none', command: headsetHostCommand() });
    expect(JSON.stringify(result.content)).toMatch(/headset host is not running/);
  });
});

it('rejects a bad bundled host argument before starting an owner', async () => {
  await expect(runBundledHeadsetHost(['not-a-pdb-id'])).rejects.toThrow(/four-character PDB ID/);
});

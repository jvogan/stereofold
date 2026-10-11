import http from 'node:http';
import { expect, it } from 'vitest';
import { LanCompanion } from '../src/inspection-lan.js';
import { inMemoryCompanionNetwork } from './fixtures/in-memory-companion-network.js';

async function setup() {
  const network = inMemoryCompanionNetwork();
  const responses = new Map<string, any>();
  const starts = new Map<string, () => void>();
  const server = http.createServer({}, (request, response) => {
    responses.set(request.url!, response); starts.get(request.url!)?.();
  });
  server.listen(0, '127.0.0.1');
  const port = (server.address() as { port: number }).port;
  const lan = new LanCompanion({ remember: false,
    interfaces: () => ({ en0: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] }),
    createCertificate: async () => ({ key: Buffer.alloc(0), cert: Buffer.alloc(0), fingerprint: 'fixture' }),
  });
  const url = `http://127.0.0.1:${port}/#${'a'.repeat(64)}`;
  const opened = await lan.open({ url });
  const token = await network.pair(opened);
  const begin = async (path: string) => {
    const started = new Promise<void>(resolve => starts.set(path, resolve));
    const pending = network.fetch(path, { headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(path === '/tool' ? { method: 'POST', body: JSON.stringify({ name: 'navigate_experience', args: {} }) } : {}) })
      .then(async response => ({ status: response.status, body: await response.text() }), () => 'cut' as const);
    await started;
    return { pending, response: responses.get(path) };
  };
  return { lan, network, begin, url, opened, replacement: `http://127.0.0.1:${port}/#${'b'.repeat(64)}`,
    close: async () => { await lan.close(); network.close(); } };
}

it('LAN retarget delivers the transition tool response and cuts old coordinate streams', async () => {
  const t = await setup();
  try {
    const source = await t.begin('/source'), tool = await t.begin('/tool');
    const paired = t.lan.status()!.clients;
    await t.lan.retarget(t.replacement);
    expect(await source.pending).toBe('cut');
    tool.response.writeHead(200); tool.response.end('prepared journey claim');
    expect(await tool.pending).toEqual({ status: 200, body: 'prepared journey claim' });
    expect(t.lan.status()!.clients).toEqual(paired);
  } finally { await t.close(); }
});

for (const action of ['revoke', 'replace share', 'close']) it(`LAN ${action} still cuts an active tool response`, async () => {
  const t = await setup();
  try {
    const tool = await t.begin('/tool');
    if (action === 'revoke') await t.lan.revoke(t.lan.status()!.clients[0]!.id);
    else if (action === 'replace share') await t.lan.open({ url: t.replacement });
    else await t.lan.close();
    expect(await tool.pending).toBe('cut');
  } finally { await t.close(); }
});

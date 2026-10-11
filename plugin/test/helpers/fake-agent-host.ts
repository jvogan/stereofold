/**
 * A stand-in for the standalone host's loopback `/agent` route.
 *
 * It records every call and answers from a scripted table, so a command line
 * or the converse loop can be driven end to end without a real MCP child, a
 * browser, or the wearer's live session. It speaks the same three things the
 * real route does and nothing else: a bearer on `/agent`, one JSON body in, one
 * JSON body out, and a 409 carrying the host's own sentence for a refusal.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Call = { name: string; arguments: Record<string, any> };
export const TOKEN = 'a'.repeat(64);

export type FakeHost = {
  calls: Call[];
  statePath: string;
  directory: string;
  /** Rewrite the control file, the way a host that recovered a session does. */
  rotate: (next: { token?: string; sessionId?: string }) => Promise<void>;
  close: () => Promise<void>;
};

export async function fakeAgentHost(reply: (call: Call) => unknown | Promise<unknown>): Promise<FakeHost> {
  const calls: Call[] = [];
  let token = TOKEN;
  let sessionId = 'session-1';
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${token}` || request.url !== '/agent') {
          response.writeHead(403, { 'Content-Type': 'application/json' }); response.end('{}'); return;
        }
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Call;
        calls.push({ name: call.name, arguments: call.arguments ?? {} });
        let body: unknown;
        try { body = await reply(call); }
        catch (error) {
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: (error as Error).message })); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      })();
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
  const port = (server.address() as any).port;
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-cli-'));
  const statePath = join(directory, 'state.json');
  const writeState = () => writeFile(statePath, JSON.stringify({ origin: `http://127.0.0.1:${port}`, token, sessionId }));
  await writeState();
  return {
    calls, statePath, directory,
    rotate: async next => {
      if (next.token !== undefined) token = next.token;
      if (next.sessionId !== undefined) sessionId = next.sessionId;
      await writeState();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

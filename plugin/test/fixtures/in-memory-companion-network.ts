import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { vi } from 'vitest';

/** Run the real HTTP/LAN handlers and proxy with streams, without binding sockets. */
export function inMemoryCompanionNetwork(replayDroppedNavigation = false) {
  const servers = new Map<number, any>();
  const sockets = new Set<any>();
  let nextPort = 43000;
  const createServer = (_options: unknown, handler: Function) => {
    const server = Object.assign(new EventEmitter(), {
      listening: false, host: '', port: 0, handler,
      listen(port: number, host: string, ready: () => void = () => {}) {
        Object.assign(server, { listening: true, host, port: port || nextPort++ });
        servers.set(server.port, server); queueMicrotask(ready); return server;
      },
      address: () => ({ address: server.host, port: server.port }),
      setTimeout() {}, unref() {},
      closeAllConnections() {},
      close(done: () => void) { servers.delete(server.port); server.listening = false; done(); },
    });
    return server;
  };
  const request = (options: any, onResponse: Function) => {
    const chunks: Buffer[] = [];
    let incoming: Readable | undefined, response: any, socket: any;
    const outgoing = new Writable({
      autoDestroy: false,
      write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        queueMicrotask(() => {
          if (outgoing.destroyed) return;
          const server = servers.get(Number(options.port));
          if (!server) { outgoing.destroy(Error('Connection refused')); return; }
          response = Object.assign(new PassThrough(), {
            headers: {} as Record<string, string>, headersSent: false, statusCode: 200,
            setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; },
            writeHead(status: number) { response.statusCode = status; response.headersSent = true; onResponse(response); },
          });
          socket = Object.assign(new EventEmitter(), {
            remoteAddress: '10.0.0.2', destroyed: false, setTimeout() { return socket; },
            destroy() {
              if (socket.destroyed) return;
              socket.destroyed = true; sockets.delete(socket);
              if (!response.writableEnded) {
                response.emit('aborted'); response.destroy(); outgoing.destroy(Error('Socket closed before response'));
              }
              socket.emit('close');
            },
          });
          sockets.add(socket); server.emit('connection', socket);
          incoming = Object.assign(Readable.from(chunks), {
            method: options.method ?? 'GET', url: options.path, socket,
            headers: Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
          });
          server.handler(incoming, response);
        });
        done();
      },
      destroy(error, done) { incoming?.destroy(); response?.destroy(); done(error); },
    });
    return outgoing;
  };
  const spies = [vi.spyOn(http, 'createServer').mockImplementation(createServer as any),
    vi.spyOn(https, 'createServer').mockImplementation(createServer as any),
    vi.spyOn(http, 'request').mockImplementation(request as any)];
  let origin = '', token = '';
  const send = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(path, origin);
    const headers = { host: url.host, origin: url.origin, ...Object.fromEntries(new Headers(init.headers).entries()) };
    const sent = request({ port: url.port, path: url.pathname, method: init.method, headers }, (response: any) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('aborted', () => reject(Error('Socket closed before response')));
      response.once('error', reject);
      response.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    sent.once('error', reject); sent.end(init.body);
  });
  let replays = 0;
  let heldTool: { name: string; requested: () => void; responded: (status: number) => void;
    requestGate: Promise<void>; responseGate: Promise<void> } | undefined;
  // Model a transport replay after a connection closes without response
  // headers. Production createCompanionClient never retries a mutation.
  const fetch = async (path: string, init: RequestInit = {}) => {
    const hold = path === '/tool' && typeof init.body === 'string'
      && JSON.parse(init.body).name === heldTool?.name ? heldTool : undefined;
    if (hold) { heldTool = undefined; hold.requested(); await hold.requestGate; }
    try {
      const response = await send(path, init);
      if (hold) { hold.responded(response.status); await hold.responseGate; }
      return response;
    }
    catch (error) {
      if (!replayDroppedNavigation || path !== '/tool' || typeof init.body !== 'string'
        || JSON.parse(init.body).name !== 'navigate_experience') throw error;
      replays++; return send(path, init);
    }
  };
  return {
    fetch,
    // Separate transport gates reproduce requests overtaken by a source
    // transition and delayed refusals. The real server produces every reply.
    holdNextTool(name: string) {
      let requested!: () => void, responded!: (status: number) => void;
      let releaseRequest!: () => void, releaseResponse!: () => void;
      const request = new Promise<void>(resolve => { requested = resolve; });
      const response = new Promise<number>(resolve => { responded = resolve; });
      const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
      const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
      heldTool = { name, requested, responded, requestGate, responseGate };
      return { request, response, releaseRequest, releaseResponse };
    },
    get replays() { return replays; },
    async pair(companion: any) {
      origin = companion.url;
      const response = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: companion.pairingCode }) });
      token = (await response.json()).token;
      if (!token) throw Error('The fixture did not pair');
      return token;
    },
    close() { for (const socket of sockets) socket.destroy(); spies.forEach(spy => spy.mockRestore()); },
  };
}

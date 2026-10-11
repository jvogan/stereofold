/** Identify a server that cannot create the loopback owner listener. */
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: Promise<boolean> | undefined;
export function loopbackListenDenied(): Promise<boolean> {
  return cached ??= new Promise(done => {
    const server = net.createServer();
    server.once('error', error => done((error as NodeJS.ErrnoException).code === 'EPERM'));
    server.listen(0, '127.0.0.1', () => server.close(() => done(false)));
  });
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function headsetHostCommand(node = process.execPath): string {
  const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return `${shellQuote(node)} ${shellQuote(resolve(pluginRoot, 'dist/headset-host.mjs'))} 1CRN`;
}

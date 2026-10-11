/** Forward each Unix-socket connection to the current recorded scene owner. */
import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSceneOwnerRecord, SCENE_SERVICE_FILE } from '../src/scene-service.js';

export const defaultRecord = resolve(homedir(), SCENE_SERVICE_FILE);
export const defaultSocket = resolve(homedir(), '.stereofold/scene-service.sock');

export async function readSceneRelayTarget(recordPath: string): Promise<{ host: string; port: number }> {
  const handle = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) throw Error('the owner record is not a private regular file');
    const parsed = parseSceneOwnerRecord(JSON.parse(await handle.readFile('utf8')), process.getuid?.());
    if (!parsed.record) throw Error(parsed.reason ?? 'the owner record is invalid');
    const origin = new URL(parsed.record.origin);
    const port = Number(origin.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('the owner record has no usable port');
    return { host: origin.hostname, port };
  } finally { await handle.close(); }
}

async function removeIfOwned(path: string, inode: number): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current?.isSocket() && current.ino === inode) await unlink(path);
}

async function occupied(path: string): Promise<boolean> {
  return await new Promise(resolveConnect => {
    const client = net.connect(path);
    client.setTimeout(500);
    client.once('connect', () => { client.destroy(); resolveConnect(true); });
    client.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      resolveConnect(code !== 'ECONNREFUSED' && code !== 'ENOENT');
    });
    client.once('timeout', () => { client.destroy(); resolveConnect(true); });
  });
}

/**
 * A lock left by a relay that died mid-startup names a process that no
 * longer runs. Remove it, but only the file that was read, so a lock a live
 * relay took in the meantime survives.
 */
async function removeIfAbandoned(lockPath: string): Promise<void> {
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return;
  let inode: number, pid: number;
  try { inode = (await handle.stat()).ino; pid = Number((await handle.readFile('utf8')).trim()); }
  finally { await handle.close(); }
  // An empty file is a lock whose owner is still writing its pid.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
  const current = await lstat(lockPath).catch(() => undefined);
  if (current?.isFile() && current.ino === inode) await unlink(lockPath).catch(() => undefined);
}

async function lockSocket(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.startup.lock`;
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await removeIfAbandoned(lockPath);
      await new Promise(done => setTimeout(done, 50));
    }
  }
  if (!handle) throw Error(`Another relay startup holds ${lockPath}; check it before retrying.`);
  await handle.writeFile(`${process.pid}\n`);
  const inode = (await handle.stat()).ino;
  return async () => {
    await handle.close();
    const current = await lstat(lockPath).catch(() => undefined);
    if (current?.isFile() && current.ino === inode) await unlink(lockPath);
  };
}

export async function startSceneSocketRelay(recordPath = defaultRecord, socketPath = defaultSocket): Promise<() => Promise<void>> {
  if (!socketPath.startsWith('/') || socketPath.length > 100) throw Error('The socket path must be absolute and under 100 characters.');
  await readSceneRelayTarget(recordPath);
  const unlock = await lockSocket(socketPath);
  try {
    const previous = await lstat(socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (previous) {
      if (!previous.isSocket() || await occupied(socketPath)) throw Error(`A live relay or another file already holds ${socketPath}.`);
      await removeIfOwned(socketPath, previous.ino);
    }
    const server = net.createServer(client => {
      void readSceneRelayTarget(recordPath).then(({ host, port }) => {
        if (client.destroyed) return;
        const upstream = net.connect(port, host);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      }).catch(() => client.destroy());
    });
    const oldMask = process.umask(0o077);
    try {
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(socketPath, () => { server.off('error', fail); done(); });
      });
    } finally { process.umask(oldMask); }
    try { await chmod(socketPath, 0o600); }
    catch (error) { await new Promise<void>(done => server.close(() => done())); throw error; }
    const inode = (await lstat(socketPath)).ino;
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      const unlockStop = await lockSocket(socketPath);
      try {
        server.close();
        await removeIfOwned(socketPath, inode);
      } finally { await unlockStop(); }
    };
  } finally { await unlock(); }
}

if (process.argv[1] && basename(process.argv[1]).startsWith('scene-socket-relay')
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = process.argv[2] ? resolve(process.argv[2]) : defaultRecord;
  const socket = process.argv[3] ? resolve(process.argv[3]) : defaultSocket;
  try {
    const stop = await startSceneSocketRelay(record, socket);
    console.log(`relaying ${socket} to the current owner in ${record}`);
    process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}

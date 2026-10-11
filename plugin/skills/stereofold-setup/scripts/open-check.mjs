/**
 * Verify that the delivered plugin opens a structure without an agent host.
 * `setup-check.mjs` checks for prerequisites; this command opens the bundled
 * fixture and reports the result.
 *
 * So this launches `dist/server.mjs` exactly as a host launches it, speaks the
 * four messages a host speaks, opens the bundled fixture, and says what came
 * back. It is plain ESM with no dependencies, for the same reason
 * `setup-check.mjs` is.
 *
 *   node skills/stereofold-setup/scripts/open-check.mjs
 *   node skills/stereofold-setup/scripts/open-check.mjs --root /absolute/path
 *   node skills/stereofold-setup/scripts/open-check.mjs --pdb 1CRN
 *
 * The default route makes no network request. `--pdb` is the opposite: it asks
 * files.rcsb.org for that entry, which reveals this machine's IP address and
 * what it asked for, so pass it only when the user wants a real structure.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, isDirectInvocation } from './setup-check.mjs';

const FIXTURE = 'three-depth-markers';
const PROTOCOL_VERSION = '2025-06-18';
/** Long enough for a cold Mol* parse and an RCSB fetch, short enough to end. */
const REPLY_TIMEOUT_MS = 90_000;

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[++index];
      if (!value || !isAbsolute(value)) throw Error('--root must be an absolute path.');
      options.root = resolve(value);
      continue;
    }
    if (argument === '--pdb') {
      const value = argv[++index];
      if (!value || !/^[0-9A-Za-z]{4}$/.test(value)) throw Error('--pdb takes a four-character PDB ID, such as 1CRN.');
      options.pdbId = value;
      continue;
    }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    throw Error(`Unknown argument: ${argument}. Usage: open-check.mjs [--root /absolute/path] [--pdb 1CRN]`);
  }
  return options;
}

/**
 * One conversation with the server over its stdin and stdout.
 *
 * Newline-delimited JSON, one pending reply per id: this is the whole of the
 * stdio transport a host implements, written out so the check depends on
 * nothing that has to be installed first.
 */
export function connect(serverEntry, { spawnProcess = spawn, execPath = process.execPath } = {}) {
  const child = spawnProcess(execPath, [serverEntry], {
    cwd: resolve(serverEntry, '..', '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line === '') continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const settle = message.id == null ? undefined : pending.get(message.id);
      if (settle != null) { pending.delete(message.id); settle(message); }
    }
  });

  let nextId = 1;
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  return {
    stderr: () => stderr,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    request: (method, params) => new Promise((settle, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`${method} did not answer within ${REPLY_TIMEOUT_MS / 1000}s.${stderr === '' ? '' : `\n${stderr.trim()}`}`));
      }, REPLY_TIMEOUT_MS);
      pending.set(id, (message) => { clearTimeout(timer); settle(message); });
      send({ jsonrpc: '2.0', id, method, params });
    }),
    close: () => { child.kill(); },
  };
}

/** What an opened structure looks like, or the sentence that says it did not. */
export async function openCheck({ root, pdbId, connectTo = connect } = {}) {
  const serverEntry = join(root, 'dist/server.mjs');
  if (!existsSync(serverEntry)) {
    throw Error(`No server at ${serverEntry}. Re-extract stereofold-marketplace.tar.gz and verify SHA256SUMS from the extracted share root.`);
  }
  const session = connectTo(serverEntry);
  try {
    const initialize = await session.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'stereofold-open-check', version: '1' },
    });
    if (initialize.error != null) throw Error(`initialize failed: ${initialize.error.message}`);
    session.notify('notifications/initialized', {});
    const server = initialize.result?.serverInfo ?? {};

    const listed = await session.request('tools/list', {});
    if (listed.error != null) throw Error(`tools/list failed: ${listed.error.message}`);
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    if (!names.includes('stereo_structure.open')) {
      throw Error(`The server listed ${names.length} tools and none of them is stereo_structure.open.`);
    }

    const source = pdbId == null ? { fixture: FIXTURE } : { pdbId };
    const opened = await session.request('tools/call', { name: 'stereo_structure.open', arguments: source });
    if (opened.error != null) throw Error(`stereo_structure.open failed: ${opened.error.message}`);
    const state = opened.result?.structuredContent ?? {};
    if (opened.result?.isError === true || state.hasStructure !== true) {
      const said = opened.result?.content?.[0]?.text ?? JSON.stringify(state);
      throw Error(`stereo_structure.open returned no structure: ${said}`);
    }
    return {
      server: `${server.name ?? 'unknown'} ${server.version ?? ''}`.trim(),
      toolCount: names.length,
      source: pdbId == null ? `bundled fixture ${FIXTURE} (no network request)` : `PDB entry ${pdbId} from files.rcsb.org`,
      sessionId: state.sessionId,
      stderr: session.stderr(),
    };
  } finally {
    session.close();
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (options.help === true) {
    console.log('Usage: node skills/stereofold-setup/scripts/open-check.mjs [--root /absolute/path] [--pdb 1CRN]');
    return;
  }
  const root = options.root ?? findRoot({ env: process.env, start: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..') });
  if (root == null) {
    console.error('No Stereofold install above this script. Pass --root /absolute/path/to/stereofold.');
    process.exitCode = 1;
    return;
  }
  try {
    const report = await openCheck({ root, pdbId: options.pdbId });
    console.log('Stereofold open check');
    console.log(`  server        ${report.server}`);
    console.log(`  install       ${root}`);
    console.log(`  tools         ${report.toolCount} advertised, stereo_structure.open present`);
    console.log(`  opened        ${report.source}`);
    console.log(`  sessionId     ${report.sessionId}`);
    const notes = report.stderr.trim();
    if (notes !== '') {
      console.log('');
      console.log('The server said this while starting. Each line reports one optional feature, on or off:');
      for (const line of notes.split('\n')) console.log(`  ${line}`);
    }
    console.log('');
    console.log('OPEN PASS — this install opened a structure over stdio.');
  } catch (error) {
    console.error('OPEN FAILED');
    console.error(error.message);
    console.error('recovery: re-read “6. Verify the requested workflow” in skills/stereofold-setup/SKILL.md for this failure');
    process.exitCode = 1;
  }
}

if (isDirectInvocation(import.meta.url)) await main();

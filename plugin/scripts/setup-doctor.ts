/**
 * Read-only readiness checks for the packaged standalone host and Quest LAN
 * setup. This command deliberately does not bind, connect, repair, or print
 * local control capabilities.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatBuildIdentities, readStampedBuildId } from '../src/build-identity.js';
import { buildInputPaths, hashBuildInputs, isBuildInputEntry, readBuildInputStamp } from '../src/build-inputs.js';
import { formatReadiness, type Readiness } from '../src/inspection-contract.js';
import { callLocalAgent, readControlState, type AgentResult, type ControlState } from './local-agent.js';

type Check = 'ok' | 'warning' | 'error' | 'not-provided';
type PortState = 'available' | 'listening' | 'unknown';

export type LanAddress = { interface: string; address: string };
type InterfaceEntry = { address: string; family: string | number; internal: boolean };
type InterfaceProvider = () => Record<string, InterfaceEntry[] | undefined>;
/**
 * `state` is a modification-time heuristic; `stamps` is not. The two bundles
 * hash themselves at build time, so these are the identities a mounted panel
 * reports back in `diagnostics.viewerBuild`, read here before anything mounts.
 * Codex runs its own installed copy of `dist/` and Claude Code runs this
 * checkout's, so printing them is what makes two hosts on different builds one
 * line of reading instead of an install audit.
 */
export type BuildStamps = { viewer: string | null; inspector: string | null };
/**
 * Whether the emitted runtime was built from the sources now on disk.
 *
 * This is the answer that decides the build line, because it is about bytes.
 * `fresh` and `stale` both carry the digest of the sources as they are now;
 * `stale` also carries the digest the build recorded, so two hosts comparing
 * notes can see that they disagree rather than each being told "stale".
 * `unknown` is what a dist with no stamp gets — a release artifact, or
 * anything built before `scripts/build.ts` started recording one — and it
 * hands the verdict back to the modification-time heuristic rather than
 * guessing.
 */
export type BuildContentHealth =
  | { state: 'fresh'; hash: string }
  | { state: 'stale'; hash: string; recorded: string }
  | { state: 'unknown'; reason: string };
/**
 * `state` is the verdict a reader should act on: the content check when there
 * is one, the modification-time heuristic when there is not. `heuristic` says
 * which of the two it came from, and `mtime` keeps the heuristic's own answer
 * as a secondary note — a checkout whose content is fresh and whose mtimes say
 * stale is the normal state of a second worktree, and saying so costs one
 * clause and stops an operator rebuilding for nothing.
 */
export type BuildHealth = { state: 'fresh' | 'stale' | 'missing' | 'source-unavailable'; files: string[]; heuristic: boolean;
  stamps: BuildStamps; content: BuildContentHealth; mtime: 'fresh' | 'stale' | 'source-unavailable' | 'not-checked' };
export type ControlHealth = { state: 'secure' | 'missing' | 'invalid' | 'insecure' | 'unreadable' | 'not-provided' };
export type DoctorReport = {
  ready: boolean;
  prerequisitesReady: boolean;
  node: { check: Check; version: string; required: string };
  openssl: { check: Check; version?: string };
  build: BuildHealth;
  lan: { check: Check; addresses: LanAddress[] };
  port: { state: PortState; port: number };
  controlFile: ControlHealth;
};

export type PortCommand = (command: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;
const execFileAsync = promisify(execFile);
// lsof reads every process's open files. At a load average of 700 it took
// longer than the earlier 2 s, and the share refused to start.
const COMMAND_TIMEOUT_MS = 10_000;
const runCommand: PortCommand = async (file, args) =>
  execFileAsync(file, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 });
const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeFiles = ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js'];

export function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
}

export function listPrivateLanAddresses(interfaces: InterfaceProvider = networkInterfaces): LanAddress[] {
  return Object.entries(interfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4) && isPrivateIpv4(entry.address))
    .map(entry => ({ interface: name, address: entry.address })))
    .sort((left, right) => left.interface.localeCompare(right.interface) || left.address.localeCompare(right.address));
}

async function newestRegularFile(path: string): Promise<number | undefined> {
  let details;
  try { details = await stat(path); } catch { return undefined; }
  if (details.isFile()) return details.mtimeMs;
  if (!details.isDirectory()) return undefined;
  let newest: number | undefined;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!isBuildInputEntry(entry.name)) continue;
    const candidate = await newestRegularFile(resolve(path, entry.name));
    if (candidate != null) newest = Math.max(newest ?? candidate, candidate);
  }
  return newest;
}

/**
 * Did this dist come from these sources?
 *
 * Two answers, and the order matters. The content check compares the digest
 * `scripts/build.ts` recorded of everything it read against the same digest
 * taken now: equal is proof, unequal is proof of the opposite, and neither
 * depends on a clock. The modification-time comparison stays, because a dist
 * built before the stamp existed still has to be judged somehow, but it is
 * only the verdict when there is no stamp to read — a fresh checkout rewrites
 * every source mtime and none of the dist ones, which is how a byte-perfect
 * runtime in a development worktree used to report itself stale.
 *
 * Both answers are returned either way, so a disagreement between them is
 * readable rather than hidden.
 */
export async function inspectBuild(root = pluginRoot): Promise<BuildHealth> {
  const dist = resolve(root, 'dist');
  const files: string[] = [];
  let oldestArtifact = Infinity;
  let requiredRuntime = runtimeFiles;
  try {
    if ((await readFile(resolve(dist, 'inspector.html'), 'utf8')).includes('STEREOFOLD_INSPECTOR_SCRIPT_'))
      requiredRuntime = [...runtimeFiles, 'inspector-script-1.js', 'inspector-script-2.js'];
  } catch { /* The ordinary missing-file check below reports unreadable HTML. */ }
  for (const file of requiredRuntime) {
    try {
      const details = await stat(resolve(dist, file));
      if (!details.isFile() || details.size === 0) files.push(file);
      else oldestArtifact = Math.min(oldestArtifact, details.mtimeMs);
    } catch { files.push(file); }
  }
  const [viewer, inspector] = await Promise.all([
    readStampedBuildId(resolve(dist, 'viewer.html')),
    readStampedBuildId(resolve(dist, 'inspector.html')),
  ]);
  const stamps: BuildStamps = { viewer, inspector };
  if (files.length > 0) {
    return { state: 'missing', files, heuristic: false, stamps, mtime: 'not-checked',
      content: { state: 'unknown', reason: 'runtime files are missing, so nothing was compared' } };
  }
  const inputTimes = await Promise.all(buildInputPaths(root).map(newestRegularFile));
  const newestSource = inputTimes.reduce<number | undefined>((latest, current) => current == null ? latest : Math.max(latest ?? current, current), undefined);
  const mtime = newestSource == null ? 'source-unavailable' as const : newestSource > oldestArtifact ? 'stale' as const : 'fresh' as const;
  const content = await inspectBuildContent(root, dist);
  const state = content.state === 'unknown' ? (mtime === 'source-unavailable' ? 'source-unavailable' as const : mtime) : content.state;
  return { state, files: [], heuristic: content.state === 'unknown', stamps, content, mtime };
}

/** The stamp against a fresh digest of the same inputs. Never guesses when either side is absent. */
async function inspectBuildContent(root: string, dist: string): Promise<BuildContentHealth> {
  const stamp = await readBuildInputStamp(dist);
  if (!stamp) return { state: 'unknown', reason: 'no stamp' };
  const inputs = await hashBuildInputs(root);
  if (!inputs) return { state: 'unknown', reason: 'sources unavailable' };
  return inputs.hash === stamp.hash
    ? { state: 'fresh', hash: inputs.hash }
    : { state: 'stale', hash: inputs.hash, recorded: stamp.hash };
}

export async function inspectPort(port: number, command: PortCommand = runCommand): Promise<PortState> {
  const ask = () => command('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'n']);
  try {
    // execFile kills a command that outlives its timeout, so a killed lsof
    // gets one more try. A missing or refused lsof fails on the first.
    const result = await ask().catch(async (error: unknown) => {
      if ((error as { killed?: unknown }).killed === true) return ask();
      throw error;
    });
    return result.stdout.trim() === '' ? 'available' : 'listening';
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    return failure.code === 1 && (typeof failure.stderr !== 'string' || failure.stderr.trim() === '') ? 'available' : 'unknown';
  }
}

/** Validate an explicitly supplied control file without retaining or reporting its contents. */
export async function inspectControlFile(path?: string): Promise<ControlHealth> {
  if (path == null) return { state: 'not-provided' };
  try {
    const link = await lstat(path);
    if (!link.isFile() || link.isSymbolicLink()) return { state: 'invalid' };
    if ((link.mode & 0o777) !== 0o600) return { state: 'insecure' };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      if (!details.isFile() || (details.mode & 0o777) !== 0o600) return { state: 'insecure' };
      if (details.size > 64 * 1024) return { state: 'invalid' };
      if (typeof details.uid === 'number' && typeof process.getuid === 'function' && details.uid !== process.getuid()) return { state: 'insecure' };
      let value: unknown;
      try { value = JSON.parse(await handle.readFile({ encoding: 'utf8' })); } catch { return { state: 'invalid' }; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid' };
      const control = value as Record<string, unknown>;
      if (typeof control.token !== 'string' || !/^[a-f0-9]{64}$/.test(control.token)
        || typeof control.sessionId !== 'string' || control.sessionId.length === 0 || control.sessionId.length > 256
        || typeof control.origin !== 'string') return { state: 'invalid' };
      let origin: URL;
      try { origin = new URL(control.origin); } catch { return { state: 'invalid' }; }
      return origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && /^\d+$/.test(origin.port)
        && origin.username === '' && origin.password === '' && origin.pathname === '/' && origin.search === '' && origin.hash === '' && origin.origin === control.origin
        ? { state: 'secure' } : { state: 'invalid' };
    } finally { await handle.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
}

async function inspectOpenSsl(command: PortCommand): Promise<{ check: Check; version?: string }> {
  try {
    const result = await command('openssl', ['version']);
    const version = result.stdout.trim().split(/\r?\n/u)[0];
    return version ? { check: 'ok', version } : { check: 'error' };
  } catch { return { check: 'error' }; }
}

export async function runDoctor({ root = pluginRoot, port = 8443, controlFile, interfaces = networkInterfaces,
  command = runCommand,
  nodeVersion = process.versions.node }: { root?: string; port?: number; controlFile?: string; interfaces?: InterfaceProvider; command?: PortCommand; nodeVersion?: string } = {}): Promise<DoctorReport> {
  const [build, openssl, portState, controlFileHealth] = await Promise.all([inspectBuild(root), inspectOpenSsl(command), inspectPort(port, command), inspectControlFile(controlFile)]);
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  const node = { check: Number.isInteger(major) && major >= 22 ? 'ok' as const : 'error' as const, version: nodeVersion, required: '22+' };
  const addresses = listPrivateLanAddresses(interfaces);
  const lan = { check: addresses.length > 0 ? 'ok' as const : 'warning' as const, addresses };
  const buildError = build.state === 'missing' || build.state === 'stale';
  const controlError = controlFileHealth.state !== 'secure' && controlFileHealth.state !== 'not-provided';
  const prerequisitesReady = node.check === 'ok' && openssl.check === 'ok' && !buildError && lan.check === 'ok' && !controlError;
  return { ready: prerequisitesReady && portState === 'available', prerequisitesReady,
    node, openssl, build, lan, port: { state: portState, port }, controlFile: controlFileHealth };
}

/**
 * The second half of the answer: what a *running* host says about the session
 * itself.
 *
 * Everything above this line is read off a checkout, which is why it can be
 * answered before anything starts. It cannot see whether a scene is saved,
 * whether a headset paired, whether an agent is listening, or whether the
 * microphone and the spoken reply resolved — and those are the four that
 * actually decide whether putting the headset on is worth doing. Naming the
 * host's share file asks it, and prints the same block the agent CLI and
 * headset-drive print.
 */
export async function readHostReadiness(sharePath: string, { speechCheck = false }: { speechCheck?: boolean } = {},
  call: (state: ControlState, name: string, args: Record<string, unknown>) => Promise<AgentResult>
    = (state, name, args) => callLocalAgent(state, name, args)): Promise<Readiness> {
  const state = await readControlState(sharePath);
  const answer = await call(state, 'get_readiness', { sessionId: state.sessionId, ...(speechCheck ? { speechCheck: true } : {}) });
  const readiness = (answer.structuredContent as { readiness?: Readiness } | undefined)?.readiness;
  if (!readiness) throw Error('That host answered get_readiness with no readiness block, so it is older than this checkout. Restart the host from here.');
  return readiness;
}

const usage = 'Usage: setup-doctor.ts [--port 8443] [--control-file /absolute/control.json] [--share /absolute/share.json] [--speech-check] [--json]';
export function parseDoctorArgs(args: string[]): { json: boolean; port: number; controlFile?: string; share?: string; speechCheck?: true; help?: true } {
  let json = false, port = 8443, controlFile: string | undefined, share: string | undefined, speechCheck: true | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') { json = true; continue; }
    if (argument === '--speech-check') { speechCheck = true; continue; }
    if (argument === '--share') {
      const value = args[++index];
      if (!value || !isAbsolute(value)) throw Error('--share must be the absolute path of a running host’s control file.');
      share = resolve(value); continue;
    }
    if (argument === '--port') {
      const value = args[++index]; const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw Error('--port must be an integer from 1 through 65535.');
      port = parsed; continue;
    }
    if (argument === '--control-file') {
      const value = args[++index];
      if (!value || !isAbsolute(value)) throw Error('--control-file must be an absolute path.');
      controlFile = resolve(value); continue;
    }
    if (argument === '--help' || argument === '-h') return { json, port, controlFile, share, ...(speechCheck ? { speechCheck } : {}), help: true };
    throw Error(`Unknown argument: ${argument}`);
  }
  if (speechCheck && !share) throw Error('--speech-check needs --share: only a running host can render a clip.');
  return { json, port, controlFile, share, ...(speechCheck ? { speechCheck } : {}) };
}

function line(mark: string, value: string) { return `${mark} ${value}`; }

/**
 * The build verdict in the operator's words: what was compared, and what it
 * said. `fresh (hash)` and `stale (hash)` are the content check; `unknown (no
 * stamp)` means the dist carries none and the modification-time note behind it
 * is all there is.
 */
export function describeBuildContent(content: BuildContentHealth): string {
  return content.state === 'unknown' ? `unknown (${content.reason})` : `${content.state} (${content.hash.slice(0, 12)})`;
}

export function formatDoctor(report: DoctorReport): string {
  // The content check leads and the modification times follow it, because the
  // times are the half that is wrong in a second checkout and an operator who
  // reads them first rebuilds a runtime that was already correct.
  const contentNote = `source hash ${describeBuildContent(report.build.content)}`;
  const mtimeNote = report.build.mtime === 'fresh' ? 'modification times agree'
    : report.build.mtime === 'stale' ? 'modification times say older than source'
      : report.build.mtime === 'source-unavailable' ? 'source unavailable for the modification-time check' : 'modification times not checked';
  const build = report.build.state === 'missing' ? `runtime files missing: ${report.build.files.join(', ')}; run pnpm run build`
    : report.build.state === 'stale' ? `${report.build.heuristic ? 'runtime build appears older than source' : 'runtime build does not match plugin/src'}`
      + `; run pnpm run build — ${contentNote}, ${mtimeNote}`
      : report.build.state === 'source-unavailable' ? `packaged runtime present (source unavailable; freshness not checked) — ${contentNote}`
        : `${report.build.heuristic ? 'packaged runtime appears current by modification time' : 'packaged runtime was built from plugin/src as it is now'}`
          + ` — ${contentNote}, ${mtimeNote}`;
  const lan = report.lan.addresses.length === 0 ? 'no assigned RFC1918 IPv4 address; join the intended Wi-Fi before Open on Quest'
    : report.lan.addresses.map(entry => `${entry.interface} ${entry.address}`).join(', ');
  const port = report.port.state === 'available' ? `TCP ${report.port.port} has no listening process`
    : report.port.state === 'listening' ? `TCP ${report.port.port} is already listening; use that owned session or choose another port`
      : `could not determine TCP ${report.port.port} occupancy (lsof missing, denied, or timed out twice)`;
  const control = report.controlFile.state === 'not-provided' ? 'not checked'
    : report.controlFile.state === 'secure' ? 'secure regular 0600 control file'
      : `control file ${report.controlFile.state}; do not use it until the standalone host recreates it`;
  const headline = report.ready ? 'READY' : report.prerequisitesReady ? 'PREREQUISITES HEALTHY — PORT NEEDS ATTENTION' : 'ATTENTION';
  return ['Stereofold setup doctor: ' + headline,
    line(report.node.check === 'ok' ? 'OK' : '!!', `Node ${report.node.version} (requires ${report.node.required})`),
    line(report.openssl.check === 'ok' ? 'OK' : '!!', report.openssl.version ? `OpenSSL ${report.openssl.version}` : 'OpenSSL unavailable; local LAN certificate creation needs openssl'),
    line(report.build.state === 'fresh' || report.build.state === 'source-unavailable' ? 'OK' : '!!', build),
    line(report.lan.check === 'ok' ? 'OK' : '!!', `private LAN: ${lan}`),
    line(report.port.state === 'unknown' ? '!!' : 'OK', port),
    line(report.controlFile.state === 'secure' || report.controlFile.state === 'not-provided' ? 'OK' : '!!', `control file: ${control}`),
    // The one line to compare between hosts: it must equal the
    // `diagnostics.viewerBuild` a mounted panel reports, and the same line
    // printed by whatever other host is running this plugin.
    line(report.build.stamps.viewer == null || report.build.stamps.inspector == null ? '!!' : 'OK',
      `build · ${formatBuildIdentities(report.build.stamps)}`),
  ].join('\n');
}

// dist/headset-host.mjs bundles this module, and inside a bundle every module
// shares the entry point's import.meta.url, so the name check is what keeps
// the doctor from running beside the headset host.
if (process.argv[1] && basename(process.argv[1]).startsWith('setup-doctor')
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDoctorArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      const report = await runDoctor(options);
      // A named host is asked before anything prints, so one failure mode —
      // "the host this doctor was pointed at is not running" — does not arrive
      // underneath a block of green lines that say the Mac is fine.
      const readiness = options.share
        ? await readHostReadiness(options.share, { speechCheck: options.speechCheck === true })
        : undefined;
      console.log(options.json ? JSON.stringify({ ...report, ...(readiness ? { readiness } : {}) }, null, 2) : formatDoctor(report));
      if (readiness && !options.json) console.log(`\n${formatReadiness(readiness)}`);
      if (!report.ready || (readiness && !readiness.ready)) process.exitCode = 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}

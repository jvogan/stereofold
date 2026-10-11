/** Discover an already authorized Quest; reconnect only a named, private endpoint. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { forgetLocalConfig, localConfigPath, readLocalConfig, type LocalConfig } from './local-helper-config.js';

export const QUEST_ADDRESS_ENV = 'STEREOFOLD_QUEST_ADDRESS';
export const QUEST_ADDRESS_CONFIG_KEY = 'questAddress';
export const VERIFIED_QUEST_ADDRESS_CONFIG_KEY = 'verifiedQuestAddress';
export const VERIFIED_QUEST_SERIAL_CONFIG_KEY = 'verifiedQuestSerial';
const MAX_DEVICES = 8;
const MAX_CONFIG_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 8_000;

type Result = { code: number; stdout: string; stderr: string };
export type QuestConnectionRunner = (command: string, args: readonly string[]) => Promise<Result>;
export type QuestConnectionReason = 'ready' | 'unavailable' | 'unauthorized' | 'ambiguous' | 'not-quest' | 'configured-unavailable' | 'invalid-endpoint' | 'failed';
export type QuestConnectionDiagnostic = {
  stage: 'devices' | 'identity' | 'connect' | 'relist';
  kind: 'no-route' | 'timeout' | 'offline' | 'command-error';
  detail: string;
  hint: string;
};
export type QuestConnection = { serial?: string; reason: QuestConnectionReason; reconnected?: boolean; remembered?: boolean; diagnostic?: QuestConnectionDiagnostic };
export type QuestConnectionOptions = {
  adb: string;
  run: QuestConnectionRunner;
  environment?: NodeJS.ProcessEnv;
  config?: LocalConfig;
  home?: string;
  serial?: string;
  /** A smaller deadline for tests or callers; never exceeds eight seconds. */
  timeoutMs?: number;
  /** Opt out of remembering a verified wireless connection. */
  remember?: boolean;
  /** Status checks can inspect attached transports without reconnecting one. */
  reconnect?: boolean;
};
type Device = { serial: string; state: string };
type Identity = { quest: boolean; hardwareSerial?: string };

/** Keep bounded command evidence; strip terminal controls and accidental credentials. */
function connectionDiagnostic(stage: QuestConnectionDiagnostic['stage'], raw: string,
  kind?: QuestConnectionDiagnostic['kind']): QuestConnectionDiagnostic {
  const clean = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@').trim();
  const detail = clean.length > 1024 ? `${clean.slice(0, 1009)}... [truncated]` : clean;
  kind ??= /no route to host|network is unreachable/i.test(clean) ? 'no-route'
    : /timed? out|timeout|ETIMEDOUT/i.test(clean) ? 'timeout'
      : /\boffline\b/i.test(clean) ? 'offline' : 'command-error';
  const hint = kind === 'no-route'
    ? 'If the known endpoint answers ping or TCP, retain its address: this may be a host adb daemon or local-network permission problem, not a changed IP. Check the daemon and host permissions; coordinate before restarting adb because adb kill-server drops every debugging connection. This error alone does not establish the cause.'
    : kind === 'timeout' || kind === 'offline'
      ? 'The transport may be asleep or unresponsive; this does not prove either. If the known IP answers ping or TCP, retain it. Wake through a working authorized route or ask the wearer to put on the headset or press its power button once, then retry the known endpoint. Web Launch and manual pairing remain separate routes.'
      : 'This debugging command failed; it does not establish headset power or browser reachability. Check this command and the selected authorized transport before retrying; Web Launch and manual pairing remain available.';
  return { stage, kind, detail, hint };
}

/** Hostnames, public addresses, IPv6, and bare IPs are deliberately refused. */
export function privateQuestEndpoint(value: string): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value.trim());
  if (!match) return undefined;
  const bytes = match.slice(1, 5).map(Number), port = Number(match[5]);
  if (bytes.some((byte, index) => byte > 255 || String(byte) !== match[index + 1]) || port < 1 || port > 65535) return undefined;
  if (!(bytes[0] === 10 || bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31 || bytes[0] === 192 && bytes[1] === 168)) return undefined;
  return `${bytes.join('.')}:${port}`;
}

function devices(stdout: string): Device[] {
  return stdout.split(/\r?\n/).flatMap(line => {
    const match = /^([^\s]+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)/.exec(line.trim());
    return match ? [{ serial: match[1], state: match[2] }] : [];
  });
}

function identity(stdout: string): Identity {
  const properties = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]: \[([^\]]*)\]\s*$/.exec(line.trim());
    if (match) properties.set(match[1], match[2].trim());
  }
  // Product model names identify the headset; the presence of Quest Browser alone
  // is insufficient because Android packages can be installed on other devices.
  const model = properties.get('ro.product.model') ?? '';
  const quest = /^(?:(?:Meta|Oculus)\s+)?Quest(?:\s+(?:2|3S?|Pro))?$/i.test(model);
  const hardwareSerial = [properties.get('ro.serialno'), properties.get('ro.boot.serialno')]
    .find(value => value && /^(?!unknown$)[A-Za-z0-9_-]{1,128}$/i.test(value));
  return { quest, ...(hardwareSerial ? { hardwareSerial } : {}) };
}

/** Preserve every existing config key, and never replace unreadable/malformed settings. */
function rememberConnection(endpoint: string, hardwareSerial: string | undefined, environment: NodeJS.ProcessEnv, home: string): boolean {
  let temporary: string | undefined;
  let descriptor: number | undefined;
  try {
    const path = localConfigPath(environment, home);
    let settings: Record<string, unknown> = {};
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return false;
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      settings = parsed as Record<string, unknown>;
    }
    if (settings[VERIFIED_QUEST_ADDRESS_CONFIG_KEY] === endpoint && settings[VERIFIED_QUEST_SERIAL_CONFIG_KEY] === hardwareSerial) return false;
    settings[VERIFIED_QUEST_ADDRESS_CONFIG_KEY] = endpoint;
    if (hardwareSerial) settings[VERIFIED_QUEST_SERIAL_CONFIG_KEY] = hardwareSerial;
    else delete settings[VERIFIED_QUEST_SERIAL_CONFIG_KEY];
    const contents = `${JSON.stringify(settings, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) return false;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) return false;
    temporary = join(directory, `.quest-connection-${randomUUID()}.tmp`);
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    temporary = undefined;
    forgetLocalConfig();
    return true;
  } catch { return false; }
  finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Already closed. */ } }
    if (temporary) { try { unlinkSync(temporary); } catch { /* No temporary file remains. */ } }
  }
}

export async function resolveQuestConnection(options: QuestConnectionOptions): Promise<QuestConnection> {
  const { adb, run, environment = process.env, config, home = homedir() } = options;
  const settings = config ?? readLocalConfig({ env: environment, home });
  const configuredAddress = (environment[QUEST_ADDRESS_ENV] || settings[QUEST_ADDRESS_CONFIG_KEY])?.trim();
  const selected = (options.serial || environment.STEREOFOLD_QUEST_SERIAL || settings.questSerial || environment.STEREOFOLD_ADB_SERIAL || environment.ANDROID_SERIAL || configuredAddress)?.trim();
  const rememberedAddress = settings[VERIFIED_QUEST_ADDRESS_CONFIG_KEY]?.trim();
  const namedEndpoint = selected?.includes(':') ? selected : configuredAddress;
  if (namedEndpoint && !privateQuestEndpoint(namedEndpoint)) return { reason: 'invalid-endpoint' };
  const endpoint = privateQuestEndpoint(namedEndpoint || rememberedAddress || '');
  const expectedHardwareSerial = selected && !selected.includes(':') ? selected
    : !namedEndpoint ? settings[VERIFIED_QUEST_SERIAL_CONFIG_KEY]?.trim() : undefined;
  // An injected config is a read-only seam unless its storage is explicitly named.
  const canRemember = options.remember !== false && (config === undefined || options.home !== undefined || Boolean(environment.STEREOFOLD_CONFIG));
  const duration = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(TOTAL_TIMEOUT_MS, options.timeoutMs!)) : TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + duration;
  let expired = false;
  let diagnostic: QuestConnectionDiagnostic | undefined;
  const failure = (reason: QuestConnectionReason, evidence = diagnostic): QuestConnection =>
    ({ reason, ...(evidence ? { diagnostic: evidence } : {}) });
  const offline = (device: Device, stage: QuestConnectionDiagnostic['stage'] = 'devices') =>
    connectionDiagnostic(stage, `adb lists ${device.serial} as offline.`, 'offline');
  async function call(args: readonly string[], stage: QuestConnectionDiagnostic['stage']): Promise<Result | undefined> {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || expired) {
      expired = true;
      diagnostic ??= connectionDiagnostic(stage, 'The bounded adb discovery deadline elapsed before the next command.', 'timeout');
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const waitMs = Math.min(COMMAND_TIMEOUT_MS, remaining);
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => {
        expired = true;
        diagnostic = connectionDiagnostic(stage, `adb ${stage} did not answer within ${waitMs} ms.`, 'timeout');
        resolve(undefined);
      }, waitMs); });
      const answer = await Promise.race([Promise.resolve().then(() => run(adb, args)).catch(error => {
        diagnostic = connectionDiagnostic(stage, error instanceof Error ? error.message : String(error));
        return undefined;
      }), timeout]);
      if (answer && answer.code !== 0)
        diagnostic = connectionDiagnostic(stage, [answer.stderr, answer.stdout].filter(value => value.trim()).join('\n') || `adb ${stage} exited with status ${answer.code}.`);
      return answer;
    } finally { if (timer) clearTimeout(timer); }
  }
  async function probe(serial: string): Promise<Identity | undefined> {
    const answer = await call(['-s', serial, 'shell', 'getprop'], 'identity');
    return answer?.code === 0 ? identity(answer.stdout) : undefined;
  }
  function ready(serial: string, found: Identity, reconnected = false, rememberedTransport = serial): QuestConnection {
    const wireless = privateQuestEndpoint(rememberedTransport);
    if (wireless && wireless === endpoint && expectedHardwareSerial && found.hardwareSerial !== expectedHardwareSerial)
      return { reason: 'configured-unavailable' };
    const remembered = Boolean(wireless && canRemember && rememberConnection(wireless, found.hardwareSerial, environment, home));
    return { serial, reason: 'ready', ...(reconnected ? { reconnected: true } : {}), ...(remembered ? { remembered: true } : {}) };
  }
  const listed = await call(['devices'], 'devices');
  if (!listed || listed.code !== 0) return failure('failed');
  const attached = devices(listed.stdout);
  if (selected) {
    const device = attached.find(item => item.serial === selected);
    if (device?.state === 'unauthorized') return { reason: 'unauthorized' };
    if (device?.state === 'device') {
      const found = await probe(selected);
      if (!found) return failure('failed');
      if (!found.quest) return { reason: 'not-quest' };
      const primary = ready(selected, found);
      if (!privateQuestEndpoint(selected) && found.hardwareSerial && canRemember) {
        // A selected USB headset can already have a wireless transport. Verify
        // only listed private aliases so unplugging its cable can reuse one.
        const aliases = attached.filter(item => item.state === 'device' && privateQuestEndpoint(item.serial)).slice(0, MAX_DEVICES);
        for (const alias of aliases) {
          const wireless = await probe(alias.serial);
          if (wireless?.quest && wireless.hardwareSerial === found.hardwareSerial) {
            const remembered = ready(selected, found, false, alias.serial);
            return remembered.reason === 'ready' ? remembered : primary;
          }
          if (expired) break;
        }
      }
      // Optional alias discovery must never turn a working USB choice into a
      // failed launch, including when its probe exhausts the total deadline.
      return primary;
    }
  } else {
    const candidates = attached.filter(item => item.state === 'device');
    // Refuse excess/ambiguous devices rather than probing an unbounded list.
    if (candidates.length > MAX_DEVICES) return { reason: 'ambiguous' };
    const quests: Array<{ serial: string; found: Identity }> = [];
    let failed = false;
    for (const device of candidates) {
      const found = await probe(device.serial);
      if (!found) failed = true;
      else if (found.quest) quests.push({ serial: device.serial, found });
      if (expired) return failure('failed');
    }
    if (quests.length > 1) {
      const sharedIdentity = quests[0].found.hardwareSerial;
      if (!sharedIdentity || quests.some(quest => quest.found.hardwareSerial !== sharedIdentity)) return { reason: 'ambiguous' };
      // USB and Wi-Fi can list the same headset twice. Prefer its USB transport
      // only when every queried transport reports the same hardware identity.
      const preferred = quests.find(quest => !privateQuestEndpoint(quest.serial)) ?? quests[0];
      const wireless = quests.find(quest => privateQuestEndpoint(quest.serial));
      if (!failed) return ready(preferred.serial, preferred.found, false, wireless?.serial ?? preferred.serial);
    }
    // A failed identity query could hide a second Quest; never guess its target.
    if (failed) return failure('failed');
    if (quests.length === 1) return ready(quests[0].serial, quests[0].found);
  }
  if (endpoint) {
    // An explicit USB choice may reconnect through its remembered Wi-Fi alias,
    // but the endpoint's reported hardware serial must still match that choice.
    if (selected && !selected.includes(':') && !configuredAddress && settings[VERIFIED_QUEST_SERIAL_CONFIG_KEY] !== selected)
      return { reason: 'configured-unavailable' };
    const known = attached.find(item => item.serial === endpoint);
    if (known?.state === 'unauthorized') return { reason: 'unauthorized' };
    if (known?.state === 'device') {
      const found = await probe(endpoint);
      if (!found) return failure('failed');
      if (!found.quest) return { reason: 'not-quest' };
      if (selected && !selected.includes(':') && found.hardwareSerial !== selected) return { reason: 'configured-unavailable' };
      return ready(endpoint, found);
    }
    if(options.reconnect===false) return failure(selected?'configured-unavailable':'unavailable', known?.state === 'offline' ? offline(known) : undefined);
    const connected = await call(['connect', endpoint], 'connect');
    if (connected?.code === 0 && /failed to connect|cannot connect|unable to connect|no route to host|network is unreachable|timed? out|connection refused|connection reset/i.test(`${connected.stderr}\n${connected.stdout}`))
      diagnostic = connectionDiagnostic('connect', [connected.stderr, connected.stdout].filter(value => value.trim()).join('\n'));
    if (!connected || connected.code !== 0 || diagnostic?.stage === 'connect')
      return failure(expired ? 'failed' : selected ? 'configured-unavailable' : 'unavailable');
    const relisted = await call(['devices'], 'relist');
    if (!relisted || relisted.code !== 0) return failure('failed');
    const device = devices(relisted.stdout).find(item => item.serial === endpoint);
    if (device?.state === 'unauthorized') return { reason: 'unauthorized' };
    if (device?.state !== 'device') return failure(selected ? 'configured-unavailable' : 'unavailable', device?.state === 'offline' ? offline(device, 'relist') : undefined);
    const found = await probe(endpoint);
    if (!found) return failure('failed');
    if (!found.quest) return { reason: 'not-quest' };
    if (selected && !selected.includes(':') && found.hardwareSerial !== selected) return { reason: 'configured-unavailable' };
    return ready(endpoint, found, true);
  }
  if (selected) {
    const device = attached.find(item => item.serial === selected && item.state === 'offline');
    return failure('configured-unavailable', device ? offline(device) : undefined);
  }
  if (attached.some(device => device.state === 'unauthorized')) return { reason: 'unauthorized' };
  const offlineDevice = attached.find(device => device.state === 'offline');
  if (offlineDevice && !attached.some(device => device.state === 'device')) return failure('unavailable', offline(offlineDevice));
  return { reason: attached.some(device => device.state === 'device') ? 'not-quest' : 'unavailable' };
}

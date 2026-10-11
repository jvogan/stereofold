/**
 * What this machine can run, what it is missing, and the command that fixes
 * each gap.
 *
 * This command runs on bare Node from the delivered share. It checks the
 * installed runtime and optional helpers without additional dependencies.
 *
 * It reads. The one thing it writes is the local config file, and it writes
 * only keys the host actually reads plus the two paths that say where this
 * install lives. Existing settings are kept.
 */
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, platform as osPlatform, release as osRelease, arch as osArch } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Settings understood by the bundled server. */
export const LOCAL_CONFIG_ENV = 'STEREOFOLD_CONFIG';
export const LOCAL_CONFIG_FILE = '.stereofold/config.json';
export const PYTHON3_CONFIG_KEY = 'python3Bin';
export const PYTHON3_BIN_ENV = 'STEREOFOLD_PYTHON3_BIN';
export const AGENT_VOICE_CONFIG_KEY = 'agentVoiceBin';
export const AGENT_VOICE_BIN_ENV = 'STEREOFOLD_AGENT_VOICE_BIN';
export const AGENT_VOICE_BIN_NAME = 'agent-voice';
/** Where this install is, recorded so a later session need not search again. */
export const ROOT_CONFIG_KEY = 'stereofoldRoot';
export const SERVER_CONFIG_KEY = 'serverEntry';
export const TRANSCRIBER_ENV = 'STEREOFOLD_PTT_TRANSCRIBER';

/** Runtime candidate order, mirrored here so this script runs on bare Node. */
export const OPENSSL_PATHS = Object.freeze([
  '/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/bin/openssl',
]);
export const DEFAULT_WHISPER_BINS = Object.freeze([
  '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli',
]);
export const DEFAULT_FFMPEG_BINS = Object.freeze([
  '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
]);
export function defaultApplespeechBins(root) {
  return [
    ...(root == null ? [] : [join(root, 'native/applespeech/bin/applespeech'),
      join(root, 'release/stereofold/native/applespeech/bin/applespeech')]),
    '/opt/homebrew/bin/applespeech', '/usr/local/bin/applespeech',
  ];
}
function withPath(defaults, name, env) {
  const paths = (env.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, name));
  return [...new Set([...defaults, ...paths])];
}
export const whisperBinCandidates = (env = process.env) => withPath(DEFAULT_WHISPER_BINS, 'whisper-cli', env);
export const ffmpegBinCandidates = (env = process.env) => withPath(DEFAULT_FFMPEG_BINS, 'ffmpeg', env);
export const applespeechBinCandidates = (root, env = process.env) => withPath(defaultApplespeechBins(root), 'applespeech', env);

/** Explicit transcription paths are used verbatim; a bad override never falls back. */
function resolvedTool(explicit, candidates, exists) {
  if (explicit !== undefined && explicit !== '') {
    return isAbsolute(explicit) && exists(explicit) ? explicit : undefined;
  }
  return candidates.find(exists);
}

/** The Node version the bundled server needs. */
export const REQUIRED_NODE_MAJOR = 22;

/** The four runtime files a host needs. If any is absent, restore the complete share. */
const RUNTIME_FILES = ['dist/server.mjs', 'dist/viewer.html', 'dist/inspector.html', 'dist/inspector.css', 'dist/inspector-host.js'];

/** A config bigger than this is not a settings file, so it is not read. */
const MAX_CONFIG_BYTES = 64 * 1024;

const isExecutable = (path) => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};
const isFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const isReadableFile = (path) => {
  try { accessSync(path, constants.R_OK); return isFile(path); } catch { return false; }
};
const isDirectory = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Match device lookup: keep relative PATH directories and skip empty entries. */
export function findOnPath(name, env, exists = isExecutable) {
  if (!name || name.includes('/')) return undefined;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** The config file this host reads. A relative setting is a mistake, not a path. */
export function localConfigPath(env, home) {
  const named = (env[LOCAL_CONFIG_ENV] ?? '').trim();
  if (!named) return resolve(home, LOCAL_CONFIG_FILE);
  if (!isAbsolute(named)) {
    throw Error(`${LOCAL_CONFIG_ENV} must be an absolute path; received ${named}.`);
  }
  return named;
}

/** Preserve a valid settings object; only a missing file means no settings. */
export function readLocalConfig(path) {
  let raw;
  try {
    const file = statSync(path);
    if (!file.isFile()) throw Error('Existing configuration is not a regular file.');
    if (file.size > MAX_CONFIG_BYTES) throw Error('Configuration exceeds the 64 KiB limit.');
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error.code) throw Error(`Existing configuration cannot be read (${error.code}).`);
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) throw Error('Configuration exceeds the 64 KiB limit.');
  let value;
  try { value = JSON.parse(raw); } catch { throw Error('Existing configuration is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Existing configuration must be a JSON object.');
  return value;
}

/**
 * Find one helper the way the server finds it: the environment variable, then
 * the config file, then PATH. A path the user named is reported whether or not
 * it runs, because "not executable at <path>" is the sentence that shows a
 * user their own typo.
 */
export function findHelper({ name, envName, configKey, env, config, exists = isExecutable }) {
  const named = (env[envName] ?? '').trim();
  if (named) return { name, path: named, source: envName, ready: isAbsolute(named) && exists(named) };
  const configured = typeof config[configKey] === 'string' ? config[configKey].trim() : '';
  if (configured) return { name, path: configured, source: configKey, ready: isAbsolute(configured) && exists(configured) };
  // Voice helpers use only absolute PATH directories, matching local-helper-config.
  const helperEnv = { ...env, PATH: (env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter) };
  const onPath = findOnPath(name, helperEnv, exists);
  if (onPath) return { name, path: onPath, source: 'PATH', ready: true };
  return { name, path: undefined, source: undefined, ready: false };
}

/** Find the installed plugin by its manifest, walking up from this script. */
export function findRoot({ env, start, exists = isDirectory, hasFile = isFile }) {
  const named = (env.STEREOFOLD_ROOT ?? '').trim();
  if (named) {
    if (!isAbsolute(named)) throw Error(`STEREOFOLD_ROOT must be an absolute path; received ${named}.`);
    return resolve(named);
  }
  let directory = resolve(start);
  for (let depth = 0; depth < 12; depth++) {
    for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      if (hasFile(join(directory, manifest))) return directory;
      if (exists(join(directory, 'plugin', manifest))
        || hasFile(join(directory, 'plugin', manifest))) return join(directory, 'plugin');
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168));
}

export function privateLanAddresses(interfaces) {
  return Object.entries(interfaces()).flatMap(([label, entries]) => (entries ?? [])
    .filter((entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 4) && isPrivateIpv4(entry.address))
    .map((entry) => `${label} ${entry.address}`)).sort();
}

/**
 * Which agent host is running this, read from markers rather than guessed.
 *
 * Each host registers a local MCP server its own way, so the skill needs the
 * answer before it edits anything. When no marker is present this says so,
 * and the skill asks instead of writing into a config it picked.
 */
export function detectHosts({ env, home, hasFile = isFile, hasDirectory = isDirectory }) {
  const markers = [];
  if ((env.CLAUDECODE ?? '') !== '' || (env.CLAUDE_CODE_ENTRYPOINT ?? '') !== '') markers.push('Claude Code (CLAUDECODE set)');
  if ((env.CODEX_HOME ?? '') !== '' || (env.CODEX_SANDBOX ?? '') !== '') markers.push('Codex (CODEX_* set)');
  const profiles = [];
  // Both of these hosts let a variable move the whole profile, and several
  // logins on one machine is the reason people set them. Reading the default
  // location alone would report "none found" to a user who has one open.
  const codexHome = (env.CODEX_HOME ?? '').trim();
  const codexRoot = codexHome === '' ? resolve(home, '.codex') : resolve(codexHome);
  const codexLabel = codexHome === '' ? '~/.codex' : codexRoot;
  if (hasDirectory(codexRoot)) profiles.push(codexLabel);
  if (hasFile(join(codexRoot, 'config.toml'))) profiles.push(`${codexLabel}/config.toml`);
  const claudeHome = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  const claudeRoot = claudeHome === '' ? resolve(home, '.claude') : resolve(claudeHome);
  const claudeLabel = claudeHome === '' ? '~/.claude' : claudeRoot;
  if (hasDirectory(claudeRoot)) profiles.push(claudeLabel);
  if (hasFile(claudeHome === '' ? resolve(home, '.claude.json') : join(claudeRoot, '.claude.json'))) {
    profiles.push(claudeHome === '' ? '~/.claude.json' : `${claudeLabel}/.claude.json`);
  }
  // Section 5 has a Claude Science branch, so section 1 has to be able to say
  // that this is the host, rather than leaving the agent to guess.
  if (hasDirectory(resolve(home, '.claude-science'))) profiles.push('~/.claude-science');
  if (hasFile(resolve(home, '.claude-science/mcp/local-mcp.json'))) profiles.push('~/.claude-science/mcp/local-mcp.json');
  return { markers, profiles };
}

/**
 * Everything the skill needs to decide its next step, gathered once.
 *
 * Nothing here runs a subprocess or reaches the network: every fact is a file
 * that exists, a variable that is set, or a version string Node already knows.
 */
export function discover({
  env = process.env,
  home = homedir(),
  start = fileURLToPath(new URL('.', import.meta.url)),
  platform = osPlatform(),
  arch = osArch(),
  kernel = osRelease(),
  nodeVersion = process.versions.node,
  nodePath = process.execPath,
  interfaces = networkInterfaces,
  exists = isExecutable,
  hasFile = isFile,
  readable = isReadableFile,
  hasDirectory = isDirectory,
  readConfig = readLocalConfig,
} = {}) {
  const configPath = localConfigPath(env, home);
  let config = {};
  let configError;
  try { config = readConfig(configPath); } catch (error) { configError = error.message; }
  const root = findRoot({ env, start, exists: hasDirectory, hasFile });
  const nodeMajor = Number.parseInt(String(nodeVersion).split('.')[0] ?? '', 10);

  const runtime = root == null ? RUNTIME_FILES.slice() : RUNTIME_FILES.filter((file) => !hasFile(join(root, file)));
  const kind = root == null ? 'none' : 'release artifact';
  let mcpEntry;
  if (root != null) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
      const server = parsed?.mcpServers?.stereo_structure;
      if (server != null) mcpEntry = `${server.command} ${(server.args ?? []).join(' ')} (cwd ${server.cwd})`;
    } catch { mcpEntry = undefined; }
  }

  const helpers = {
    python3: findHelper({ name: 'python3', envName: PYTHON3_BIN_ENV, configKey: PYTHON3_CONFIG_KEY, env, config, exists }),
    agentVoice: findHelper({ name: AGENT_VOICE_BIN_NAME, envName: AGENT_VOICE_BIN_ENV, configKey: AGENT_VOICE_CONFIG_KEY, env, config, exists }),
  };
  const tools = {
    // LAN certificates deliberately ignore PATH and have no environment override.
    openssl: OPENSSL_PATHS.find(exists),
    ffmpeg: resolvedTool(env.STEREOFOLD_FFMPEG_BIN, ffmpegBinCandidates(env), exists),
    'whisper-cli': resolvedTool(env.STEREOFOLD_WHISPER_BIN, whisperBinCandidates(env), exists),
    cloudflared: env.STEREOFOLD_CLOUDFLARED
      ? resolvedTool(env.STEREOFOLD_CLOUDFLARED, [], exists) ?? findOnPath(env.STEREOFOLD_CLOUDFLARED, env, exists)
      : findOnPath('cloudflared', env, exists),
    adb: ['STEREOFOLD_ADB_BIN', 'STEREOFOLD_ADB', 'ADB']
      .map(key => resolvedTool(env[key], [], exists)).find(Boolean) ?? findOnPath('adb', env, exists),
    // Reply encoders use fixed paths only, unlike transcription's PATH fallback.
    replyFfmpeg: resolvedTool(env.STEREOFOLD_FFMPEG_BIN?.trim(), DEFAULT_FFMPEG_BINS, exists),
    say: resolvedTool(env.STEREOFOLD_SAY_BIN?.trim(), ['/usr/bin/say'], exists),
  };
  const applespeech = resolvedTool(env.STEREOFOLD_APPLESPEECH_BIN, applespeechBinCandidates(root, env), exists);
  const whisperModel = resolvedTool(env.STEREOFOLD_WHISPER_MODEL,
    [join(home, '.cache/whisper-cpp/ggml-base.en.bin')], readable);

  return {
    platform, arch, kernel,
    node: { version: nodeVersion, path: nodePath, major: Number.isInteger(nodeMajor) ? nodeMajor : 0 },
    root, kind, runtimeMissing: runtime, mcpEntry,
    configPath, config, configError,
    helpers, tools, applespeech, whisperModel,
    transcriberSetting: env[TRANSCRIBER_ENV]?.trim().toLowerCase() || undefined,
    replyProviderSetting: env.STEREOFOLD_REPLY_VOICE_PROVIDER?.trim() || undefined,
    lan: privateLanAddresses(interfaces),
    hosts: detectHosts({ env, home, hasFile, hasDirectory }),
  };
}

/** Installed local routes, not a live consent or playback test. */
function voiceRoutes(facts) {
  // Match the runtime's transcriberKind: an explicit non-apple value selects
  // Whisper; otherwise prefer a detected Apple helper on macOS.
  const selected = facts.transcriberSetting
    ? facts.transcriberSetting === 'apple' ? 'apple' : 'whisper'
    : facts.platform === 'darwin' && facts.applespeech != null ? 'apple' : 'whisper';
  const apple = selected === 'apple' && facts.platform === 'darwin'
    && facts.applespeech != null && facts.tools.ffmpeg != null;
  const whisper = facts.tools['whisper-cli'] != null && facts.whisperModel != null && facts.tools.ffmpeg != null;
  const replySetting = facts.replyProviderSetting?.trim()
    || (typeof facts.config.replyVoiceProvider === 'string' ? facts.config.replyVoiceProvider.trim() : '');
  const replyProvider = (replySetting || 'oauth').toLowerCase();
  // The runtime permits Whisper as a fallback for Apple, never the reverse.
  return {
    selected, apple, whisper,
    ready: apple || whisper,
    system: facts.platform === 'darwin' && facts.tools.say != null && facts.tools.replyFfmpeg != null,
    oauth: facts.helpers.agentVoice.ready && facts.tools.replyFfmpeg != null,
    replyProvider, explicitReplyProvider: Boolean(replySetting),
  };
}

/**
 * The gaps, each with the one command that closes it.
 *
 * `required` is what stops a structure from opening at all. Everything else is
 * a feature the skill leaves switched off, named so nobody has to work out
 * afterwards why the headset never spoke.
 */
export function gaps(facts) {
  const found = [];
  const need = (required, subject, effect, fix) => found.push({ required, subject, effect, fix });

  if (facts.configError) {
    need(false, 'config file', `${facts.configError} Existing contents will be preserved.`,
      'back up and repair the existing configuration within the requested setup scope, or set STEREOFOLD_CONFIG to a new absolute config path');
  }

  if (facts.node.major < REQUIRED_NODE_MAJOR) {
    need(true, 'node', `Node ${facts.node.version} is older than ${REQUIRED_NODE_MAJOR}; the bundled server will not start`,
      'install Node 22 or newer from https://nodejs.org and reopen the shell');
  }
  if (facts.root == null) {
    need(true, 'install', 'no Codex or Claude plugin manifest above this script, so the Stereofold root is unknown',
      'run this from inside the plugin, or set STEREOFOLD_ROOT=/absolute/path/to/stereofold');
  } else if (facts.runtimeMissing.length > 0) {
    need(true, 'runtime', `${facts.runtimeMissing.join(', ')} absent, so there is nothing for a host to launch`,
      're-extract stereofold-marketplace.tar.gz and verify SHA256SUMS from the extracted share root');
  }
  if (facts.root != null && facts.mcpEntry == null) {
    need(true, 'mcp entry', 'this install has no readable .mcp.json, so no host can be pointed at its server',
      're-extract stereofold-marketplace.tar.gz and verify SHA256SUMS from the extracted share root');
  }

  if (facts.tools.openssl == null) {
    need(false, 'openssl', 'Connect over Wi-Fi cannot create the private LAN certificate, so the Quest route stays off',
      facts.platform === 'darwin' ? 'brew install openssl@3' : 'install the openssl package for this distribution');
  }
  if (facts.lan.length === 0) {
    need(false, 'private LAN address', 'no assigned RFC1918 IPv4 address, so Open on Quest has nothing to serve on',
      'join the Wi-Fi network the headset is on, then run this check again');
  }
  if (!facts.helpers.python3.ready) {
    need(false, 'python3', 'optional OAuth route prerequisite absent; local Apple/Whisper transcription and system replies do not need Python',
      facts.helpers.python3.path != null
        ? `point ${PYTHON3_BIN_ENV} at a python3 that runs; ${facts.helpers.python3.path} does not`
        : `install Python 3 (macOS: xcode-select --install), or set ${PYTHON3_BIN_ENV}=/absolute/path/to/python3`);
  }
  if (!facts.helpers.agentVoice.ready) {
    need(false, AGENT_VOICE_BIN_NAME, 'optional OAuth reply helper absent; system replies do not need it',
      `put ${AGENT_VOICE_BIN_NAME} on PATH, or set ${AGENT_VOICE_BIN_ENV}=/absolute/path/to/agent-voice`);
  }
  if (facts.tools.ffmpeg == null) {
    need(false, 'ffmpeg', 'Apple and Whisper transcription, recording conversion and reply clip encoding are unavailable',
      facts.platform === 'darwin' ? 'brew install ffmpeg' : 'install the ffmpeg package for this distribution');
  }
  const voice = voiceRoutes(facts);
  if (!['oauth', 'system'].includes(voice.replyProvider)) {
    need(false, 'reply provider', 'the configured reply provider is invalid; the server cannot select a reply route',
      'correct STEREOFOLD_REPLY_VOICE_PROVIDER or replyVoiceProvider in local config to the intended oauth or system provider');
  }
  if (!voice.ready) {
    const whisperFix = 'install whisper.cpp and ffmpeg, then set STEREOFOLD_WHISPER_BIN and STEREOFOLD_WHISPER_MODEL to an executable and a readable model';
    need(false, 'transcription', `the selected ${voice.selected === 'apple' ? 'Apple route and Whisper fallback are' : 'Whisper route is'} unavailable; unset STEREOFOLD_PTT_TRANSCRIBE stays off and no headset speech is transcribed`,
      voice.selected === 'whisper' ? whisperFix
        : facts.platform === 'darwin' && facts.applespeech != null && facts.tools.ffmpeg == null
        ? 'brew install ffmpeg, then repeat this check and grant Speech Recognition consent'
        : (facts.platform === 'darwin' && facts.root != null ? `install ffmpeg and run sh ${join(facts.root, 'native/applespeech/build.sh')}; or ` : '')
          + whisperFix);
  }
  if (!voice.system && facts.tools.ffmpeg != null) {
    need(false, 'system replies', 'optional system speech synthesis is unavailable; keep an existing OAuth reply setup',
      facts.platform === 'darwin'
        ? 'only if system replies are intended, restore /usr/bin/say or set STEREOFOLD_SAY_BIN, and set STEREOFOLD_FFMPEG_BIN to absolute executable paths, then repeat this check'
        : 'system replies require macOS; retain the configured OAuth route or use captions on this host');
  }
  if (facts.tools.cloudflared == null) {
    need(false, 'cloudflared', 'Send using Meta cannot open its public relay; private Wi-Fi sharing is unaffected',
      'install cloudflared, or set STEREOFOLD_CLOUDFLARED to its absolute path');
  }
  if (facts.tools.adb == null) {
    need(false, 'adb', 'capture_headset_view and read_headset_browser cannot reach the headset browser',
      'install the Android platform tools, or set STEREOFOLD_ADB_BIN to an absolute adb path');
  }
  return found;
}

const mark = (ok) => (ok ? 'OK  ' : '--  ');
const pad = (label) => label.padEnd(16, ' ');

/** One block: the facts, then the gaps, then a single verdict line. */
export function formatReport(facts, missing = gaps(facts), configWritten) {
  const lines = ['Stereofold setup check'];
  /**
   * Every `--` mark comes from the gap list, so a line the reader sees as a
   * problem always has a `fix:` line under it, and a program this install
   * never needs is not reported as one.
   */
  const named = new Set(missing.map((entry) => entry.subject));
  const row = (label, value, subject = label) =>
    lines.push(`  ${mark(!named.has(subject))}${pad(label)}${value}`);

  row('os', `${facts.platform} ${facts.arch} (kernel ${facts.kernel})`, '');
  row('node', `v${facts.node.version} at ${facts.node.path} (requires ${REQUIRED_NODE_MAJOR}+)`);
  row('install', facts.root == null ? 'not found' : `${facts.root} (${facts.kind})`);
  row('runtime', facts.runtimeMissing.length === 0
    ? `${RUNTIME_FILES.join(', ')} present` : `missing ${facts.runtimeMissing.join(', ')}`,
  facts.root == null ? 'install' : 'runtime');
  row('mcp entry', facts.mcpEntry ?? 'no readable .mcp.json', facts.root == null ? 'install' : 'mcp entry');
  row('config', `${facts.configPath}${configWritten == null ? '' : configWritten ? ' (written)' : ' (unchanged)'}`,
    'config file');
  row('host markers', facts.hosts.markers.length > 0 ? facts.hosts.markers.join(', ') : 'none; ask which host to register', '');
  row('host profiles', facts.hosts.profiles.length > 0 ? facts.hosts.profiles.join(', ') : 'none found', '');
  for (const [name, path] of Object.entries(facts.tools)) {
    if (name === 'replyFfmpeg') row('reply ffmpeg', path ?? 'absent (spoken replies need it)', 'system replies');
    else row(name, path ?? (named.has(name) ? 'absent' : 'absent (nothing here needs it)'));
  }
  row('python3 helper', facts.helpers.python3.path == null ? 'absent'
    : `${facts.helpers.python3.path} (from ${facts.helpers.python3.source})`, 'python3');
  row('agent-voice', facts.helpers.agentVoice.path == null ? 'absent'
    : `${facts.helpers.agentVoice.path} (from ${facts.helpers.agentVoice.source})`);
  row('applespeech', facts.applespeech ?? (facts.platform === 'darwin' ? 'not built' : 'macOS only'));
  row('whisper model', facts.whisperModel ?? 'no readable model found', 'transcription');
  const voice = voiceRoutes(facts);
  row('transcriber', `${voice.selected} (${facts.transcriberSetting == null ? 'auto-detected' : `${TRANSCRIBER_ENV}=${facts.transcriberSetting}`})`, '');
  row('transcription', voice.apple ? 'READY (Apple with ffmpeg; Speech Recognition consent still required)'
    : voice.whisper ? `READY (Whisper${voice.selected === 'apple' ? ' fallback; Apple unavailable' : ''} with a readable model and ffmpeg)`
      : `unavailable: no local transcriber for the selected ${voice.selected} route`, 'transcription');
  row('reply provider', `${voice.replyProvider} (${voice.explicitReplyProvider ? 'configured; preserve this choice' : 'runtime default'})`);
  row('OAuth replies', voice.oauth ? 'local helper and ffmpeg resolved; OAuth login and synthesis not checked'
    : 'local helper or reply ffmpeg absent', voice.oauth ? '' : !facts.helpers.agentVoice.ready ? AGENT_VOICE_BIN_NAME
      : facts.tools.ffmpeg == null ? 'ffmpeg' : 'system replies');
  row('system replies', voice.system ? 'READY (say and ffmpeg); available if system is the intended provider'
    : 'unavailable: requires macOS say and ffmpeg', facts.tools.ffmpeg == null ? 'ffmpeg' : 'system replies');
  row('voice', voice.ready && (voice.replyProvider === 'oauth' ? voice.oauth : voice.replyProvider === 'system' && voice.system)
    ? `READY (local prerequisites for ${voice.replyProvider}); keep the selected reply provider, then verify consent, get_readiness with speechCheck=true and a test press`
    : 'limited by prerequisites for the selected transcription and reply routes above', '');
  lines.push('  Keep the configured reply provider; repair OAuth failures without switching providers.');
  if (!voice.explicitReplyProvider && !facts.helpers.agentVoice.ready && voice.system) {
    lines.push('  For a new setup without an OAuth narration helper, explicitly choose STEREOFOLD_REPLY_VOICE_PROVIDER=system for local replies.');
  } else if (voice.replyProvider === 'oauth') {
    lines.push('  The unset reply provider is OAuth. Preserve the agent-voice route and verify its existing OAuth login with a speech check.');
  }
  row('private LAN', facts.lan.length === 0 ? 'none assigned' : facts.lan.join(', '), 'private LAN address');

  const required = missing.filter((entry) => entry.required);
  const optional = missing.filter((entry) => !entry.required);
  if (missing.length === 0) lines.push('', 'Missing prerequisites: none.');
  else {
    lines.push('', 'Missing prerequisites');
    for (const entry of [...required, ...optional]) {
      lines.push(`  ${entry.required ? 'required' : 'optional'}  ${entry.subject}: ${entry.effect}`);
      lines.push(`    fix: ${entry.fix}`);
    }
  }
  lines.push('', required.length === 0
    ? `SETUP READY${optional.length === 0 ? '' : ` (${optional.length} optional gap${optional.length === 1 ? '' : 's'}: ${optional.map((entry) => entry.subject).join(', ')})`}`
    : `SETUP BLOCKED: ${required.length} required prerequisite${required.length === 1 ? '' : 's'} missing; run the fix line${required.length === 1 ? '' : 's'} above and repeat this command`);
  return lines.join('\n');
}

/**
 * The settings to keep on disk. Existing keys win, so a user who pointed
 * Stereofold at their own Python keeps it; the two install paths are facts
 * about this tree and are refreshed every run.
 */
export function configUpdate(facts) {
  const next = { ...facts.config };
  if (facts.root != null) {
    next[ROOT_CONFIG_KEY] = facts.root;
    next[SERVER_CONFIG_KEY] = join(facts.root, 'dist/server.mjs');
  }
  if (!Object.hasOwn(next, PYTHON3_CONFIG_KEY) && facts.helpers.python3.ready && facts.helpers.python3.path != null) {
    next[PYTHON3_CONFIG_KEY] = facts.helpers.python3.path;
  }
  if (!Object.hasOwn(next, AGENT_VOICE_CONFIG_KEY) && facts.helpers.agentVoice.ready && facts.helpers.agentVoice.path != null) {
    next[AGENT_VOICE_CONFIG_KEY] = facts.helpers.agentVoice.path;
  }
  return next;
}

/** Write the settings beside whatever else the user keeps there, or say why not. */
export function writeConfig(path, settings) {
  // Recheck the destination here too: discovery may have happened earlier.
  const existing = readLocalConfig(path);
  const serialized = `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) {
    throw Error('Updated configuration exceeds the 64 KiB limit; existing contents will be preserved.');
  }
  let current;
  try { current = readFileSync(path, 'utf8'); } catch { current = undefined; }
  if (current === serialized) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.setup-check-${process.pid}`;
  writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return true;
}

export function parseArgs(argv) {
  const options = { json: false, write: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--json') { options.json = true; continue; }
    if (argument === '--no-write') { options.write = false; continue; }
    if (argument === '--root') {
      const value = argv[++index];
      if (!value || !isAbsolute(value)) throw Error('--root must be an absolute path.');
      options.root = resolve(value);
      continue;
    }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    throw Error(`Unknown argument: ${argument}. Usage: setup-check.mjs [--root /absolute/path] [--json] [--no-write]`);
  }
  return options;
}

export function run(argv = [], env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    return { text: 'Usage: setup-check.mjs [--root /absolute/path/to/stereofold] [--json] [--no-write]', code: 0 };
  }
  const facts = discover({ env: options.root ? { ...env, STEREOFOLD_ROOT: options.root } : env });
  const missing = gaps(facts);
  if (options.write && facts.configError) {
    missing.find(entry => entry.subject === 'config file').required = true;
  }
  let written;
  if (options.write && !facts.configError) {
    try { written = writeConfig(facts.configPath, configUpdate(facts)); } catch (error) {
      missing.push({
        required: true, subject: 'config file',
        effect: `${facts.configPath} could not be written (${error.message})`,
        fix: `resolve the reported configuration error within the requested setup scope, or set ${LOCAL_CONFIG_ENV} to a new absolute config path and repeat this command`,
      });
      written = false;
    }
  }
  const code = missing.some((entry) => entry.required) ? 1 : 0;
  if (options.json) {
    // Local settings can contain unrelated private values; report diagnostics
    // and resolved helper paths without echoing the configuration object.
    const { config, ...publicFacts } = facts;
    return { text: JSON.stringify({ facts: publicFacts, missing, configWritten: written ?? null, ready: code === 0 }, null, 2), code };
  }
  return { text: formatReport(facts, missing, written), code };
}

/** Node canonicalizes the main module URL, including macOS /tmp aliases. */
export function isDirectInvocation(scriptUrl, argument = process.argv[1]) {
  if (argument == null) return false;
  try { return realpathSync(resolve(argument)) === realpathSync(fileURLToPath(scriptUrl)); }
  catch { return false; }
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2));
    console.log(result.text);
    process.exitCode = result.code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

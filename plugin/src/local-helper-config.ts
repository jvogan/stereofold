/**
 * Where this Mac says its optional helpers live.
 *
 * Voice is the only part of Stereofold that needs a program this repository
 * does not ship. Those programs were once named by absolute paths compiled
 * into the bundle, so the voice route worked on exactly one machine and every
 * other host got an `ENOENT` naming a stranger's home directory. Worse, one of
 * those lookups ran while the MCP server was registering its tools, so a Mac
 * without Python could not start the viewer at all.
 *
 * This module is the replacement. It answers one question, "where is the
 * helper called X", from three places a user controls, in order:
 *
 *   1. an environment variable, which a host or a shell can export;
 *   2. a key in the local config file, which a setup step can write;
 *   3. PATH, so an ordinary install needs no setting at all.
 *
 * Nothing here reaches the network, spawns a process, or throws when the
 * config file is missing or unreadable. A helper that is not found is an
 * answer, not a failure: the caller reports it as a disabled feature and names
 * the setting to add.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** An absolute path to the config file, for a host that keeps it elsewhere. */
export const LOCAL_CONFIG_ENV = 'STEREOFOLD_CONFIG';
/** The default config file, beside the control files the local hosts write. */
export const LOCAL_CONFIG_FILE = '.stereofold/config.json';
/** The key that names the OAuth narration helper. */
export const AGENT_VOICE_CONFIG_KEY = 'agentVoiceBin';
/** The provider used to speak headset replies. */
export const REPLY_VOICE_PROVIDER_CONFIG_KEY = 'replyVoiceProvider';
/** The key that names the Python 3 the transcriber runs. */
export const PYTHON3_CONFIG_KEY = 'python3Bin';
/** The OAuth-only Python module imported by assets/oauth-transcribe.py. */
export const OAUTH_AUTH_HELPER_CONFIG_KEY = 'oauthAuthHelper';
/** The attached headset selected for an adb launch. */
export const QUEST_SERIAL_CONFIG_KEY = 'questSerial';
/** Days since a remembered headset last paired; config values are strings. */
export const QUEST_DEVICE_IDLE_DAYS_CONFIG_KEY = 'questDeviceIdleDays';
export const QUEST_DEVICE_IDLE_DAYS_DEFAULT = 14;

export function questDeviceIdleMs(config: LocalConfig = readLocalConfig()): number {
  const days = Number(config[QUEST_DEVICE_IDLE_DAYS_CONFIG_KEY]);
  return (Number.isFinite(days) && days > 0 && days <= 365 ? days : QUEST_DEVICE_IDLE_DAYS_DEFAULT) * 86_400_000;
}

/**
 * The key that relocates the shared-scene runtime record.
 *
 * It is not a helper path, so nothing here looks it up; `scene-service.ts`
 * reads it through `readLocalConfig` below. It is named here because this is
 * where a person reads what their config file may contain.
 */
export const SCENE_SERVICE_CONFIG_KEY = 'sceneServiceFile';

/** A config bigger than this is not a settings file, so it is not read. */
const MAX_CONFIG_BYTES = 64 * 1024;

export type LocalConfig = Readonly<Record<string, string>>;
const EMPTY: LocalConfig = Object.freeze({});

export type HelperLookup = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam; defaults to an executable-bit check. */
  exists?: (path: string) => boolean;
  /** Test seam; defaults to reading the local config file. */
  config?: LocalConfig;
};

export function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/**
 * The config file this host reads. A relative setting is refused rather than
 * resolved against whatever directory the host happened to start in.
 */
export function localConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const named = (env[LOCAL_CONFIG_ENV] ?? '').trim();
  if (!named) return resolve(home, LOCAL_CONFIG_FILE);
  if (!isAbsolute(named)) throw Error(`${LOCAL_CONFIG_ENV} must be an absolute path; received ${named}.`);
  return named;
}

const cache = new Map<string, LocalConfig>();

/**
 * The local config, as plain string settings. Missing, oversized, unreadable
 * and malformed all mean the same thing here: no settings. A user who wanted
 * to name a helper and mistyped the JSON still gets a viewer, and the helper
 * still reports itself disabled with the variable to set.
 */
export function readLocalConfig({ env = process.env, home = homedir() }: { env?: NodeJS.ProcessEnv; home?: string } = {}): LocalConfig {
  let path: string;
  try { path = localConfigPath(env, home); } catch { return EMPTY; }
  const known = cache.get(path);
  if (known) return known;
  let parsed: LocalConfig = EMPTY;
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.length <= MAX_CONFIG_BYTES) {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
        parsed = Object.freeze(Object.fromEntries(entries));
      }
    }
  } catch { /* No config file, or one this host cannot read. Both mean no settings. */ }
  cache.set(path, parsed);
  return parsed;
}

/** Forget the parsed config. Tests use it; nothing in the server does. */
export function forgetLocalConfig(): void { cache.clear(); }

/** The first directory on PATH that holds an executable of this name. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = executable): string | undefined {
  if (!name || name.includes('/')) return undefined;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export type HelperSource = 'environment' | 'config' | 'path';
export type FoundHelper = { path: string; source: HelperSource };

/**
 * Find one helper by name.
 *
 * A path the user named explicitly, in the environment or the config file, is
 * returned whether or not it exists: the caller reports "not executable at
 * <path>", which is the sentence that tells a user their setting is wrong. A
 * PATH hit is by definition executable. Nothing found returns nothing.
 */
export function findHelper({ name, envName, configKey, env = process.env, home = homedir(), exists = executable, config }: HelperLookup & {
  name: string; envName: string; configKey: string;
}): FoundHelper | undefined {
  const named = (env[envName] ?? '').trim();
  if (named) {
    if (!isAbsolute(named)) throw Error(`${envName} must be an absolute path; received ${named}.`);
    return { path: named, source: 'environment' };
  }
  const settings = config ?? readLocalConfig({ env, home });
  const configured = (settings[configKey] ?? '').trim();
  if (configured) {
    if (!isAbsolute(configured)) throw Error(`${configKey} in ${safeConfigName(env, home)} must be an absolute path; received ${configured}.`);
    return { path: configured, source: 'config' };
  }
  const onPath = findOnPath(name, env, exists);
  return onPath ? { path: onPath, source: 'path' } : undefined;
}

/** The config file's name for a message, without throwing on a bad setting. */
export function safeConfigName(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  try { return localConfigPath(env, home); } catch { return `~/${LOCAL_CONFIG_FILE}`; }
}

/** One sentence naming all three ways to point Stereofold at a helper. */
export function helperSearchAdvice(name: string, envName: string, configKey: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return `Set ${envName} to its absolute path, put ${name} on PATH, or add "${configKey}" to ${safeConfigName(env, home)}.`;
}

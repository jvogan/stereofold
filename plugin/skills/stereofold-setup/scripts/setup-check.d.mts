/** Types for the standalone recipient setup check. */

export const LOCAL_CONFIG_ENV: string;
export const LOCAL_CONFIG_FILE: string;
export const PYTHON3_CONFIG_KEY: string;
export const PYTHON3_BIN_ENV: string;
export const AGENT_VOICE_CONFIG_KEY: string;
export const AGENT_VOICE_BIN_ENV: string;
export const AGENT_VOICE_BIN_NAME: string;
export const ROOT_CONFIG_KEY: string;
export const SERVER_CONFIG_KEY: string;
export const TRANSCRIBER_ENV: string;
export const REQUIRED_NODE_MAJOR: number;
export const OPENSSL_PATHS: readonly string[];
export const DEFAULT_WHISPER_BINS: readonly string[];
export const DEFAULT_FFMPEG_BINS: readonly string[];
export function defaultApplespeechBins(root: string | undefined): string[];
export function whisperBinCandidates(env?: NodeJS.ProcessEnv): string[];
export function ffmpegBinCandidates(env?: NodeJS.ProcessEnv): string[];
export function applespeechBinCandidates(root: string | undefined, env?: NodeJS.ProcessEnv): string[];

export type Helper = {
  name: string;
  path: string | undefined;
  source: string | undefined;
  ready: boolean;
};

export type InstallKind = 'release artifact' | 'none';

export type Facts = {
  platform: string;
  arch: string;
  kernel: string;
  node: { version: string; path: string; major: number };
  root: string | undefined;
  kind: InstallKind;
  runtimeMissing: string[];
  mcpEntry: string | undefined;
  configPath: string;
  config: Record<string, unknown>;
  configError?: string;
  helpers: { python3: Helper; agentVoice: Helper };
  tools: Record<string, string | undefined>;
  applespeech: string | undefined;
  whisperModel: string | undefined;
  transcriberSetting: string | undefined;
  replyProviderSetting?: string;
  lan: string[];
  hosts: { markers: string[]; profiles: string[] };
};

/** One missing prerequisite and the single command that closes it. */
export type Gap = { required: boolean; subject: string; effect: string; fix: string };

export type NetworkInterfaceEntry = { address: string; family: string | number; internal: boolean };

export type DiscoverOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  start?: string;
  platform?: string;
  arch?: string;
  kernel?: string;
  nodeVersion?: string;
  nodePath?: string;
  interfaces?: () => Record<string, NetworkInterfaceEntry[] | undefined>;
  exists?: (path: string) => boolean;
  hasFile?: (path: string) => boolean;
  readable?: (path: string) => boolean;
  hasDirectory?: (path: string) => boolean;
  readConfig?: (path: string) => Record<string, unknown>;
};

export function findOnPath(name: string, env: NodeJS.ProcessEnv, exists?: (path: string) => boolean): string | undefined;
export function localConfigPath(env: NodeJS.ProcessEnv, home: string): string;
export function readLocalConfig(path: string): Record<string, unknown>;
export function findHelper(options: {
  name: string; envName: string; configKey: string;
  env: NodeJS.ProcessEnv; config: Record<string, unknown>; exists?: (path: string) => boolean;
}): Helper;
export function findRoot(options: {
  env: NodeJS.ProcessEnv; start: string;
  exists?: (path: string) => boolean; hasFile?: (path: string) => boolean;
}): string | undefined;
export function isPrivateIpv4(address: string): boolean;
export function privateLanAddresses(interfaces: () => Record<string, NetworkInterfaceEntry[] | undefined>): string[];
export function detectHosts(options: {
  env: NodeJS.ProcessEnv; home: string;
  hasFile?: (path: string) => boolean; hasDirectory?: (path: string) => boolean;
}): { markers: string[]; profiles: string[] };
export function discover(options?: DiscoverOptions): Facts;
export function gaps(facts: Facts): Gap[];
export function formatReport(facts: Facts, missing?: Gap[], configWritten?: boolean): string;
export function configUpdate(facts: Facts): Record<string, unknown>;
export function writeConfig(path: string, settings: Record<string, unknown>): boolean;
export function parseArgs(argv: string[]): { json: boolean; write: boolean; root?: string; help?: boolean };
export function run(argv?: string[], env?: NodeJS.ProcessEnv): { text: string; code: number };

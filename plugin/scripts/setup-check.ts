/**
 * The setup check, for anyone already working in a repository checkout.
 *
 * The program itself is `skills/stereofold-setup/scripts/setup-check.mjs`,
 * because the first command of a setup runs before `pnpm install` and a
 * release artifact carries no `package.json`, no `node_modules` and no
 * `scripts/`. Plain ESM is the only form that runs in both places. This file
 * is the same program under `tsx`, so a checkout user reaches it where every
 * other command in this directory lives:
 *
 *   pnpm --dir plugin exec tsx scripts/setup-check.ts
 *   node plugin/skills/stereofold-setup/scripts/setup-check.mjs
 *
 * Both print the same block and exit with the same code.
 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../skills/stereofold-setup/scripts/setup-check.mjs';

export {
  configUpdate, detectHosts, discover, findHelper, findOnPath, findRoot, formatReport, gaps,
  isPrivateIpv4, localConfigPath, parseArgs, privateLanAddresses, readLocalConfig, run, writeConfig,
  AGENT_VOICE_BIN_ENV, AGENT_VOICE_BIN_NAME, AGENT_VOICE_CONFIG_KEY, LOCAL_CONFIG_ENV, LOCAL_CONFIG_FILE,
  PYTHON3_BIN_ENV, PYTHON3_CONFIG_KEY, REQUIRED_NODE_MAJOR, ROOT_CONFIG_KEY, SERVER_CONFIG_KEY,
} from '../skills/stereofold-setup/scripts/setup-check.mjs';
export type { DiscoverOptions, Facts, Gap, Helper, InstallKind } from '../skills/stereofold-setup/scripts/setup-check.mjs';

const invokedScript = process.argv[1] == null ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedScript === import.meta.url || invokedScript === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  try {
    const result = run(process.argv.slice(2));
    console.log(result.text);
    process.exitCode = result.code;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}

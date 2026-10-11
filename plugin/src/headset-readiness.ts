import { access, constants } from 'node:fs/promises';
import { adbCandidates } from './quest-launch.js';
import { resolveQuestConnection } from './quest-connection.js';
import { DEVICE_ADB_TIMEOUT_MS, type DeviceRunner } from './headset-view-device.js';
import { readLocalConfig, type LocalConfig } from './local-helper-config.js';
import type { ReadinessFacts } from './inspection-contract.js';

const executable = async (path: string) => {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
};

/** A passive debugging check, not a verdict on headset power or the paired page. */
export async function readHeadsetDebugging({ env, exists = executable, run, home, config }: {
  env: NodeJS.ProcessEnv; exists?: (path: string) => Promise<boolean>; run: DeviceRunner;
  home?: string; config?: LocalConfig;
}): Promise<ReadinessFacts['headset']> {
  let adb: string | undefined;
  for (const candidate of adbCandidates(env, home)) {
    if (await exists(candidate)) { adb = candidate; break; }
  }
  if (!adb) return { checked: false, reason: 'No adb executable was found; optional debugging was not checked.' };
  const settings = config ?? readLocalConfig({ env, ...(home ? { home } : {}) });
  const connection = await resolveQuestConnection({ adb, environment: env, config: settings,
    ...(home ? { home } : {}), remember: false, reconnect: false,
    run: async (command, args) => {
      const result = await run(command, args, { timeout: DEVICE_ADB_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 });
      return { code: 0, stdout: Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout,
        stderr: result.stderr };
    } });
  if (connection.serial) return { checked: true, ok: true, serial: connection.serial };
  const reasons = {
    unavailable: 'No ready Quest debugging transport is listed. A remembered Wi-Fi transport may need reconnecting.',
    unauthorized: 'The listed debugging transport has not authorized this Mac.',
    ambiguous: 'More than one Quest identity is listed; select the intended debugging device.',
    'not-quest': 'The listed device could not be verified as a Quest.',
    'configured-unavailable': 'The selected Quest debugging transport is not ready or its identity differs.',
    'invalid-endpoint': 'The configured debugging endpoint is not a valid private Wi-Fi address and port.',
    failed: 'The Quest debugging identity check did not answer.',
    ready: 'The Quest debugging transport could not be verified.',
  };
  return { checked: true, ok: false, reason: [reasons[connection.reason],
    connection.diagnostic?.detail,connection.diagnostic?.hint].filter(Boolean).join(' ') };
}

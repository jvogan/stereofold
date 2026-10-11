import { vi } from 'vitest';

// Server heartbeats refresh optional debugging readiness. Unit tests must not
// probe a developer's physical headset merely because adb is installed. Tests
// that exercise discovery supply their own runner; device acceptance uses the
// separate Quest/browser scripts and the unmocked built runtime.
vi.mock('../src/headset-readiness.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/headset-readiness.js')>();
  const { spawnDeviceRunner } = await import('../src/headset-view-device.js');
  return { ...actual, readHeadsetDebugging: async (options: Parameters<typeof actual.readHeadsetDebugging>[0]) => {
    if (options.run === spawnDeviceRunner && !options.exists) {
      return { checked: false, reason: 'Optional debugging is isolated from physical devices in this test.' };
    }
    return actual.readHeadsetDebugging(options);
  } };
});

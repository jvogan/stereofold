import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectorHeadsetRequest } from '../src/inspector-headset-request.js';

const binding = { sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 3 };

describe('inspector headset choices', () => {
  it('lets the host find an authorized Quest before trying Meta Web Launch', () => {
    expect(inspectorHeadsetRequest(binding, 'quest', '192.168.77.24', 8443)).toEqual({
      ...binding, connection: 'lan', lanHost: '192.168.77.24', lanPort: 8443, launch: 'auto', headset: 'meta', waitForHeadsetMs: 20000,
    });
  });

  it('sends Vision Pro through the Apple auto clipboard route', () => {
    expect(inspectorHeadsetRequest(binding, 'apple', '', 8443)).toEqual({
      ...binding, connection: 'lan', lanPort: 8443, launch: 'auto', headset: 'apple',
    });
  });

  it('keeps a manual address and code choice', () => {
    expect(inspectorHeadsetRequest(binding, 'manual', '', 8443)).toEqual({
      ...binding, connection: 'lan', lanPort: 8443, launch: 'none',
    });
  });

  it('wires every dialog choice to its request', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    expect(source).toContain("inspectorHeadsetRequest(expected(),headsetChoice,lanHost,lanPort)");
    expect(source).toContain("connectBrowser('lan','quest')");
    expect(source).toContain("connectBrowser('lan','apple')");
    expect(source).toContain("connectBrowser('lan');");
    expect(source).toContain('data-quest-web');
    expect(source).toContain('data-quest-apple');
  });
});

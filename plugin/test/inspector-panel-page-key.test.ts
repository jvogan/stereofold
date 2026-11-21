import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InspectorPanelHost } from '../src/inspector-panel-host.js';
import { runDesktopBoot } from './fixtures/desktop-boot.js';

/**
 * The desktop inspector page is opened at `http://127.0.0.1:<port>/#<key>`.
 * Its bootstrap must move that key into the tab's session storage and take it
 * out of the address bar and history, the way the companion pages do, and a
 * reload of the same tab must still find it.
 */
let directory = '';
let host: InspectorPanelHost;
let boot = '';
let key = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stereofold-panel-key-'));
  const htmlPath = join(directory, 'inspector.html'), hostScriptPath = join(directory, 'inspector-host.js');
  await writeFile(htmlPath, '<!doctype html><html><body></body></html>');
  await writeFile(hostScriptPath, 'void 0;');
  host = new InspectorPanelHost({ htmlPath, hostScriptPath, opened: async () => ({}), dispatch: async () => ({}) });
  const link = await host.open('session-1');
  key = new URL(link.url).hash.slice(1);
  boot = await (await fetch(`${link.origin}/boot.js`)).text();
});

afterAll(async () => {
  await host?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('desktop inspector page key', () => {
  it('takes the key out of the address before its first request and keeps the query', async () => {
    const storage = new Map<string, string>();
    const run = await runDesktopBoot(boot, { hash: `#${key}`, search: '?hostOpened=1', storage });
    expect(run.events[0]).toBe('replace /?hostOpened=1');
    expect(run.location.hash).toBe('');
    expect([...storage.values()]).toEqual([key]);
    expect(run.events).toContain(`fetch /bootstrap Bearer ${key}`);
    expect(run.mounted).toHaveBeenCalled();
    await run.call({ name: 'get_inspection_state', arguments: {} });
    expect(run.events.at(-1)).toBe(`fetch /rpc Bearer ${key}`);
  });

  it('finds the key again when the same tab reloads without a fragment', async () => {
    const storage = new Map<string, string>();
    await runDesktopBoot(boot, { hash: `#${key}`, storage });
    const reloaded = await runDesktopBoot(boot, { hash: '', storage });
    expect(reloaded.status.textContent).toBe('');
    expect(reloaded.events).toEqual([`fetch /bootstrap Bearer ${key}`]);
    expect(reloaded.mounted).toHaveBeenCalled();
  });

  it('keeps the fragment, and works, when the browser refuses session storage', async () => {
    const run = await runDesktopBoot(boot, { hash: `#${key}`, storage: 'blocked' });
    expect(run.location.hash).toBe(`#${key}`);
    expect(run.events).toEqual([`fetch /bootstrap Bearer ${key}`]);
    expect(run.mounted).toHaveBeenCalled();
  });
});

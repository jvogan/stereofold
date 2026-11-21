import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InspectorPanelHost } from '../src/inspector-panel-host.js';

/**
 * One panel host serves every desktop inspector from the same origin and the
 * same path, so a tab can hold two inspectors' history entries at once. Each
 * entry must keep opening the inspector it was opened for: on load, on reload,
 * and after back and forward, while the key stays out of the address bar.
 * These run the real host and its real boot script in headless Chromium; the
 * stand-in inspector document only reports which session it was mounted with.
 */
const hasChromium = existsSync(chromium.executablePath());

let directory = '';
let host: InspectorPanelHost;
let browser: Browser;
let first = '', second = '';

beforeAll(async () => {
  if (!hasChromium) return;
  directory = await mkdtemp(join(tmpdir(), 'stereofold-panel-history-'));
  const htmlPath = join(directory, 'inspector.html'), hostScriptPath = join(directory, 'inspector-host.js');
  await writeFile(htmlPath, '<!doctype html><html><body></body></html>');
  await writeFile(hostScriptPath, 'window.__host={mount:async(html,opened)=>{document.body.dataset.session=opened.session;}};');
  host = new InspectorPanelHost({
    htmlPath, hostScriptPath, opened: async sessionId => ({ session: sessionId }), dispatch: async () => ({}),
  });
  first = (await host.open('session-a')).url;
  second = (await host.open('session-b')).url;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** The session the page mounted, and the address it shows, once it has settled. */
async function shown(page: Page): Promise<{ session: string; address: string }> {
  await page.waitForFunction(() => document.body.dataset.session || document.querySelector('#host-status')?.textContent);
  return page.evaluate(() => ({
    session: document.body.dataset.session || `status: ${document.querySelector('#host-status')?.textContent}`,
    address: location.href,
  }));
}

describe.skipIf(!hasChromium)('desktop inspector history entries in a real browser', () => {
  it('opens the same inspector on load and on reload, with no key in the address', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(first);
    expect(await shown(page)).toEqual({ session: 'session-a', address: first.split('#')[0] });
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-a', address: first.split('#')[0] });
  });

  it('keeps each history entry on its own inspector when one tab opens two', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const bare = first.split('#')[0];
    await page.goto(first);
    expect(await shown(page)).toEqual({ session: 'session-a', address: bare });
    // Another page in between, so the second link is a new document rather
    // than a fragment change of the first.
    await page.goto('about:blank');
    await page.goto(second);
    expect(await shown(page)).toEqual({ session: 'session-b', address: bare });
    await page.goBack();
    await page.goBack();
    expect((await shown(page)).session).toBe('session-a');
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-a', address: bare });
    await page.goForward();
    await page.goForward();
    expect((await shown(page)).session).toBe('session-b');
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-b', address: bare });
    await page.goBack();
    await page.goBack();
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-a', address: bare });

    // A tab opened from this one copies its session storage but not its
    // history, so it opens the inspector this tab showed last.
    const [copy] = await Promise.all([context.waitForEvent('page'), page.evaluate(url => { window.open(url); }, bare)]);
    expect(await shown(copy)).toEqual({ session: 'session-a', address: bare });
  });

  it('opens the second inspector, with no key in the address, when its link only changes the fragment', async () => {
    const page = await (await browser.newContext()).newPage();
    const bare = first.split('#')[0];
    const settled = (session: string) => page.waitForFunction(expected => document.body.dataset.session === expected
      && !location.hash, session, { timeout: 5_000 }).catch(() => {});
    await page.goto(first);
    expect(await shown(page)).toEqual({ session: 'session-a', address: bare });
    // The same path straight after, so the browser treats it as a fragment change.
    await page.goto(second);
    await settled('session-b');
    expect(await shown(page)).toEqual({ session: 'session-b', address: bare });
    await page.goBack();
    await settled('session-a');
    expect(await shown(page)).toEqual({ session: 'session-a', address: bare });
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-a', address: bare });
    await page.goForward();
    await settled('session-b');
    expect(await shown(page)).toEqual({ session: 'session-b', address: bare });
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-b', address: bare });
  });

  it('keeps working, with its fragment, where the browser refuses session storage', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    });
    const page = await context.newPage();
    await page.goto(first);
    expect(await shown(page)).toEqual({ session: 'session-a', address: first });
    await page.goto('about:blank');
    await page.goto(second);
    expect(await shown(page)).toEqual({ session: 'session-b', address: second });
    await page.goBack();
    await page.goBack();
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-a', address: first });
  });

  it('opens the second inspector, keeping its fragment, when its link only changes the fragment and session storage is refused', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    });
    const page = await context.newPage();
    let loads = 0;
    page.on('load', () => { loads += 1; });
    const settled = (session: string, address: string) => page.waitForFunction(([expected, href]) =>
      document.body.dataset.session === expected && location.href === href, [session, address], { timeout: 5_000 }).catch(() => {});
    await page.goto(first);
    expect(await shown(page)).toEqual({ session: 'session-a', address: first });
    // The same path straight after, so the browser treats it as a fragment
    // change, and with no storage the fragment is the page's only copy of the key.
    await page.goto(second);
    await settled('session-b', second);
    expect(await shown(page)).toEqual({ session: 'session-b', address: second });
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-b', address: second });
    await page.goBack();
    await settled('session-a', first);
    expect(await shown(page)).toEqual({ session: 'session-a', address: first });
    await page.reload();
    expect(await shown(page)).toEqual({ session: 'session-a', address: first });
    await page.goForward();
    await settled('session-b', second);
    expect(await shown(page)).toEqual({ session: 'session-b', address: second });
    // Settled means it stays there: no further loads once the right inspector is open.
    const loaded = loads;
    await page.waitForTimeout(500);
    expect(loads).toBe(loaded);
    expect(await shown(page)).toEqual({ session: 'session-b', address: second });
  });
});

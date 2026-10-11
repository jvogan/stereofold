import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanCompanion, listLanAddresses } from '../src/inspection-lan.js';
import { describePageAddress, describePageAddressSource, keepPageKey, keepPageKeySource, pageKeySource,
  readPageKey, settleAddressBar, settleAddressBarSource } from '../src/inspection-page-key.js';
import { detailedViewHtml } from '../src/detailed-view-page.js';
import { companionPageKey, forgetCompanionPageKey } from '../src/inspection-companion-client.js';

/**
 * Why any of this exists: Quest Browser renders the whole address, fragment
 * included, in a URL bar that floats inside the wearer's view. Every
 * `adb screencap`, every `capture_headset_view` frame and every shared
 * screenshot therefore carried the 64-character page key in pixels, where no
 * amount of text redaction reaches it.
 */
const KEY = 'a1b2c3d4'.repeat(8);
const STORE = 'stereo_structure/page-key';
expect(KEY).toMatch(/^[a-f0-9]{64}$/);

function fakes({ hash = '', pathname = '/viewer', search = '', storage = true, writable = true, replaceState = true } = {}) {
  const held = new Map<string, string>();
  const calls: string[] = [];
  const location = { hash, pathname, search };
  const history = replaceState
    ? { replaceState: (_data: unknown, _title: string, url: string) => { calls.push(url); const gap = url.indexOf('#'); location.hash = gap < 0 ? '' : url.slice(gap); } }
    : {};
  const store = storage ? {
    getItem: (name: string) => held.get(name) ?? null,
    setItem: (name: string, value: string) => { if (!writable) throw Error('site data is blocked'); held.set(name, value); },
  } : undefined;
  return { location, history, store, held, calls };
}

describe('taking the page key out of the address bar', () => {
  it('lifts a key from the fragment, keeps it for this tab, and clears the address', () => {
    const f = fakes({ hash: '#' + KEY });
    const held = readPageKey(f.location, f.history, f.store, true);
    expect(held).toEqual({ key: KEY, stored: true, fragment: '' });
    expect(f.held.get(STORE)).toBe(KEY);
    expect(f.calls).toEqual(['/viewer']);
    expect(f.location.hash).toBe('');
  });

  it('keeps the query string and the path the page was actually opened on', () => {
    const f = fakes({ hash: '#' + KEY, pathname: '/detailed', search: '?debug=1' });
    expect(readPageKey(f.location, f.history, f.store, true).stored).toBe(true);
    expect(f.calls).toEqual(['/detailed?debug=1']);
  });

  it('survives a reload of the same tab, which is what the fragment used to do', () => {
    const f = fakes({ hash: '#' + KEY });
    readPageKey(f.location, f.history, f.store, true);
    // Second document, same tab: no fragment left, and the key still arrives.
    const reloaded = { hash: '', pathname: '/viewer', search: '' };
    const again = readPageKey(reloaded, f.history, f.store, true);
    expect(again).toEqual({ key: KEY, stored: true, fragment: '' });
    expect(f.calls).toEqual(['/viewer']); // Nothing to rewrite the second time.
  });

  it('keeps the fragment when the tab cannot remember, because a key that vanishes on reload is worse', () => {
    for (const broken of [fakes({ hash: '#' + KEY, storage: false }), fakes({ hash: '#' + KEY, writable: false }),
      fakes({ hash: '#' + KEY, replaceState: false })]) {
      const held = readPageKey(broken.location, broken.history, broken.store, true);
      expect(held.key).toBe(KEY);
      expect(held.stored).toBe(false);
      // The link that carries the wearer onward still works; it just shows the key.
      expect(held.fragment).toBe('#' + KEY);
      expect(broken.calls).toEqual([]);
    }
  });

  it('does not rewrite the address for a fragment that is not a key, so #pair= still reaches the pairing reader', () => {
    const f = fakes({ hash: '#pair=12345678', pathname: '/' });
    expect(readPageKey(f.location, f.history, f.store, false)).toEqual({ key: '', stored: false, fragment: '' });
    expect(f.calls).toEqual([]);
    expect(f.location.hash).toBe('#pair=12345678');
  });

  it('refuses a stored value that is not a key, and never reads one for the pairing page', () => {
    const f = fakes({ pathname: '/' });
    f.store!.setItem(STORE, 'not-a-key');
    expect(readPageKey(f.location, f.history, f.store, true).key).toBe('');
    f.store!.setItem(STORE, KEY);
    // useStored false: pressing "Pair again" must reach the form, not bounce
    // the wearer back to a key this tab merely remembers.
    expect(readPageKey(f.location, f.history, f.store, false).key).toBe('');
    expect(readPageKey(f.location, f.history, f.store, true).key).toBe(KEY);
  });

  it('remembers a key the network just handed the page, and says what the link must carry', () => {
    const f = fakes();
    expect(keepPageKey(KEY, f.store)).toBe('');
    expect(f.held.get(STORE)).toBe(KEY);
    // A page that could not store it falls back to the address bar, which always works.
    expect(keepPageKey(KEY, fakes({ writable: false }).store)).toBe('#' + KEY);
    expect(keepPageKey(KEY, undefined)).toBe('#' + KEY);
    // Nothing that is not a key is ever stored or pasted into a link.
    for (const bad of ['', 'nope', KEY.toUpperCase(), KEY + '0']) expect(keepPageKey(bad, f.store)).toBe('');
  });

  it('embeds the same functions in the served pages rather than a second copy', () => {
    const scope: Record<string, unknown> = {
      location: { hash: '#' + KEY, pathname: '/detailed', search: '' },
      history: { replaceState: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    };
    expect(runInNewContext(pageKeySource(true), scope)).toEqual({ key: KEY, stored: true, fragment: '' });
    expect(runInNewContext(keepPageKeySource(JSON.stringify(KEY)), scope)).toBe('');
    // A browser that throws on the sessionStorage getter itself must not take
    // the page down; the guard around it is part of the emitted source.
    const hostile = { ...scope, get sessionStorage(): never { throw Error('site data is blocked'); } };
    expect(runInNewContext(pageKeySource(true), hostile)).toEqual({ key: KEY, stored: false, fragment: '#' + KEY });
  });
});

describe('the pages that hold a page key', () => {
  afterEach(() => { forgetCompanionPageKey(); vi.unstubAllGlobals(); });

  it('has the detailed Mol* page take its key before anything paints, and never read the address again', () => {
    const html = detailedViewHtml();
    const script = html.slice(html.indexOf('(async () => {'));
    expect(script).toContain('const pageKey = (function');
    expect(script).toContain('const bearer = pageKey.key;');
    expect(script).toContain("back.href = '/viewer' + pageKey.fragment;");
    // The only `location.hash` left is the one inside the embedded reader.
    const afterTake = script.slice(script.indexOf('const back = document.getElementById'));
    expect(afterTake).not.toContain('location.hash');
    // The take is the first thing in the page body, ahead of the Back link and
    // ahead of every await, so no frame is ever composited with the key on screen.
    expect(script.indexOf('const pageKey =')).toBeLessThan(script.indexOf('const back ='));
    expect(script.indexOf('const pageKey =')).toBeLessThan(script.indexOf('await'));
  });

  it('has the LAN pairing page hand the session token on without ever putting it in the address', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // A host with no private interface cannot run a LAN listener fixture.
    const target = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html>'); });
    await new Promise<void>((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', () => resolve()); });
    const targetPort = (target.address() as { port: number }).port;
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, lanAddress.address, () => resolve()); });
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-pagekey-lan-'));
    const lan = new LanCompanion({ certificateStore: directory });
    try {
      const opened = await lan.open({ url: `http://127.0.0.1:${targetPort}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
      const ca = await readFile(join(directory, `${createHash('sha256').update(opened.host).digest('hex')}.crt`));
      const html = await new Promise<string>((resolve, reject) => {
        const request = httpsRequest({ host: opened.host, port: opened.port, path: '/', ca, rejectUnauthorized: true }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.once('error', reject); response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.once('error', reject); request.end();
      });
      // The token the headset is about to spend never appears after a '#'.
      expect(html).not.toContain("'/viewer#'");
      // `knobs` is `?xrRenderBudget=` rebuilt from this
      // page's own address, or '' — the only thing besides the key that
      // survives the hop. See `inspection-page-route.ts`.
      expect(html).toContain("location.replace('/viewer'+knobs+held.fragment)");
      // A wearer arriving on `/#<key>` is
      // redirected to a bare `/viewer`, with the key carried in this tab only.
      const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
      const replaced: string[] = [];
      const urls: string[] = [];
      const written = new Map<string, string>();
      runInNewContext(script, {
        location: { hash: '#' + KEY, pathname: '/', search: '', replace: (to: string) => { replaced.push(to); urls.push(to); } },
        URLSearchParams, encodeURIComponent,
        history: { replaceState: (_data: unknown, _title: string, url: string) => urls.push(url) },
        sessionStorage: { getItem: (n: string) => written.get(n) ?? null, setItem: (n: string, v: string) => written.set(n, v) },
        document: { querySelector: () => { throw Error('the redirect must return before the form is touched'); } },
      });
      expect(replaced).toEqual(['/viewer']);
      expect(written.get(STORE)).toBe(KEY);

      // A launch without a device key reports recovery only when fetch exists.
      // Keep the bare sandbox above: key handoff must not depend on networking.
      const requests: Array<{ url: string; options: RequestInit }> = [];
      const recordingFetch = async (url: string, options: RequestInit) => {
        urls.push(url);
        requests.push({ url, options });
        return { ok: true };
      };
      for (const network of [{}, { fetch: recordingFetch }]) {
        runInNewContext(script, {
          ...network,
          window: { addEventListener: () => {} },
          location: { hash: '#launch=' + opened.launchId, pathname: '/', search: '', replace: (to: string) => { replaced.push(to); urls.push(to); } },
          URLSearchParams, encodeURIComponent,
          history: { replaceState: (_data: unknown, _title: string, url: string) => urls.push(url) },
          localStorage: { getItem: () => null },
          document: { querySelector: (selector: string) => selector === 'form' ? { addEventListener: () => {} } : {} },
        });
      }
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('/pair');
      expect(requests[0].options.method).toBe('POST');
      expect(JSON.parse(requests[0].options.body as string)).toEqual({ launchId: opened.launchId, failure: 'device_key_missing' });
      expect(replaced).toEqual(['/viewer']);
      for (const url of urls) expect(url).not.toContain(KEY);
    } finally {
      await lan.close();
      await new Promise<void>(resolve => target.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('has the companion transport read the hold once, so the rewritten address cannot strand a later caller', () => {
    vi.stubGlobal('location', { hash: '#' + KEY, pathname: '/viewer', search: '' });
    const written = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (n: string) => written.get(n) ?? null, setItem: (n: string, v: string) => written.set(n, v) });
    vi.stubGlobal('history', { replaceState: (_d: unknown, _t: string, url: string) => { (globalThis as any).location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } });
    const first = companionPageKey();
    expect(first).toEqual({ key: KEY, stored: true, fragment: '' });
    expect(location.hash).toBe('');
    // This is the call "Open in Mol*" makes, long after the address was cleared.
    expect(companionPageKey()).toBe(first);
    expect(written.get(STORE)).toBe(KEY);
  });
});

/**
 * After the Mol*
 * handoff the page was `/detailed` and the URL bar above it still read
 * `/viewer`. The wearer's tab hops between the two with the key already in
 * storage, so no fragment arrives and `readPageKey` rewrites nothing.
 */
describe('making the address bar say which page the wearer is on', () => {
  it('rewrites the address to the path the page is actually on', () => {
    const f = fakes({ pathname: '/detailed' });
    expect(settleAddressBar(f.location, f.history)).toBe('settled');
    expect(f.calls).toEqual(['/detailed']);
  });

  it('carries the fragment through, because a page that could not store its key still needs it', () => {
    const f = fakes({ pathname: '/detailed', hash: '#' + KEY });
    expect(settleAddressBar(f.location, f.history)).toBe('settled');
    expect(f.calls).toEqual(['/detailed#' + KEY]);
  });

  it('keeps the query string a render budget travels in', () => {
    const f = fakes({ pathname: '/detailed', search: '?budget=low' });
    expect(settleAddressBar(f.location, f.history)).toBe('settled');
    expect(f.calls).toEqual(['/detailed?budget=low']);
  });

  it('says so rather than throwing where the browser refuses a history rewrite', () => {
    const f = fakes({ pathname: '/detailed', replaceState: false });
    expect(settleAddressBar(f.location, f.history)).toBe('unavailable');
    const throwing = { replaceState: () => { throw Error('history is blocked'); } };
    expect(settleAddressBar({ pathname: '/detailed' }, throwing)).toBe('unavailable');
  });

  it('runs on the served detailed page, right after the key is taken', () => {
    const html = detailedViewHtml();
    expect(html).toContain(settleAddressBarSource());
    expect(html).toContain('document.body.dataset.address =');
    // The key must be taken into storage before anything rewrites the address.
    expect(html.indexOf(pageKeySource(true))).toBeLessThan(html.indexOf(settleAddressBarSource()));
  });

  it('is the same function the page runs, evaluated out of the served source', () => {
    const f = fakes({ pathname: '/detailed' });
    const outcome = runInNewContext(settleAddressBarSource(), { location: f.location, history: f.history });
    expect(outcome).toBe('settled');
    expect(f.calls).toEqual(['/detailed']);
  });
});

/**
 * The rewrite above ran,
 * the tab had ALSO really navigated to `/detailed`, and Quest Browser's URL bar
 * still read `/viewer`. A page cannot read that bar and cannot make this browser
 * repaint it, so the page names its own address in the row the wearer reads.
 */
describe('the page saying where it is, for a bar that will not repaint', () => {
  it('names the host and the path, and nothing else', () => {
    expect(describePageAddress({ host: 'stereofold.local:8443', pathname: '/detailed' }))
      .toBe('stereofold.local:8443/detailed');
  });

  it('leaves out the fragment the page key rides in and the render knobs', () => {
    const address = describePageAddress({ host: 'h:1', pathname: '/detailed',
      hash: '#' + KEY, search: '?budget=low' } as { host: string; pathname: string });
    expect(address).toBe('h:1/detailed');
    expect(address).not.toContain(KEY);
    expect(address).not.toContain('budget');
  });

  it('answers a path even where the browser gives it nothing to read', () => {
    expect(describePageAddress({})).toBe('/');
    expect(describePageAddress({ host: 'h:1', pathname: '' })).toBe('h:1/');
  });

  it('is drawn on the served page, and the rewrite is published under its own name', () => {
    const html = detailedViewHtml();
    expect(html).toContain(describePageAddressSource());
    expect(html).toContain('<span id="address" hidden></span>');
    // The rewrite's outcome is no longer published as `address`: it is what the
    // rewrite did, not what the bar says, and on this browser the two differ.
    expect(html).toContain('document.body.dataset.addressRewrite =');
    expect(html).toContain('addressLine.textContent = shownAddress');
  });

  it('is the same function the page runs, evaluated out of the served source', () => {
    expect(runInNewContext(describePageAddressSource(), { location: { host: 'h:1', pathname: '/detailed' } }))
      .toBe('h:1/detailed');
  });
});

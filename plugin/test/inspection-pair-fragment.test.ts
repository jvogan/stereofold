import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { pairingHtml } from '../src/inspection-lan.js';
import { pairFragmentSource, readPairFragment, type FragmentHistory, type FragmentLocation } from '../src/inspection-pair-fragment.js';

/** A browser location and history stand-in that records every rewrite. */
function page(hash: string, { pathname = '/', search = '', refuse = false }: { pathname?: string; search?: string; refuse?: boolean } = {}) {
  const rewrites: string[] = [];
  const location: FragmentLocation = { hash, pathname, search };
  const history: FragmentHistory = {
    replaceState: (_data, _title, url) => { if (refuse) throw Error('replaceState is disabled'); rewrites.push(url); },
  };
  return { location, history, rewrites };
}

describe('the pairing code in the companion page fragment', () => {
  it('pairs when a new launch fragment reaches an already-open pairing page', async () => {
    const handlers = new Map<string, () => void>();
    const requests: unknown[] = [], redirects: string[] = [];
    const form = { hidden: false, addEventListener() {} }, status = { textContent: '' };
    const storage = new Map<string, string>();
    const store = { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => { storage.delete(key); } };
    const location = { hash: '', search: '', pathname: '/',
      replace: (url: string) => { redirects.push(url); } };
    const script = pairingHtml().match(/<script>([\s\S]*)<\/script>/u)![1];
    vm.runInNewContext(script, {
      URLSearchParams, location, sessionStorage: store, localStorage: store,
      history: { replaceState: () => { location.hash = ''; } },
      document: { querySelector: (selector: string) => selector === 'form' ? form : status },
      window: { addEventListener: (name: string, handler: () => void) => handlers.set(name, handler) },
      fetch: async (_url: string, options: { body: string }) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ token: 'a'.repeat(64) }) };
      },
    });
    expect(requests).toEqual([]);
    location.hash = '#pair=12345678';
    handlers.get('hashchange')!();
    // The code is removed before the asynchronous pairing response arrives.
    expect(location.hash).toBe('');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toEqual([{ code: '12345678', remember: true }]);
    expect(redirects).toEqual([expect.stringContaining('/viewer')]);
    location.hash = '#pair=malformed';
    handlers.get('hashchange')!();
    expect(location.hash).toBe('');
    expect(requests).toHaveLength(1);
  });

  it('reads an eight-digit code and erases the fragment in the same turn', () => {
    const { location, history, rewrites } = page('#pair=12345678');
    expect(readPairFragment(location, history)).toBe('12345678');
    expect(rewrites).toEqual(['/']);
  });

  it('keeps the path and query while dropping the fragment', () => {
    const { location, history, rewrites } = page('#pair=87654321', { pathname: '/', search: '?lesson=1' });
    expect(readPairFragment(location, history)).toBe('87654321');
    expect(rewrites).toEqual(['/?lesson=1']);
    expect(rewrites[0]).not.toContain('pair');
  });

  it('reads nothing from a fragment that is not a pairing code', () => {
    for (const hash of ['', '#', `#${'a'.repeat(64)}`, '#pairing=12345678', '#code=12345678']) {
      const { location, history, rewrites } = page(hash);
      expect(readPairFragment(location, history)).toBeUndefined();
      // A viewer token fragment belongs to the page's own redirect and must
      // survive this helper untouched.
      expect(rewrites).toEqual([]);
    }
  });

  it('refuses a malformed code but still erases it', () => {
    for (const value of ['1234567', '123456789', 'abcdefgh', '1234 5678', '12345678%0a']) {
      const { location, history, rewrites } = page(`#pair=${value}`);
      expect(readPairFragment(location, history)).toBeUndefined();
      expect(rewrites).toEqual(['/']);
    }
  });

  it('reads only the first pair parameter and never a later one', () => {
    const first = page('#pair=12345678&pair=99999999');
    expect(readPairFragment(first.location, first.history)).toBe('12345678');
    const second = page('#other=1&pair=12345678');
    expect(readPairFragment(second.location, second.history)).toBe('12345678');
  });

  it('still pairs when the browser refuses to rewrite the address', () => {
    const { location, history } = page('#pair=12345678', { refuse: true });
    expect(readPairFragment(location, history)).toBe('12345678');
  });

  it('survives a location or history object missing the fields it reads', () => {
    expect(readPairFragment({}, {})).toBeUndefined();
    expect(readPairFragment({ hash: '#pair=12345678' }, {})).toBe('12345678');
    expect(readPairFragment(undefined as unknown as FragmentLocation, {})).toBeUndefined();
  });

  it('embeds the very same function in the served page', () => {
    const source = pairFragmentSource();
    expect(source.startsWith('(function')).toBe(true);
    expect(source.endsWith('(location,history)')).toBe(true);
    // The page runs this text with its own globals, so evaluating it against
    // fakes proves the shipped copy behaves like the tested function.
    const { location, history, rewrites } = page('#pair=12345678');
    const run = new Function('location', 'history', `return ${source};`) as (l: FragmentLocation, h: FragmentHistory) => string | undefined;
    expect(run(location, history)).toBe('12345678');
    expect(rewrites).toEqual(['/']);
    // Nothing outside the function body may be referenced, or the minified
    // bundle would emit a call to a name the page has never seen.
    expect(source).not.toContain('import');
    expect(source).not.toContain('require');
  });
});

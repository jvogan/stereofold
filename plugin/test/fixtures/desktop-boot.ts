import vm from 'node:vm';
import { vi } from 'vitest';

/** What a desktop page bootstrap did, in order, against a stand-in browser. */
export type DesktopBootRun = {
  /** `replace <url>` and `fetch <path> <authorization>` entries, in the order they happened. */
  events: string[];
  location: { hash: string; pathname: string; search: string };
  stored: Map<string, string>;
  status: { textContent: string };
  mounted: ReturnType<typeof vi.fn>;
  call: (payload: unknown) => Promise<unknown>;
};

/**
 * Run one desktop bootstrap script in a fresh context with the parts of a
 * browser it touches. `storage` is the tab's session storage, shared between
 * runs to model a reload of the same tab, or `'blocked'` for a browser whose
 * `sessionStorage` getter throws.
 */
export async function runDesktopBoot(script: string, options: {
  hash: string; search?: string; storage: Map<string, string> | 'blocked';
}): Promise<DesktopBootRun> {
  const events: string[] = [];
  const location = { hash: options.hash, pathname: '/', search: options.search ?? '' };
  const stored = options.storage === 'blocked' ? new Map<string, string>() : options.storage;
  const status = { textContent: '' };
  const mounted = vi.fn(async () => undefined);
  const element = (target: { textContent: string }) => Object.assign(target, { disabled: false, addEventListener() { /* unused */ } });
  const elements: Record<string, unknown> = { '#host-status': element(status), '#host-detailed': element({ textContent: '' }) };
  const window: Record<string, unknown> = { __host: { mount: mounted }, open() { /* unused */ } };
  const context: Record<string, unknown> = {
    location, window,
    history: {
      replaceState(_data: unknown, _title: string, url: string) {
        events.push(`replace ${url}`);
        const hashAt = url.indexOf('#');
        location.hash = hashAt < 0 ? '' : url.slice(hashAt);
      },
    },
    document: { querySelector: (selector: string) => elements[selector] },
    addEventListener() { /* no later navigation in these runs */ },
    fetch: async (path: string, init?: { headers?: Record<string, string> }) => {
      events.push(`fetch ${path} ${init?.headers?.Authorization ?? ''}`.trim());
      return { ok: true, status: 200, json: async () => ({ html: '<p>inspector</p>', opened: {} }) };
    },
  };
  if (options.storage === 'blocked') {
    Object.defineProperty(context, 'sessionStorage', { get() { throw new Error('The operation is insecure.'); } });
  } else {
    context.sessionStorage = {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => { stored.set(name, value); },
    };
  }
  vm.runInNewContext(script, context);
  await vi.waitFor(() => { if (!mounted.mock.calls.length && !status.textContent) throw Error('The bootstrap has not settled.'); });
  return { events, location, stored, status, mounted, call: window.__call as DesktopBootRun['call'] };
}

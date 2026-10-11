import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReport, composeDriveUrl, Driver, DRIVE_USAGE, DriveUsageError, parseDriveArguments,
} from '../scripts/headset-drive.js';

const base = 'https://192.0.2.1/viewer';
const argv = ['share.json', '--out', 'captures'];
const target = { id: 'paired-tab', type: 'page', title: 'Stereofold', url: base, webSocketDebuggerUrl: '/devtools/page/paired-tab' };

afterEach(() => { vi.restoreAllMocks(); });

describe('open URL composition', () => {
  it('preserves the default URL byte-for-byte, including its pairing fragment', () => {
    const url = `${base}?existing=a%20b#pair=12345678`;
    expect(composeDriveUrl(url)).toBe(url);
    expect(parseDriveArguments(argv)).not.toHaveProperty('url');
    expect(parseDriveArguments(argv)).not.toHaveProperty('query');
  });

  it.each(['', '?'])('appends the budget before the fragment with %s', existing => {
    const query = 'xrRenderBudget=scale%3A0.5';
    expect(composeDriveUrl(`${base}${existing}#pair=12345678`, { query }))
      .toBe(`${base}?${query}#pair=12345678`);
  });

  it('replaces the derived URL and applies the query to that replacement', () => {
    const url = 'http://192.0.2.2/alternate#pair=87654321';
    const options = parseDriveArguments([...argv, '--url', url, '--query', 'xrRenderBudget=scale:0.5']);
    expect(composeDriveUrl(base, { url })).toBe(url);
    expect(composeDriveUrl(base, options)).toBe(`${url.split('#')[0]}?xrRenderBudget=scale:0.5#pair=87654321`);
  });

  it('requires --url for other query forms, including an existing non-budget key', () => {
    const url = `${base}?existing=1&note=A%20B#pair=12345678`;
    expect(composeDriveUrl(base, parseDriveArguments([...argv, '--url', url]))).toBe(url);
    expect(() => composeDriveUrl(url, { query: 'xrRenderBudget=scale:0.5' }))
      .toThrow(/single xrRenderBudget=<value>.*--url/);
  });

  it.each(['relative/viewer', 'https://', 'https:/broken', 'javascript:alert(1)', 'https://192.0.2.1/a b', 'https://192.0.2.1/%zz'])
    ('rejects malformed or non-HTTP absolute URL %s', url => {
      expect(() => composeDriveUrl(base, { url })).toThrow(DriveUsageError);
      expect(() => parseDriveArguments([...argv, '--url', url])).toThrow(/--url/);
    });

  it.each([
    '', '?xrRenderBudget=scale:0.5', 'missing-value', '=missing-key', 'a=%zz', 'a=b#fragment', 'a=b&',
    'note=A', 'xrRenderBudget=scale:0.5&note=A', 'xrRenderBudget=scale:0.5&xrRenderBudget=pick:0.5',
    '%78rRenderBudget=scale:0.5', 'XRRENDERBUDGET=off', 'xrRenderBudget=', 'xrRenderBudget=%ZZ',
    'xrRenderBudget=scale:0', 'xrRenderBudget=pick:0', 'xrRenderBudget=scale:2.0001', 'xrRenderBudget=pick:1.01',
    'xrRenderBudget=scale:0.5,pick:0', 'xrRenderBudget=scale:0.5,nonsense:1',
    'xrRenderBudget=scale:0.5,', 'xrRenderBudget=quality:ultra', 'xrRenderBudget=hover:61',
    'xrRenderBudget=scale:banana', 'xrRenderBudget=scale%3A0.5%26note%3DA',
    `xrRenderBudget=${'a'.repeat(129)}`,
  ])('rejects unsupported query %s with the accepted form', query => {
    expect(() => composeDriveUrl(base, { query })).toThrow(DriveUsageError);
    expect(() => parseDriveArguments([...argv, '--query', query])).toThrow(/single xrRenderBudget=<value>.*--url/);
  });

  it.each([
    'off', '0', 'false', 'no', 'disabled', 'scale:0.5', 'scale%3A0.5', 'scale:1.01', 'scale:2',
    'framebufferscale=2;pickscale=1', 'framebufferscale=1;pickscale=.01',
    'foveation:0;rough:1;fps:off', 'quality:highest,surface:off,gloss:on,palette:off,light:on',
    'marking:on,postfx:off,cost:yes,molstarPanel:true,hover:60',
  ])('accepts page-parser values %s', value => {
    const query = `xrRenderBudget=${value}`;
    expect(composeDriveUrl(base, parseDriveArguments([...argv, '--query', query]))).toBe(`${base}?${query}`);
  });

  it('rejects duplicate keys that would silently keep the A-side setting', () => {
    expect(() => composeDriveUrl(`${base}?xrRenderBudget=scale:0.8`, { query: 'xrRenderBudget=scale:0.5' }))
      .toThrow(/repeats a key.*single xrRenderBudget=<value>.*--url/);
    expect(() => composeDriveUrl(base, { query: 'a=1&%61=2' })).toThrow(/single xrRenderBudget=<value>/);
  });

  it.each(['--url', '--query'])('rejects a missing %s value before contacting the headset', flag => {
    expect(() => parseDriveArguments([...argv, flag])).toThrow(/needs a value/);
    expect(() => parseDriveArguments([...argv, flag, '--steps', 'open'])).toThrow(/needs a value/);
  });
});

function fakeDriver(options: string[] = []) {
  const driver = new Driver({} as any, 'unused-adb', 0, {} as any, parseDriveArguments([...argv, ...options]));
  const events: string[] = [];
  const send = vi.fn(async (method: string, _params?: unknown) => { events.push(method); return {}; });
  const page = vi.spyOn(driver, 'page').mockResolvedValue({ target, session: { send } as any });
  vi.spyOn(driver, 'assertProximitySafe').mockImplementation(async () => {
    events.push('gate');
    return { proximityPositive: false, presenting: false, readAt: 'test' };
  });
  return { driver, events, send, page };
}

describe('open URL navigation and evidence', () => {
  it('logs the default effective URL without adding a browser action', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, page } = fakeDriver();
    await driver.applyOpenUrl(target);
    expect(page).not.toHaveBeenCalled();
    expect(driver.effectiveUrl).toBe(base);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\d\d:\d\d:\d\d  open: effective URL https:\/\/192\.0\.2\.1\/viewer$/));
  });

  it('navigates an existing paired tab after the gate and logs the B-side URL', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, events, send } = fakeDriver(['--query', 'xrRenderBudget=scale:0.5']);
    const paired = { ...target, url: `${base}#pair=12345678` };
    await driver.applyOpenUrl(paired, async () => {});
    expect(events).toEqual(['Page.enable', 'gate', 'Page.navigate']);
    expect(send).toHaveBeenLastCalledWith('Page.navigate', { url: `${base}?xrRenderBudget=scale:0.5#pair=12345678` });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`open: effective URL ${base}?xrRenderBudget=scale:0.5#pair=<8 digits>`));
    expect(log.mock.calls.flat().join(' ')).not.toContain('12345678');
    const report = buildReport({ startedAt: 'start', endedAt: 'end', gate: { proximityPositive: false, presenting: false, readAt: 'test' },
      options: driver.options, steps: [], effectiveUrl: driver.effectiveUrl });
    expect(report.evidenceIdentity.effectiveUrl).toBe(`${base}?xrRenderBudget=scale:0.5#pair=<8 digits>`);
    expect(JSON.stringify(report)).not.toContain('12345678');
  });

  it('follows the overridden tab across origins instead of attaching another share tab', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = 'https://192.0.2.2/custom?xrRenderBudget=scale:0.5';
    const { driver, send } = fakeDriver(['--url', url]);
    await driver.applyOpenUrl(target, async () => {});
    expect(send).toHaveBeenLastCalledWith('Page.navigate', { url });
    const moved = { ...target, url };
    vi.spyOn(driver, 'targets').mockResolvedValue([{ ...target, id: 'other-tab' }, moved]);
    expect(await driver.stereofoldTarget()).toEqual(moved);
  });

  it('sends no navigation when the final proximity check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, send } = fakeDriver(['--query', 'xrRenderBudget=scale:0.5']);
    vi.spyOn(driver, 'assertProximitySafe').mockRejectedValue(new Error('worn'));
    await expect(driver.applyOpenUrl(target, async () => {})).rejects.toThrow('worn');
    expect(send).not.toHaveBeenCalledWith('Page.navigate', expect.anything());
  });

  it('fails the open when DevTools reports a navigation error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, send } = fakeDriver(['--query', 'xrRenderBudget=scale:0.5']);
    send.mockResolvedValue({ errorText: 'net::ERR_CONNECTION_REFUSED' });
    await expect(driver.applyOpenUrl(target, async () => {})).rejects.toThrow('could not load');
  });

  it('documents the flags and the accepted scale range in help', () => {
    expect(DRIVE_USAGE).toContain('--url <absolute-url>');
    expect(DRIVE_USAGE).toContain('--query "xrRenderBudget=<value>"');
    expect(DRIVE_USAGE).toContain('Escape hatch for other URL or query forms.');
    expect(DRIVE_USAGE).toContain('scale: (0,2]; pick: (0,1]');
    expect(DRIVE_USAGE).toContain('xrRenderBudget=scale:0.5');
  });
});

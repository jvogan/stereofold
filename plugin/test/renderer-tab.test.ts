import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  applyRendererTabClose, chromeCloseTabsByUrlScript, chromeListRendererTabUrlsScript, decideRendererTabClose,
  FAILED_HEARTBEATS_BEFORE_CLOSE, HOST_OPENED_PARAM, isHostOpenedRendererTabUrl, isMacRendererTabUrl, isRendererHeartbeatFailure,
  markHostOpenedUrl, parseChromeTabList, RENDERER_TAB_NAME, rendererTabOrigin, selectStaleRendererTabs,
  STEREOFOLD_RENDERER_TITLE, tabIsHostOpened,
} from '../src/renderer-tab.js';
import { closeChromeRendererTabs, OSASCRIPT, sweepDeadRendererTabs, type RunResult } from '../src/quest-launch.js';

const PANEL = 'http://127.0.0.1:53913/#0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const LIVE = 'http://127.0.0.1:53913';
const DEAD = 'http://127.0.0.1:54001/?hostOpened=1#dead';
const LAN = 'https://192.168.77.24:8443/';
const META = 'https://www.oculus.com/open_url/?url=https%3A%2F%2Fexample';

const stay = {
  companion: false, sameOriginTop: true, hostOpened: true, hostAskedClose: false, consecutiveFailedHeartbeats: 0,
};

describe('whether a renderer tab may close itself', () => {
  it('never closes the headset companion, even when the Mac host asked', () => {
    expect(decideRendererTabClose({ ...stay, companion: true, hostAskedClose: true,
      consecutiveFailedHeartbeats: FAILED_HEARTBEATS_BEFORE_CLOSE })).toEqual({ action: 'stay', reason: 'companion' });
  });

  it('never closes a cross-origin embedded panel (Claude Code / Codex)', () => {
    expect(decideRendererTabClose({ ...stay, sameOriginTop: false,
      consecutiveFailedHeartbeats: FAILED_HEARTBEATS_BEFORE_CLOSE }))
      .toEqual({ action: 'stay', reason: 'embedded' });
  });

  it('leaves a tab the wearer pasted alone', () => {
    expect(decideRendererTabClose({ ...stay, hostOpened: false,
      consecutiveFailedHeartbeats: FAILED_HEARTBEATS_BEFORE_CLOSE }))
      .toEqual({ action: 'stay', reason: 'not-host-opened' });
  });

  it('stays while the host is answering', () => {
    expect(decideRendererTabClose(stay)).toEqual({ action: 'stay', reason: 'host-alive' });
  });

  it('does not close on a single missed heartbeat', () => {
    expect(decideRendererTabClose({ ...stay, consecutiveFailedHeartbeats: 1 }))
      .toEqual({ action: 'stay', reason: 'too-few-failures' });
    expect(decideRendererTabClose({ ...stay, consecutiveFailedHeartbeats: FAILED_HEARTBEATS_BEFORE_CLOSE - 1 }))
      .toEqual({ action: 'stay', reason: 'too-few-failures' });
  });

  it('closes a host-opened top-level tab after enough failed heartbeats', () => {
    expect(decideRendererTabClose({ ...stay, consecutiveFailedHeartbeats: FAILED_HEARTBEATS_BEFORE_CLOSE }))
      .toEqual({ action: 'close', reason: 'host-gone' });
    expect(decideRendererTabClose({ ...stay, consecutiveFailedHeartbeats: 20 }))
      .toEqual({ action: 'close', reason: 'host-gone' });
  });

  it('closes immediately when the host asked, without waiting for misses', () => {
    expect(decideRendererTabClose({ ...stay, hostAskedClose: true }))
      .toEqual({ action: 'close', reason: 'host-asked' });
  });

  it('treats a non-finite miss count as none', () => {
    expect(decideRendererTabClose({ ...stay, consecutiveFailedHeartbeats: Number.NaN }))
      .toEqual({ action: 'stay', reason: 'host-alive' });
    expect(decideRendererTabClose({ ...stay, consecutiveFailedHeartbeats: -4 }))
      .toEqual({ action: 'stay', reason: 'host-alive' });
  });

  it('only invokes close when the decision says so', () => {
    let calls = 0;
    const close = () => { calls++; };
    expect(applyRendererTabClose({ action: 'stay', reason: 'host-alive' }, close)).toBe(false);
    expect(calls).toBe(0);
    expect(applyRendererTabClose({ action: 'close', reason: 'host-gone' }, close)).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('how a tab knows the host opened it', () => {
  it('accepts a real opener, the stamped name, or the query the opener adds', () => {
    expect(tabIsHostOpened({ opener: {}, name: '', search: '' })).toBe(true);
    expect(tabIsHostOpened({ opener: null, name: RENDERER_TAB_NAME, search: '' })).toBe(true);
    expect(tabIsHostOpened({ opener: null, name: '', search: `?${HOST_OPENED_PARAM}=1` })).toBe(true);
    expect(tabIsHostOpened({ opener: null, name: '', search: `${HOST_OPENED_PARAM}=1` })).toBe(true);
  });

  it('rejects a pasted tab with no marker', () => {
    expect(tabIsHostOpened({ opener: null, name: '', search: '' })).toBe(false);
    expect(tabIsHostOpened({ opener: undefined, name: 'other', search: '?q=1' })).toBe(false);
    expect(tabIsHostOpened({ opener: null, name: '', search: `?${HOST_OPENED_PARAM}=0` })).toBe(false);
  });

  it('stamps the query without moving the page key in the fragment', () => {
    const marked = markHostOpenedUrl(PANEL);
    expect(marked.startsWith('http://127.0.0.1:53913/?hostOpened=1#')).toBe(true);
    expect(marked.endsWith(PANEL.slice(PANEL.indexOf('#') + 1))).toBe(true);
    expect(new URL(marked).searchParams.get(HOST_OPENED_PARAM)).toBe('1');
  });
});

describe('which URLs are Mac renderer tabs', () => {
  it('accepts loopback inspector addresses, with or without the hostOpened stamp', () => {
    expect(isMacRendererTabUrl(PANEL)).toBe(true);
    expect(isMacRendererTabUrl(markHostOpenedUrl(PANEL))).toBe(true);
    expect(isMacRendererTabUrl('http://localhost:53913/')).toBe(true);
    expect(rendererTabOrigin(PANEL)).toBe(LIVE);
  });

  it('treats only a stamped loopback inspector as a host-opened renderer tab', () => {
    expect(isHostOpenedRendererTabUrl(PANEL)).toBe(false);
    expect(isHostOpenedRendererTabUrl(markHostOpenedUrl(PANEL))).toBe(true);
    expect(isHostOpenedRendererTabUrl(DEAD)).toBe(true);
    expect(isHostOpenedRendererTabUrl('http://localhost:53913/?hostOpened=1')).toBe(true);
    expect(isHostOpenedRendererTabUrl('http://localhost:53913/?hostOpened=0')).toBe(false);
    expect(isHostOpenedRendererTabUrl(LAN)).toBe(false);
  });

  it('rejects the LAN companion, Meta Web Launch, and anything with no port', () => {
    expect(isMacRendererTabUrl(LAN)).toBe(false);
    expect(isMacRendererTabUrl(META)).toBe(false);
    expect(isMacRendererTabUrl('http://127.0.0.1/')).toBe(false);
    expect(isMacRendererTabUrl('http://127.0.0.1:53913/detailed#abc')).toBe(false);
    expect(isMacRendererTabUrl('http://user:secret@127.0.0.1:53913/')).toBe(false);
    expect(isMacRendererTabUrl('not a url')).toBe(false);
    expect(rendererTabOrigin(LAN)).toBeUndefined();
  });
});

describe('which leftover tabs a new host may close', () => {
  it('keeps a live origin and drops a dead one', () => {
    const urls = [PANEL, markHostOpenedUrl(PANEL), DEAD, LAN, META];
    expect(selectStaleRendererTabs({ urls, liveOrigin: LIVE })).toEqual([DEAD]);
    expect(selectStaleRendererTabs({ urls, liveOrigins: new Set([LIVE, 'http://127.0.0.1:54001']) })).toEqual([]);
    expect(selectStaleRendererTabs({ urls })).toEqual([markHostOpenedUrl(PANEL), DEAD]);
  });

  it('parses Chrome’s AppleScript listing as one URL per line', () => {
    expect(parseChromeTabList(`${DEAD}\nchrome://newtab/\n${markHostOpenedUrl(PANEL)}\n`))
      .toEqual([DEAD, markHostOpenedUrl(PANEL)]);
  });
});

describe('failed heartbeats vs other panel errors', () => {
  it('treats a dropped socket and a dead desktop /rpc as host-gone', () => {
    expect(isRendererHeartbeatFailure(Object.assign(new Error('lost'), { code: 'companion_connection' }))).toBe(true);
    expect(isRendererHeartbeatFailure(new Error('Failed to fetch'))).toBe(true);
    expect(isRendererHeartbeatFailure(new Error('Local host request failed'))).toBe(true);
    expect(isRendererHeartbeatFailure(new Error('The companion connection was lost while sending the request.'))).toBe(true);
  });

  it('does not treat a tool refusal as the host being gone', () => {
    expect(isRendererHeartbeatFailure(new Error('The target panel is unavailable, busy, or has unsaved work.'))).toBe(false);
    expect(isRendererHeartbeatFailure(Object.assign(new Error('expired'), { code: 'companion_expired' }))).toBe(false);
  });
});

describe('Chrome AppleScript the host runs', () => {
  it('lists only Stereofold-titled loopback tabs', () => {
    const script = chromeListRendererTabUrlsScript();
    expect(script).toContain('tell application "Google Chrome"');
    expect(script).toContain(STEREOFOLD_RENDERER_TITLE);
    expect(script).toContain('http://127.0.0.1:');
    expect(script).toContain('http://localhost:');
    expect(script).toContain('?hostOpened=1');
    expect(script).toContain('&hostOpened=1');
    expect(script).not.toContain('8443');
    expect(script).not.toContain('oculus.com');
  });

  it('closes only the renderer URLs it was handed', () => {
    const script = chromeCloseTabsByUrlScript([markHostOpenedUrl(PANEL), LAN, META]);
    expect(script).toContain(markHostOpenedUrl(PANEL));
    expect(script).not.toContain(LAN);
    expect(script).not.toContain('oculus.com');
    expect(chromeCloseTabsByUrlScript([LAN])).toBe('return');
    expect(chromeCloseTabsByUrlScript([PANEL])).toBe('return');
  });
});

describe('closing and sweeping through the opener’s runner', () => {
  function runner(stdoutByCall: string[] = []) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = async (command: string, args: readonly string[]): Promise<RunResult> => {
      calls.push({ command, args: [...args] });
      return { code: 0, stdout: stdoutByCall.shift() ?? '', stderr: '' };
    };
    return { calls, run };
  }

  it('closes this origin’s listed tabs on darwin and nothing off macOS', async () => {
    const listed = `${PANEL}\n${markHostOpenedUrl(PANEL)}\n${DEAD}\n`;
    const spy = runner([listed]);
    const result = await closeChromeRendererTabs({ origin: LIVE, run: spy.run, platform: 'darwin' });
    expect(result.closed).toEqual([markHostOpenedUrl(PANEL)]);
    expect(result.closed).not.toContain(PANEL);
    expect(spy.calls[0]?.command).toBe(OSASCRIPT);
    expect(spy.calls[1]?.args[1]).toContain(markHostOpenedUrl(PANEL));
    expect(spy.calls[1]?.args[1]).not.toContain(DEAD);
    expect(await closeChromeRendererTabs({ origin: LIVE, platform: 'linux', run: spy.run })).toEqual({ closed: [] });
  });

  it('refuses to close a non-loopback origin', async () => {
    const spy = runner(['https://example.com/\n']);
    expect(await closeChromeRendererTabs({ origin: LAN, run: spy.run })).toEqual({ closed: [] });
    expect(spy.calls).toHaveLength(0);
  });

  it('sweeps tabs whose origin the probe says is dead, and keeps a live one', async () => {
    const pasted = 'http://127.0.0.1:54001/#pasted';
    const listed = `${markHostOpenedUrl(PANEL)}\n${DEAD}\n${pasted}\n`;
    const spy = runner([listed]);
    const probed: string[] = [];
    const result = await sweepDeadRendererTabs({
      run: spy.run, platform: 'darwin', liveOrigin: LIVE,
      probe: async origin => { probed.push(origin); return origin === LIVE; },
    });
    expect(result.closed).toEqual([DEAD]);
    expect(result.closed).not.toContain(pasted);
    expect(probed).toContain('http://127.0.0.1:54001');
    expect(spy.calls[1]?.args[1]).toContain(DEAD);
    expect(spy.calls[1]?.args[1]).not.toContain(markHostOpenedUrl(PANEL));
    expect(spy.calls[1]?.args[1]).not.toContain(pasted);
  });

  it('does not talk to Chrome off macOS', async () => {
    const spy = runner(['http://127.0.0.1:1/\n']);
    expect(await sweepDeadRendererTabs({ platform: 'linux', run: spy.run, probe: async () => false }))
      .toEqual({ closed: [] });
    expect(spy.calls).toHaveLength(0);
  });
});

describe('wiring: the opener, the host, and the page all use this decision', () => {
  it('opens the panel with the hostOpened stamp, closes on SIGTERM, sweeps on start, and self-closes on heartbeat failure', async () => {
    const [opener, share, host, inspector, outer] = await Promise.all([
      readFile(new URL('../src/quest-launch.ts', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/quest-share.ts', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/inspector-host.ts', import.meta.url), 'utf8'),
    ]);
    expect(opener).toMatch(/markHostOpenedUrl\(link\)/);
    expect(opener).toMatch(/closeChromeRendererTabs/);
    expect(opener).toMatch(/sweepDeadRendererTabs/);
    expect(share).toMatch(/sweepDeadRendererTabs\(\{ liveOrigin: address\.origin \}\)/);
    expect(share).toMatch(/closeChromeRendererTabs\(\{ origin: panelOrigin \}\)/);
    expect(host).toMatch(/closeChromeRendererTabs\(\{origin:localOrigin\(\)\}\)/);
    expect(host).toMatch(/path==='\/alive'/);
    expect(inspector).toMatch(/noteRendererHeartbeat\(false\)/);
    expect(inspector).toMatch(/decideRendererTabClose/);
    expect(outer).toMatch(/decideRendererTabClose/);
    expect(outer).toMatch(/window\.close\(\)/);
    expect(outer).toMatch(/RENDERER_TAB_NAME/);
  });
});

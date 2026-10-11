import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Driver, executeDriveStep, OBSERVE_IMMERSIVE_MENU_EXPRESSION, parseDriveArguments,
  HIDDEN_SESSION_ADVICE, type LocatedControl } from '../scripts/headset-drive.js';

afterEach(() => vi.restoreAllMocks());

function session({ button = { x: 10, y: 20, disabled: false, text: 'Enter VR' }, panelPresenting = true,
  pageStartup, rows = 0, panelVisibility = 'visible' }: {
  button?: LocatedControl | null; panelPresenting?: boolean; rows?: number; panelVisibility?: string;
  pageStartup?: { presenting: boolean; sessionVisibility: string | null; phase?: string };
} = {}) {
  const options = parseDriveArguments(['/tmp/share.json', '--out', '/tmp/enter-resume', '--resume-session', '--settle', '0']);
  const driver = new Driver({} as never, 'unused-adb', 0, {} as never, options);
  vi.spyOn(driver, 'agent').mockRejectedValue(Error('Unexpected device call'));
  vi.spyOn(driver, 'assertProximitySafe').mockResolvedValue({ presenting: true, proximityPositive: false, readAt: 'fixture' });
  vi.spyOn(driver, 'stereofoldTarget').mockResolvedValue({ url: 'http://fixture/viewer' } as never);
  const reads: string[] = [];
  vi.spyOn(driver, 'evaluate').mockImplementation(async () => {
    reads.push('session'); return { hook: true, rows, xrStartup: pageStartup ?? null };
  });
  vi.spyOn(driver, 'locate').mockImplementation(async () => { reads.push('button'); return button; });
  const click = vi.spyOn(driver, 'click').mockResolvedValue(undefined);
  vi.spyOn(driver, 'companionPanel').mockImplementation(async () => ({
    surface: 'companion', current: true, availability: 'ready',
    xrStartup: { presenting: panelPresenting || click.mock.calls.length > 0, sessionVisibility: panelVisibility },
  }));
  vi.spyOn(driver, 'waitForPanel').mockImplementation(async (_what, accept) => {
    const panel = await driver.companionPanel();
    if (!accept(panel)) throw Error('Panel is not ready');
    return panel;
  });
  vi.spyOn(driver, 'capture').mockResolvedValue({ path: '/tmp/fixture.png', via: 'fixture' });
  vi.spyOn(driver, 'drainDiagnostics').mockResolvedValue([]);
  vi.spyOn(driver, 'repair').mockRejectedValue(Error('Unexpected repair'));
  vi.spyOn(driver, 'reload').mockRejectedValue(Error('Unexpected reload'));
  vi.spyOn(driver, 'wakeDisplay').mockRejectedValue(Error('Unexpected wake'));
  vi.spyOn(driver, 'pageStatus').mockRejectedValue(Error('Unexpected entry recovery'));
  return { driver, click, reads };
}

describe('enter resumes the session before considering the entry button', () => {
  it.each(['page startup', 'legacy menu rows', 'panel'] as const)
    ('reports the enabled-button page defect without clicking from %s evidence', async signal => {
      const { driver, click, reads } = session({ panelPresenting: signal === 'panel', rows: signal === 'legacy menu rows' ? 17 : 0,
        pageStartup: signal === 'page startup' ? { presenting: true, sessionVisibility: 'visible', phase: 'active' } : undefined });
      const result = await executeDriveStep(driver, 'enter');
      expect(result).toMatchObject({ ok: true, method: 'already-presenting', verified: true,
        evidence: { buttonState: 'enabled', pageDefect: 'Enter VR is enabled while an immersive session is presenting.' } });
      expect(Date.parse(result.endedAt) - Date.parse(result.startedAt)).toBeLessThan(1000);
      expect(click).not.toHaveBeenCalled();
      expect(result.evidence).not.toHaveProperty('clickedAt');
      expect(reads[0]).toBe('session');
    });

  it('trusts a flat page over stale presenting panel evidence and enters once', async () => {
    const { driver, click } = session({ pageStartup: { presenting: false, sessionVisibility: null } });
    const result = await executeDriveStep(driver, 'enter');
    expect(result.ok).toBe(true);
    expect(result.method).toBeNull();
    expect(click).toHaveBeenCalledTimes(1);
    expect(result.evidence.clickedAt).toBe('10,20');
  });

  it('preserves the hidden-session refusal even when Enter VR is enabled', async () => {
    const { driver, click } = session({ pageStartup: { presenting: true, sessionVisibility: 'hidden' } });
    const result = await executeDriveStep(driver, 'enter');
    expect(result).toMatchObject({ ok: false, failure: HIDDEN_SESSION_ADVICE, evidence: { hiddenSession: true } });
    expect(click).not.toHaveBeenCalled();
  });

  it('accepts the current visible page over a stale hidden panel', async () => {
    const { driver, click } = session({ panelVisibility: 'hidden', pageStartup: { presenting: true, sessionVisibility: 'visible' } });
    expect(await executeDriveStep(driver, 'enter')).toMatchObject({ ok: true, method: 'already-presenting' });
    expect(click).not.toHaveBeenCalled();
  });

  it('uses page evidence before attempting to recover a missing entry button', async () => {
    const { driver, click } = session({ button: null, panelPresenting: false, pageStartup: { presenting: true, sessionVisibility: 'visible' } });
    expect(await executeDriveStep(driver, 'enter')).toMatchObject({ ok: true, method: 'already-presenting', evidence: { buttonState: 'missing' } });
    expect(driver.repair).not.toHaveBeenCalled();
    expect(driver.reload).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('does not report a page defect for the correctly disabled button', async () => {
    const { driver, click } = session({ button: { x: 10, y: 20, disabled: true, text: 'Enter VR' } });
    const result = await executeDriveStep(driver, 'enter');
    expect(result).toMatchObject({ ok: true, method: 'already-presenting' });
    expect(result.evidence).not.toHaveProperty('pageDefect');
    expect(click).not.toHaveBeenCalled();
  });

  it('reads XR startup and visibility without pressing or requiring menu rows', () => {
    const h = vm.createContext({ __stereofoldMenu: { rows: () => [],
      xrStartup: () => ({ presenting: true, sessionVisibility: 'visible', phase: 'active' }),
      press: () => { throw Error('Read pressed a control'); } } });
    expect(vm.runInContext(OBSERVE_IMMERSIVE_MENU_EXPRESSION, h)).toMatchObject({
      hook: true, rows: 0, xrStartup: { presenting: true, sessionVisibility: 'visible', phase: 'active' },
    });
  });
});

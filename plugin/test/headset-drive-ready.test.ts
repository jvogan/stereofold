import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Driver, parseDriveArguments, stepOpen } from '../scripts/headset-drive.js';
import { companionStartupMessage } from '../src/companion-startup.js';

const pageMessage = 'The viewer couldn’t finish starting. Open the complete companion link.';
const key = 'a'.repeat(64);
const target = { id: 'viewer', type: 'page', title: 'Stereofold', url: 'https://192.0.2.1/viewer',
  webSocketDebuggerUrl: '/devtools/page/viewer' };

function mockOpen() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const driver = new Driver({} as any, 'unused', 0, {} as any,
    parseDriveArguments(['share.json', '--out', 'captures', '--steps', 'open']));
  const dataset: Record<string, string> = { ready: 'true', panelId: 'paired-panel' };
  const context = {
    document: { body: { dataset }, querySelector: vi.fn(() => ({ textContent: pageMessage })) },
    window: { __STEREOFOLD_COMPANION__: true },
    location: { hash: '' },
    sessionStorage: { getItem: vi.fn((): string | null => key) },
  };
  const panel = { surface: 'companion', availability: 'ready', current: true };
  // A cold browser has no debugger until the no-code launch completes.
  vi.spyOn(driver, 'targets').mockRejectedValue(new Error('Browser stopped'));
  vi.spyOn(driver, 'expectedOrigin').mockResolvedValue(new URL(target.url).origin);
  vi.spyOn(driver, 'stereofoldTarget').mockResolvedValue(target);
  const agent = vi.spyOn(driver, 'agent').mockResolvedValue({ content: [] });
  vi.spyOn(driver, 'adbShell').mockResolvedValue({ code: 0, stdout: Buffer.from(''), stderr: '' });
  vi.spyOn(driver, 'densitySession').mockResolvedValue(undefined);
  const companion = vi.spyOn(driver, 'companionPanel').mockResolvedValue(panel);
  // Keep the tip's pairing-only wait operational for the regression comparison.
  vi.spyOn(driver, 'waitForPanel').mockResolvedValue(panel);
  const evaluate = vi.spyOn(driver, 'evaluate').mockImplementation(async expression => runInNewContext(expression, context));
  const reload = vi.spyOn(driver, 'reload').mockResolvedValue();
  const applyUrl = vi.spyOn(driver, 'applyOpenUrl').mockImplementation(async () => { driver.effectiveUrl = target.url; });
  return { driver, context, dataset, agent, companion, evaluate, reload, applyUrl };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('open verifies the selected page startup', () => {
  it.each([
    { name: 'missing key', message: 'Open the complete companion link.', missingKey: true },
    { name: 'share ended', code: 'companion_expired', message: 'Companion link expired.' },
    { name: 'share closed', code: 'companion_connection', message: 'The connection was lost.' },
  ])('does not reload a terminal startup failure: $name', async failure => {
    const { driver, context, dataset, reload } = mockOpen();
    const shareEnded = companionStartupMessage(failure);
    const message = shareEnded ?? 'The viewer could not finish starting. Choose Reload viewer.';
    dataset.ready = 'error';
    dataset.startupFailure = shareEnded ? 'share-ended' : 'viewer';
    context.document.querySelector.mockReturnValue({ textContent: message });
    if ('missingKey' in failure) context.sessionStorage.getItem.mockReturnValue(null);
    await expect(stepOpen(driver)).rejects.toMatchObject({ message });
    expect(reload, 'terminal startup failures must not reload').not.toHaveBeenCalled();
  });

  const recoverableFailures = [
    { name: 'connection timeout', code: 'companion_connection', message: 'The connection timed out.' },
    { name: 'busy host', code: 'companion_connection', message: 'The host is temporarily unavailable.' },
    { name: 'interrupted connection', code: 'companion_connection', message: 'The connection was interrupted.' },
    { name: 'viewer error', message: 'The molecular change did not produce a frame within 30 seconds.' },
  ];

  it.each(recoverableFailures)('reloads once then succeeds after $name', async failure => {
    const { driver, context, dataset, reload } = mockOpen();
    dataset.ready = 'error';
    dataset.startupFailure = companionStartupMessage(failure) ? 'share-ended' : 'viewer';
    context.document.querySelector.mockReturnValue({ textContent: failure.message });
    reload.mockImplementation(async () => { dataset.ready = 'true'; });
    await expect(stepOpen(driver), 'recoverable startup must succeed after one reload').resolves.toMatchObject({
      evidence: { reloaded: true, pageStartup: { phase: 'ready' } },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each(recoverableFailures)('reloads once then preserves the second $name message', async failure => {
    const { driver, context, dataset, reload } = mockOpen();
    dataset.ready = 'error';
    dataset.startupFailure = companionStartupMessage(failure) ? 'share-ended' : 'viewer';
    context.document.querySelector.mockReturnValue({ textContent: failure.message });
    const secondMessage = 'The viewer could not finish starting. Choose Reload viewer.';
    reload.mockImplementation(async () => {
      context.document.querySelector.mockReturnValue({ textContent: secondMessage });
    });
    const failureResult = await stepOpen(driver).catch(error => error);
    expect(reload, 'recoverable startup failures must reload exactly once').toHaveBeenCalledTimes(1);
    expect(failureResult).toMatchObject({ message: secondMessage,
      evidence: { pageStartup: { phase: 'error', message: secondMessage } } });
  });

  it('rejects a paired-but-not-started page with its own message', async () => {
    const { driver, context, dataset, agent, reload } = mockOpen();
    dataset.ready = 'error';
    context.sessionStorage.getItem.mockReturnValue(null);
    await expect(stepOpen(driver)).rejects.toMatchObject({ message: pageMessage,
      evidence: { pageStartup: { phase: 'error', pairing: true, pageKeyPresent: false } } });
    expect(agent).toHaveBeenCalledWith('open_companion', { connection: 'lan', launch: 'adb' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('rejects the S1 desktop-only panel and missing-key startup error', async () => {
    const { driver, context, dataset, companion } = mockOpen();
    companion.mockResolvedValue({ surface: 'desktop', availability: 'ready' });
    dataset.ready = 'error';
    delete dataset.panelId;
    context.sessionStorage.getItem.mockReturnValue(null);
    await expect(stepOpen(driver)).rejects.toMatchObject({ message: pageMessage,
      evidence: { pageStartup: { phase: 'error', pairing: false, pageKeyPresent: false } } });
  });

  it('waits through loading even when the host already reports paired', async () => {
    vi.useFakeTimers();
    const { driver, dataset, evaluate } = mockOpen();
    dataset.ready = 'loading';
    const opened = stepOpen(driver);
    let completed = false;
    void opened.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toBe(false);
    dataset.ready = 'true';
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await opened;
    expect(result.evidence.pageStartup).toMatchObject({ phase: 'ready', pairing: true, pageKeyPresent: true });
    expect(evaluate.mock.calls.length).toBeGreaterThan(1);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each(['missing key', 'invalid key', 'unpaired page', 'desktop panel', 'unreadable page'])
    ('fails closed at timeout: %s', async failure => {
      const { driver, context, dataset, companion, evaluate } = mockOpen();
      if (failure === 'missing key') context.sessionStorage.getItem.mockReturnValue(null);
      if (failure === 'invalid key') context.sessionStorage.getItem.mockReturnValue('paired');
      if (failure === 'unpaired page') delete dataset.panelId;
      if (failure === 'desktop panel') companion.mockResolvedValue({ surface: 'desktop', availability: 'ready' });
      if (failure === 'unreadable page') evaluate.mockRejectedValue(new Error('Document replaced'));
      await expect(driver.waitForPageReady(0)).rejects.toThrow(
        failure === 'unreadable page' ? 'The viewer did not reach its ready state.' : pageMessage);
    });

  it('accepts a ready page with a fragment key when storage is blocked', async () => {
    const { driver, context } = mockOpen();
    context.location.hash = `#${key}`;
    context.sessionStorage.getItem.mockImplementation(() => { throw new Error('Storage blocked'); });
    const result = await stepOpen(driver);
    expect(result.evidence.pageStartup).toMatchObject({ phase: 'ready', pairing: true, pageKeyPresent: true });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('rechecks the replacement document after a URL override', async () => {
    const { driver, context, dataset, applyUrl } = mockOpen();
    driver.options.query = 'xrRenderBudget=scale:0.5';
    applyUrl.mockImplementation(async () => {
      driver.effectiveUrl = target.url;
      dataset.ready = 'error';
      context.sessionStorage.getItem.mockReturnValue(null);
    });
    await expect(stepOpen(driver)).rejects.toThrow(pageMessage);
  });
});

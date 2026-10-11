import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { inspectionRefusalCaption } from '../src/inspection-refusal-caption.js';
import { describe, expect, it } from 'vitest';
import { SHARE_ENDED_MESSAGE, SHARE_ENDED_STARTUP_FAILURE, companionStartupMessage, shareEndedAtStartup } from '../src/companion-startup.js';

it('the actual startup recovery button pairs a keyless tab instead of reloading it', async () => {
  const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const body = source.slice(source.lastIndexOf('  const shareEnded='), source.lastIndexOf('});'));
  for (const missing of [true, false]) {
    const buttons: any[] = [], navigations: string[] = []; let reloads = 0;
    const status = { textContent: '', setAttribute() {}, append(button: unknown) { buttons.push(button); } };
    const document = { body: { dataset: {}, append() {} }, createElement: () => ({
      addEventListener(_event: string, callback: () => void) { this.click = callback; }, click() {},
    }) };
    runInNewContext(ts.transpile(body), { document, status, isCompanion: true, loadErrorDetails: '',
      companionStartupMessage, error: { code: missing ? 'companion_key_missing' : 'viewer_failure', message: 'Example failure' },
      location: { search: '?xrRenderBudget=default', assign: (path: string) => navigations.push(path), reload: () => reloads++ },
    });
    expect(buttons[0].textContent).toBe(missing ? 'Pair again' : 'Reload viewer');
    expect(navigations).toEqual([]); // Recovery always waits for an explicit click.
    buttons[0].click();
    expect(navigations).toEqual(missing ? ['/?xrRenderBudget=default'] : []);
    expect(reloads).toBe(missing ? 0 : 1);
  }
});


it('classifies direct companion startup failures from their own transport detail before hydration', async () => {
  const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('inspector.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ['callStatus', 'call'].map(name => {
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw Error(`Missing production ${name}`);
    return declaration.getText(parsed);
  }).join('\n');
  const startup = source.slice(source.lastIndexOf('  const shareEnded='), source.lastIndexOf('});'));
  const lost = 'The companion connection was lost while sending the request.';
  const timeout = 'The companion timed out while sending the request. Reconnect from the desktop inspection.';
  for (const original of [lost, timeout]) {
    const status = { textContent: '', setAttribute() {}, append() {} };
    const document = { body: { dataset: {} as Record<string, string>, append() {} },
      createElement: () => ({ addEventListener() {} }) };
    // Stale details from a different request must not override this request's
    // classification, and call() itself must not mutate those global details.
    const staleDetail = original === lost ? timeout : lost;
    const calls: unknown[] = [];
    const context = { document, status, isCompanion: true, loadErrorDetails: staleDetail,
      companionStartupMessage, SHARE_ENDED_STARTUP_FAILURE, inspectionRefusalCaption,
      sceneHistoryClient: { requestStarted: () => 0 }, experiencePreparing: false,
      experiencePlayer: undefined, tourCommandContext: undefined, hostTakesPageBuild: false,
      thrownErrorMessage: (error: Error) => error.message,
      companionCall: async (name: string, args: unknown) => {
        calls.push({ name, args });
        throw Object.assign(new Error(original), { code: 'companion_connection' });
      },
    };
    await runInNewContext(ts.transpile(`${functions}\ncall('get_inspection',{}).catch(error=>{${startup}});`), context);
    expect(calls).toEqual([{ name: 'get_inspection', args: {} }]);
    expect(context.loadErrorDetails).toBe(staleDetail);
    expect(document.body.dataset.startupFailure).toBe(original === lost ? 'share-ended' : 'viewer');
    if (original === lost) expect(status.textContent).toBe(SHARE_ENDED_MESSAGE);
    else {
      expect(status.textContent).toContain('Choose Reload viewer');
      expect(status.textContent).not.toContain('Sharing from your Mac has ended');
    }
  }
});

/**
 * When the Mac's share window closes — about half an hour past the last
 * pairing — a headset booting the companion used to land on `Loading
 * structure…`, `WAITING FOR STRUCTURE`, and then `The viewer couldn't finish
 * starting. The structure couldn't load.` over a `Reload viewer` button.
 * Reloading reached the same closed share, so the viewer never recovered and
 * nothing on screen said that the share was the thing that had ended, or that
 * only the Mac could reopen it.
 */
describe('a companion page whose share has closed', () => {
  it('recognises every shape a closed share arrives in', () => {
    // An expired share closes its listener, so the socket is refused.
    expect(shareEndedAtStartup({ code: 'companion_connection',
      message: 'The companion connection was lost while sending the request.' })).toBe(true);
    // At boot the transport sentence rides in `detail`, because `call()`
    // rewrites a failed `get_inspection` into a sentence about a structure.
    expect(shareEndedAtStartup({ code: 'companion_connection',
      detail: 'The companion connection was lost while sending the request.',
      message: 'The structure couldn’t load. Retry loading, or open Stereofold in a new task if the request keeps failing.' })).toBe(true);
    // 410 {"error":"closed"} — the listener is up and the share is finished.
    expect(shareEndedAtStartup({ code: 'companion_expired', status: 410,
      message: 'This companion link expired. Open a new connection from the desktop inspection.' })).toBe(true);
    // 401 after `open_companion` reopened the share on the same port.
    expect(shareEndedAtStartup({ code: 'companion_expired', status: 401,
      detail: 'This companion link expired. Open a new connection from the desktop inspection.',
      message: 'The structure couldn’t load. Retry loading, or open Stereofold in a new task if the request keeps failing.' })).toBe(true);
    // Still listening, but this page's key is no longer paired: 401 or 410.
    expect(shareEndedAtStartup({ code: 'companion_expired', status: 410 })).toBe(true);
    // A caller that kept the status and lost the code.
    for (const status of [401, 410]) expect(shareEndedAtStartup({ status })).toBe(true);
    // The host's own words, with neither code nor status.
    expect(shareEndedAtStartup({ message: 'This companion link expired. Open a new connection from the desktop inspection.' })).toBe(true);
    expect(shareEndedAtStartup({ message: 'The LAN share expired at 09:14.' })).toBe(true);
  });

  it('leaves a failure that is really the viewer’s own alone', () => {
    // These already say what they are, and sending the wearer to the Mac to
    // reopen sharing would be sending them to fix something that is not broken.
    for (const message of ['The structure couldn’t load. Retry loading, or open Stereofold in a new task if the request keeps failing.',
      'The coordinates changed during delivery. Reconnect before continuing.',
      'The companion returned an invalid coordinate descriptor.',
      'Inspection hydration did not match the opened session.',
      'The experience stage is incomplete.']) {
      expect(shareEndedAtStartup({ message })).toBe(false);
      expect(companionStartupMessage({ message })).toBeUndefined();
    }
    // A server fault is not a closed share; it is worth reading as itself.
    expect(shareEndedAtStartup({ code: 'companion_request', status: 500 })).toBe(false);
  });

  /**
   * `inspection-companion-client.ts` stamps `companion_connection`
   * on every failure that never became an HTTP answer: a refused socket, yes, but
   * also the 15 s `get_inspection` deadline and the host's own 429 `busy`. Reading
   * the code alone told a wearer whose Mac was still sharing to go and reopen the
   * share, while the Reload button in front of them was the real recovery.
   */
  it('does not call a transient boot failure a closed share', () => {
    // The first get_inspection is on a 15 s deadline and carries a whole
    // structure. A slow answer is the share working, not the share ending.
    expect(shareEndedAtStartup({ code: 'companion_connection',
      message: 'The companion timed out while sending the request. Reconnect from the desktop inspection.' })).toBe(false);
    expect(shareEndedAtStartup({ code: 'companion_connection',
      detail: 'The companion timed out while loading coordinates. Reconnect from the desktop inspection.',
      message: 'The structure couldn’t load. Retry loading, or open Stereofold in a new task if the request keeps failing.' })).toBe(false);
    expect(companionStartupMessage({ code: 'companion_connection',
      message: 'The companion timed out while sending the request.' })).toBeUndefined();
    // `inspection-lan.ts` answers 503/5xx and its own 429 {"error":"busy"} while
    // the listener is up; `connectionFetch` turns both into companion_connection.
    for (const status of [408, 429, 500, 502, 503]) {
      expect(shareEndedAtStartup({ code: 'companion_connection', status })).toBe(false);
      expect(companionStartupMessage({ code: 'companion_connection', status })).toBeUndefined();
    }
    expect(shareEndedAtStartup({ code: 'companion_connection',
      message: 'The desktop connection is temporarily unavailable.' })).toBe(false);
    // A body that stopped arriving mid-read is the same transport, still there.
    expect(shareEndedAtStartup({ code: 'companion_connection',
      message: 'The companion connection was interrupted while reading the server response. Reconnect from the desktop inspection.' })).toBe(false);
    // Nothing but the transport code, and no sentence to say which shape it was:
    // the wearer keeps the startup sentence and the Reload button.
    expect(shareEndedAtStartup({ code: 'companion_connection' })).toBe(false);
  });

  it('reads a 404 on the coordinate fetch as the share closing, not as the viewer failing', () => {
    // `get_inspection` succeeded and the
    // share closed before the `/source` fetch a moment later — the half-hour
    // window running out mid-boot. A live share always routes `/source`
    // (`inspection-lan.ts:505` answers 404 only for a path it does not route),
    // so the 404 is the listener being gone. It arrived with no status and the
    // code `companion_request`, matched nothing here, and the wearer got "The
    // viewer couldn’t finish starting" over a Reload button that reloaded into
    // the same closed share for as long as anyone kept pressing it.
    expect(shareEndedAtStartup({ code: 'companion_expired', status: 404,
      message: 'The coordinates are no longer available. Reconnect from the desktop inspection.' })).toBe(true);
    // And for a caller that kept the status but lost the code.
    expect(shareEndedAtStartup({ status: 404 })).toBe(true);
    expect(companionStartupMessage({ code: 'companion_expired', status: 404,
      detail: 'The coordinates are no longer available. Reconnect from the desktop inspection.',
      message: 'The structure couldn’t load. Retry loading, or open Stereofold in a new task if the request keeps failing.' }))
      .toBe(SHARE_ENDED_MESSAGE);
    // A 404 does not beat a host that answered "still here, try again": a
    // deadline or a busy sentence is still the share working.
    expect(shareEndedAtStartup({ status: 404, message: 'The companion timed out while loading coordinates.' })).toBe(false);
  });

  it('says what ended, who reopens it, and what the button in front of the wearer is for', () => {
    expect(companionStartupMessage({ code: 'companion_connection',
      message: 'The companion connection was lost while sending the request.' })).toBe(SHARE_ENDED_MESSAGE);
    expect(SHARE_ENDED_MESSAGE).toMatch(/Sharing from your Mac has ended/u);
    // The wearer cannot reopen a share from inside the headset.
    expect(SHARE_ENDED_MESSAGE).toMatch(/On the Mac/u);
    // A remembered headset re-pairs with no code, which is the difference
    // between a moment's work and taking the headset off.
    expect(SHARE_ENDED_MESSAGE).toMatch(/no code to type/u);
    expect(SHARE_ENDED_MESSAGE).toMatch(/Reload viewer/u);
  });

  it('is what the page shows instead of a startup error, with no retry loop', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const wedge = source.slice(source.indexOf('void boot().catch('));
    expect(wedge).toMatch(/companionStartupMessage\(\{code:/u);
    // The transport's own sentence is the only thing that separates a refused
    // listener from a deadline, and the get_inspection rewrite keeps it here.
    expect(wedge).toMatch(/detail:typeof \(error as any\)\?\.inspectionLoadDetail==='string'/u);
    expect(wedge).toMatch(/inspectionLoadDetail:loadErrorDetails\|\|undefined/u);
    // The share notice replaces the sentence rather than appending to it.
    expect(wedge).toMatch(/status\.textContent=shareEnded\?\?/u);
    // A wearer's page must never start knocking on a closed share by itself.
    expect(wedge).not.toMatch(/setInterval|setTimeout/u);
    // The transport's classification has to survive the get_inspection rewrite,
    // or the wedge can only ever see a sentence about a structure.
    const rewrite = source.slice(source.indexOf('if(name===\'get_inspection\')'), source.indexOf('// The companion client\'s HTTP status'));
    expect(rewrite).toMatch(/throw Object\.assign\(new Error\(recovery\),\{code:/u);
  });
});

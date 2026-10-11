import { describe, expect, it, vi } from 'vitest';
import { SHARE_ENDED_STARTUP_FAILURE } from '../src/companion-startup.js';
import { browserSocketUrl, chooseLiveTab, describeStripSweep, describeTabs, parseTargetInfos, planLaunchHygiene,
  probeTabs, strandedTabs, sweepLaunchTabs, sweepRestoredTabs, sweepStrandedTabs, tabLiveness, TAB_LIVENESS_ORDER,
  type TabReading } from '../src/headset-tabs.js';
import { Driver, parseDriveArguments } from '../scripts/headset-drive.js';

const origin = 'https://192.0.2.1';

/** One `/json` entry the way Quest Browser lists it. */
const listing = (id: string, path = '/viewer', title = 'Stereofold') =>
  ({ id, type: 'page', title, url: `${origin}${path}`, webSocketDebuggerUrl: `/devtools/page/${id}` });

/** What one page answers the liveness probe, or `undefined` for a frozen tab. */
type Answer = { menu?: boolean; menuRows?: number; presenting?: boolean; visibility?: string;
  startupFailure?: string; sessionId?: string; errorPage?: boolean } | undefined;

/**
 * One tab-strip entry, as `Target.getTargets` reports it. `page` is the id of
 * the live page behind it, when the renderer has not been discarded.
 */
type StripEntry = { id: string; url?: string; title?: string; type?: string };

function fakeDevtools(tabs: ReturnType<typeof listing>[], answers: Record<string, Answer>,
  strip?: { entries?: StripEntry[]; endpoint?: boolean; refuse?: string[]; throwOn?: string }) {
  const closed: string[] = [];
  const opened: string[] = [];
  const closedTabs: string[] = [];
  // With no strip given, the browser endpoint reports exactly one tab target
  // per listed page: a strip that matches the page list, which is the case
  // every test written earlier assumes.
  const stripEntries = (): StripEntry[] => strip?.entries
    ?? tabs.filter(tab => !closed.includes(tab.id)).map(tab => ({ id: `t${tab.id}`, url: tab.url, title: tab.title }));
  const transport = {
    fetch: vi.fn(async (_port: number, path: string) => {
      if (path === '/json') return JSON.stringify(tabs.filter(tab => !closed.includes(tab.id)));
      if (path === '/json/version') {
        if (strip?.endpoint === false) return JSON.stringify({ Browser: 'Chrome/100' });
        return JSON.stringify({ Browser: 'Chrome/120', webSocketDebuggerUrl: '/devtools/browser/b1' });
      }
      const id = decodeURIComponent(path.replace('/json/close/', ''));
      closed.push(id);
      return 'Target is closing';
    }),
    open: vi.fn(async (_port: number, socketUrl: string) => {
      if (socketUrl.includes('/devtools/browser/')) {
        return {
          send: async (method: string, parameters: Record<string, unknown>) => {
            if (strip?.throwOn === method) throw Error(`${method} did not answer within 2000 ms.`);
            if (method === 'Target.getTargets') {
              return { result: { targetInfos: stripEntries()
                .filter(entry => !closedTabs.includes(entry.id))
                .map(entry => ({ targetId: entry.id, type: entry.type ?? 'tab',
                  url: entry.url ?? `${origin}/viewer`, title: entry.title ?? 'Stereofold' })) } };
            }
            if (method === 'Target.closeTarget') {
              const id = String(parameters.targetId);
              if (strip?.refuse?.includes(id)) return { result: { success: false } };
              closedTabs.push(id);
              return { result: { success: true } };
            }
            return {};
          },
          close: () => {},
        } as never;
      }
      const id = socketUrl.split('/').pop()!;
      opened.push(id);
      const answer = answers[id];
      return {
        send: async (method: string) => {
          // Quest Browser freezes a backgrounded tab: the handshake completes
          // and then nothing ever answers.
          if (answer === undefined) throw Error(`${method} did not answer within 2000 ms.`);
          if (method !== 'Runtime.evaluate') return {};
          return { result: { value: { url: `${origin}/viewer`, pathname: '/viewer',
            visibility: answer.visibility ?? 'visible', menu: answer.menu === true,
            menuRows: answer.menuRows ?? (answer.menu ? 6 : 0), viewer: true,
            // What `document.body.dataset` holds: null on a page that booted,
            // 'share-ended' beside the plate the wearer reads when it did not.
            startupFailure: answer.startupFailure ?? null, sessionId: answer.sessionId ?? null,
            errorPage: answer.errorPage === true, presenting: answer.presenting === true } } };
        },
        close: () => {},
      } as never;
    }),
  };
  return { transport: transport as never, listTabs: transport.fetch, closed, opened, closedTabs };
}

const reading = (id: string, over: Partial<TabReading> = {}): TabReading =>
  ({ id, url: `${origin}/viewer`, title: 'Stereofold', answered: true, menu: false, menuRows: 0, presenting: false, ...over });

describe('which Quest Browser tab is the live viewer', () => {
  it('ranks a presenting tab over one that only draws the menu, and both over a bare answer', () => {
    expect(tabLiveness(reading('1', { menu: true, presenting: true }))).toBe('presenting');
    expect(tabLiveness(reading('2', { menu: true }))).toBe('menu');
    expect(tabLiveness(reading('3'))).toBe('answered');
    expect(tabLiveness(reading('4', { answered: false, silence: 'frozen' }))).toBe('silent');
    // A tab claiming an immersive session with no menu hook is not a viewer
    // this driver can drive, so it never outranks one that draws rows.
    expect(tabLiveness(reading('5', { presenting: true }))).toBe('answered');
  });

  /**
   * The
   * demo host's ten-hour share ended at 04:26 and a new one opened at 08:05.
   * The wearer's tab was still showing the page's "sharing from your Mac has
   * ended" plate, and that plate leaves the spatial-menu hook installed, so
   * the probe read six rows, called the tab `menu`, kept it and sent no
   * intent. The drive then failed three times on the same tab, because it
   * could read the plate the probe could not.
   */
  it('ranks a tab whose share has ended below one that only answered, however many menu rows it draws', () => {
    expect(tabLiveness(reading('250', { menu: true, menuRows: 6, ended: 'share-ended' }))).toBe('ended');
    // Presenting is no defence either: the ring remembers a session that
    // belonged to the share that closed.
    expect(tabLiveness(reading('250', { menu: true, presenting: true, ended: 'share-ended' }))).toBe('ended');
    expect(tabLiveness(reading('251', { ended: 'other-share', sessionId: 'other' }))).toBe('ended');
    expect(TAB_LIVENESS_ORDER.indexOf('ended')).toBeLessThan(TAB_LIVENESS_ORDER.indexOf('answered'));
  });

  it('chooses no tab when the only one that answers is on a share that ended', () => {
    const choice = chooseLiveTab([reading('250', { menu: true, menuRows: 6, ended: 'share-ended' })]);
    expect(choice.chosen).toBeUndefined();
    expect(choice.reason).toContain('says its share has ended');
    expect(choice.reason).toContain('reopens only from the Mac');
    expect(choice.rejected[0]!.reason).toContain('sharing from the Mac has ended');
    expect(describeTabs([reading('250', { menu: true, ended: 'share-ended' })])).toContain('ended');
  });

  it('prefers a tab that is still on this share over one that ended, whatever the ids say', () => {
    const choice = chooseLiveTab([
      reading('260', { menu: true, menuRows: 6, presenting: true, ended: 'share-ended' }),
      reading('12', { menu: true }),
    ]);
    expect(choice.chosen?.id).toBe('12');
    expect(choice.rejected[0]).toMatchObject({ id: '260' });
  });

  it('picks the one live tab out of twenty-one, exactly the recorded device state', () => {
    const readings = [
      ...Array.from({ length: 20 }, (_, index) => reading(String(50 + index), { answered: false, silence: 'the tab is frozen and answered nothing' })),
      reading('71', { menu: true, menuRows: 6, presenting: true }),
    ];
    const choice = chooseLiveTab(readings);
    expect(choice.chosen?.id).toBe('71');
    expect(choice.reason).toContain('presenting an immersive session');
    expect(choice.rejected).toHaveLength(20);
    expect(choice.rejected.every(entry => entry.reason.includes('frozen'))).toBe(true);
  });

  it('never picks a frozen tab, however new it is', () => {
    const choice = chooseLiveTab([
      reading('9', { answered: false, silence: 'the tab is frozen and answered nothing' }),
      reading('2', { menu: true }),
    ]);
    expect(choice.chosen?.id).toBe('2');
  });

  it('breaks a tie between equally live tabs with the newer id', () => {
    expect(chooseLiveTab([reading('7', { menu: true }), reading('12', { menu: true })]).chosen?.id).toBe('12');
  });

  it('chooses nothing and says why when every candidate is silent', () => {
    const choice = chooseLiveTab([
      reading('70', { answered: false, silence: 'the tab is frozen and answered nothing' }),
      reading('71', { answered: false, silence: 'the tab is frozen and answered nothing' }),
    ]);
    expect(choice.chosen).toBeUndefined();
    expect(choice.reason).toContain('None of the 2 candidate tabs answered');
    expect(describeTabs([reading('70', { answered: false, silence: 'frozen' })])).toContain('silent');
  });
});

describe('what a launch does with the tabs already open', () => {
  it('closes nothing and says older tabs may remain when the debugger did not answer', () => {
    const plan = planLaunchHygiene({ readings: [], probed: false });
    expect(plan).toMatchObject({ close: [], launch: true });
    expect(plan.note).toContain('may still be open');
  });

  it('keeps the live tab, closes the stale duplicates and sends no intent', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [
      reading('70', { answered: false, silence: 'frozen' }),
      reading('71', { menu: true, presenting: true }),
      reading('72', { answered: false, silence: 'frozen' }),
    ] });
    expect(plan).toMatchObject({ launch: false, keep: '71' });
    expect(plan.close.sort()).toEqual(['70', '72']);
  });

  it('closes the tab whose share has ended and sends the launch, with nothing else open', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [reading('250', { ended: 'share-ended' })] });
    expect(plan).toMatchObject({ launch: true, close: ['250'] });
    expect(plan.keep).toBeUndefined();
    expect(plan.note).toContain('Closed 1 viewer tab whose share had ended');
    expect(plan.note).toContain('opened one fresh tab');
    expect(plan.note).toContain('the launch was sent rather than skipped');
  });

  it('closes the ended tab even when it is the one drawing the spatial menu, the recorded device state', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [
      reading('250', { menu: true, menuRows: 6, ended: 'share-ended' }),
      ...Array.from({ length: 5 }, (_, index) => reading(String(240 + index), { answered: false, silence: 'frozen' })),
    ] });
    expect(plan.launch).toBe(true);
    expect(plan.keep).toBeUndefined();
    expect(plan.close).toContain('250');
    expect(plan.close).toHaveLength(6);
    expect(plan.note).toContain('1 viewer tab whose share had ended and 5 frozen viewer tabs that answered nothing');
  });

  it('keeps the tab that is presenting and closes the ended one beside it', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [
      reading('250', { menu: true, menuRows: 6, ended: 'share-ended' }),
      reading('251', { menu: true, presenting: true }),
    ] });
    expect(plan).toMatchObject({ launch: false, keep: '251', close: ['250'] });
    expect(plan.note).toContain('closed 1 viewer tab whose share had ended');
    expect(plan.note).toContain('no new tab was opened');
  });

  it('closes a tab left on the share this host has replaced', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [
      reading('250', { menu: true, ended: 'other-share', sessionId: 'older-session' })] });
    expect(plan).toMatchObject({ launch: true, close: ['250'] });
    expect(plan.note).toContain('1 viewer tab left on another share');
  });

  it('closes every frozen tab and opens one fresh one when nothing is live', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [
      reading('70', { answered: false, silence: 'frozen' }),
      reading('71', { answered: false, silence: 'frozen' }),
    ] });
    expect(plan.launch).toBe(true);
    expect(plan.close.sort()).toEqual(['70', '71']);
  });

  it('leaves exactly one viewer tab after a sweep of twenty-one', async () => {
    const tabs = [
      ...Array.from({ length: 20 }, (_, index) => listing(String(50 + index))),
      listing('71'),
    ];
    const answers: Record<string, Answer> = { 71: { menu: true, presenting: true } };
    const { transport, listTabs, closed } = fakeDevtools(tabs, answers);
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.probed).toBe(true);
    expect(swept.launch).toBe(false);
    expect(swept.keep).toBe('71');
    expect(closed).toHaveLength(20);
    expect(closed).not.toContain('71');
    expect(JSON.parse(await listTabs(9333, '/json')).map((tab: { id: string }) => tab.id)).toEqual(['71']);
  });

  it('never closes a tab on another origin, however much it looks like ours', async () => {
    const tabs = [listing('71'), { ...listing('80'), url: 'https://unrelated.example/viewer' }];
    const { transport, closed } = fakeDevtools(tabs, { 71: { menu: true }, 80: { menu: true } });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.keep).toBe('71');
    expect(closed).toEqual([]);
  });

  it('downgrades to a plain launch when the tunnel will not open', async () => {
    const { transport, closed } = fakeDevtools([listing('71')], { 71: { menu: true } });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => false, probeMs: 5 });
    expect(swept).toMatchObject({ probed: false, launch: true, close: [] });
    expect(swept.note).toContain('may still be open');
    expect(closed).toEqual([]);
  });

  it('reads the ended plate off the page and leaves exactly one paired tab, the recorded sweep', async () => {
    const tabs = [listing('250'), ...Array.from({ length: 5 }, (_, index) => listing(String(240 + index)))];
    // The wearer's tab: booted long enough ago to have the menu hook, then
    // stranded by a share that ran out on its ten-hour timer.
    const answers: Record<string, Answer> = { 250: { menu: true, menuRows: 6, startupFailure: SHARE_ENDED_STARTUP_FAILURE } };
    const { transport, closed, listTabs } = fakeDevtools(tabs, answers);
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.probed).toBe(true);
    expect(swept.launch).toBe(true);
    expect(swept.keep).toBeUndefined();
    expect(closed).toContain('250');
    expect(swept.readings.find(entry => entry.id === '250')).toMatchObject({ answered: true, menu: true, ended: 'share-ended' });
    expect(swept.note).toContain('whose share had ended');
    expect(JSON.parse(await listTabs(9333, '/json'))).toEqual([]);
  });

  it('closes a tab bound to another session, and keeps one bound to this share', async () => {
    const { transport, closed } = fakeDevtools([listing('80'), listing('81')],
      { 80: { menu: true, sessionId: 'session-of-the-old-share' }, 81: { menu: true, sessionId: 'live' } });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin,
      expectedSessionId: 'live', forward: async () => true, probeMs: 5 });
    expect(swept.keep).toBe('81');
    expect(closed).toEqual(['80']);
  });

  it('judges no tab on a session id when either side names none', async () => {
    const { transport, closed } = fakeDevtools([listing('80')], { 80: { menu: true, sessionId: 'whatever' } });
    // The host is not sharing a session it can name, so a page that names one
    // proves nothing and must not be closed on a guess.
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.keep).toBe('80');
    expect(closed).toEqual([]);
    const blank = fakeDevtools([listing('81')], { 81: { menu: true } });
    const second = await sweepLaunchTabs({ transport: blank.transport, port: 9333, expectedOrigin: origin,
      expectedSessionId: 'live', forward: async () => true, probeMs: 5 });
    expect(second.keep).toBe('81');
    expect(blank.closed).toEqual([]);
  });

  it('records a frozen tab as silence rather than throwing', async () => {
    const { transport } = fakeDevtools([listing('70'), listing('71')], { 71: { menu: true } });
    const readings = await probeTabs(transport, { port: 9333, expectedOrigin: origin, probeMs: 5 });
    expect(readings.map(entry => entry.id)).toEqual(['70', '71']);
    expect(readings[0]!.answered).toBe(false);
    expect(readings[0]!.silence).toContain('frozen');
    expect(readings[1]!).toMatchObject({ answered: true, menu: true, menuRows: 6 });
  });
});

describe('the driver drives the tab that answered', () => {
  const driverOn = (tabs: ReturnType<typeof listing>[], answers: Record<string, Answer>) => {
    const fake = fakeDevtools(tabs, answers);
    const driver = new Driver({} as never, 'unused', 9333, fake.transport,
      parseDriveArguments(['share.json', '--out', 'captures', '--steps', 'open']));
    vi.spyOn(driver, 'expectedOrigin').mockResolvedValue(origin);
    return { driver, ...fake };
  };

  it('chooses the live tab among many and says which one and why', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver } = driverOn([listing('70'), listing('71'), listing('72')], { 71: { menu: true, presenting: true } });
    const chosen = await driver.chooseLiveTarget({ rounds: 1 });
    expect(chosen.id).toBe('71');
  });

  it('spends no probe when there is only one candidate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver, opened } = driverOn([listing('71')], {});
    expect((await driver.chooseLiveTarget({ rounds: 1 })).id).toBe('71');
    expect(opened).toEqual([]);
  });

  it('fails with the tab list rather than driving a dead tab', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver } = driverOn([listing('70'), listing('71')], {});
    await expect(driver.chooseLiveTarget({ rounds: 2, wait: async () => {} })).rejects.toMatchObject({
      message: expect.stringContaining('None of the 2 candidate tabs answered'),
      evidence: { tabs: [expect.stringContaining('silent'), expect.stringContaining('silent')] },
    });
  });

  /**
   * The disagreement this defect is made of: the drive read the
   * plate and refused the tab while the host's sweep read the menu rows and
   * kept it. Both now read the same flag off the same page, so a tab the drive
   * will not enter is a tab the launch closes.
   */
  it('agrees with the launch sweep about a tab whose share has ended', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answers: Record<string, Answer> = { 250: { menu: true, menuRows: 6, startupFailure: SHARE_ENDED_STARTUP_FAILURE } };
    const { driver, transport } = driverOn([listing('250'), listing('240')], answers);
    await expect(driver.chooseLiveTarget({ rounds: 1 })).rejects.toMatchObject({
      message: expect.stringContaining('says its share has ended'),
    });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.launch).toBe(true);
    expect(swept.close).toContain('250');
  });

  it('drives the page this run already found when the debugger will not list its tabs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { driver } = driverOn([listing('71')], {});
    vi.spyOn(driver, 'targets').mockRejectedValue(new Error('Browser stopped'));
    const fallback = listing('71');
    expect((await driver.chooseLiveTarget({ rounds: 1, fallback })).id).toBe('71');
  });
});

/**
 * Eleven Stereofold
 * entries in the wearer's tab strip while `/json/list` reported two pages.
 * Quest Browser discards the renderer of every tab that is not in front and
 * keeps the strip entry, so the page list is not the strip and a sweep that
 * closes only what the page list names leaves the wearer looking at the rest.
 */
describe('the tab strip Quest Browser keeps behind the page list', () => {
  const tabTarget = (id: string, path = '/viewer') => ({ targetId: id, type: 'tab', title: 'Stereofold', url: `${origin}${path}` });

  it('reads the browser endpoint out of /json/version, and says so when there is none', () => {
    expect(browserSocketUrl(JSON.stringify({ webSocketDebuggerUrl: 'ws://x/devtools/browser/b1' }))).toBe('ws://x/devtools/browser/b1');
    expect(browserSocketUrl(JSON.stringify({ Browser: 'Chrome/100' }))).toBeUndefined();
    expect(browserSocketUrl('not json')).toBeUndefined();
  });

  it('narrows a Target.getTargets reply to ids, types and addresses', () => {
    const parsed = parseTargetInfos({ result: { targetInfos: [tabTarget('t1'), { targetId: '', type: 'tab' }, 'junk'] } });
    expect(parsed).toEqual([{ id: 't1', type: 'tab', title: 'Stereofold', url: `${origin}/viewer`, webSocketDebuggerUrl: '' }]);
    expect(parseTargetInfos({})).toEqual([]);
  });

  it('counts strip entries per address, so eleven against two is nine and not one', () => {
    const tabs = parseTargetInfos({ result: { targetInfos: Array.from({ length: 11 }, (_, index) => tabTarget(`t${index}`)) } });
    const listed = [listing('70'), listing('71')];
    const stranded = strandedTabs({ tabs, listed, expectedOrigin: origin });
    expect(stranded).toHaveLength(9);
    expect(stranded.map(tab => tab.id)).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']);
  });

  it('never counts a tab on another origin or a target that is not a tab', () => {
    const tabs = parseTargetInfos({ result: { targetInfos: [
      tabTarget('t1'), { ...tabTarget('t2'), url: 'https://unrelated.example/viewer' },
      { ...tabTarget('t3'), type: 'page' }, { ...tabTarget('t4'), url: `${origin}/settings` }] } });
    expect(strandedTabs({ tabs, listed: [], expectedOrigin: origin }).map(tab => tab.id)).toEqual(['t1']);
  });

  it('closes the strip entries with no page behind them and leaves the live one', async () => {
    const { transport, closedTabs } = fakeDevtools([listing('71')], { 71: { menu: true, presenting: true } }, {
      entries: [{ id: 'tlive' }, { id: 'told1' }, { id: 'told2' }],
    });
    const swept = await sweepStrandedTabs(transport, { port: 9333, expectedOrigin: origin });
    expect(swept.enumerated).toBe(true);
    expect(swept.stranded.map(tab => tab.id)).toEqual(['told1', 'told2']);
    expect(closedTabs).toEqual(['told1', 'told2']);
    expect(describeStripSweep(swept)).toContain('Closed 2 discarded Stereofold tabs');
  });

  it('says the count it could not close, and names the wearer’s own cleanup', async () => {
    const { transport } = fakeDevtools([listing('71')], { 71: { menu: true } }, {
      entries: [{ id: 'tlive' }, { id: 'told1' }, { id: 'told2' }, { id: 'told3' }],
      refuse: ['told2', 'told3'],
    });
    const swept = await sweepStrandedTabs(transport, { port: 9333, expectedOrigin: origin });
    expect(swept.stranded).toHaveLength(3);
    expect(swept.closed).toEqual(['told1']);
    const said = describeStripSweep(swept);
    expect(said).toContain('1 of 3 discarded Stereofold tabs');
    expect(said).toContain('2 would not close');
    expect(said).toContain('Close all tabs');
    expect(said).toContain('quest-operator-runbook.md');
  });

  it('never reports a clean strip it could not look at', async () => {
    const noEndpoint = fakeDevtools([listing('71')], { 71: { menu: true } }, { endpoint: false, entries: [] });
    const blind = await sweepStrandedTabs(noEndpoint.transport, { port: 9333, expectedOrigin: origin });
    expect(blind).toMatchObject({ enumerated: false, stranded: [], closed: [] });
    expect(describeStripSweep(blind)).toContain('does not let the debugger enumerate its tab strip');
    expect(describeStripSweep(blind)).toContain('Close all tabs');

    const refused = fakeDevtools([listing('71')], { 71: { menu: true } }, { throwOn: 'Target.getTargets', entries: [] });
    const thrown = await sweepStrandedTabs(refused.transport, { port: 9333, expectedOrigin: origin });
    expect(thrown.enumerated).toBe(false);
    expect(thrown.reason).toContain('Target.getTargets');
  });

  it('treats a build that answers with page targets only as one that cannot say', async () => {
    const { transport } = fakeDevtools([listing('71')], { 71: { menu: true } }, {
      entries: [{ id: 'p71', type: 'page' }, { id: 'p80', type: 'page' }],
    });
    const swept = await sweepStrandedTabs(transport, { port: 9333, expectedOrigin: origin });
    expect(swept.enumerated).toBe(false);
    expect(swept.reason).toContain('no tab targets');
    expect(describeStripSweep(swept)).toContain('may still be sitting in it');
  });

  it('carries the strip result and its sentence out of a whole launch sweep', async () => {
    const { transport, closed, closedTabs } = fakeDevtools(
      [listing('70'), listing('71')], { 71: { menu: true, presenting: true } },
      { entries: [{ id: 'tlive' }, { id: 'tstale' }, { id: 'tstale2' }] });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(closed).toEqual(['70']);
    expect(swept.keep).toBe('71');
    // Tab 70 was closed first, so only the live page is left to account for
    // the three strip entries.
    expect(swept.strip.enumerated).toBe(true);
    expect(swept.strip.stranded.map(tab => tab.id)).toEqual(['tstale', 'tstale2']);
    expect(closedTabs).toEqual(['tstale', 'tstale2']);
    expect(swept.note).toContain('Closed 2 discarded Stereofold tabs');
  });

  it('still warns about the strip when the debugger tunnel never opened', async () => {
    const { transport } = fakeDevtools([listing('71')], { 71: { menu: true } });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => false, probeMs: 5 });
    expect(swept.probed).toBe(false);
    expect(swept.strip.enumerated).toBe(false);
    expect(swept.note).toContain('may still be open');
    expect(swept.note).toContain('discarded Stereofold tabs may still be sitting in it');
  });
});

/**
 * A viewer tab whose boot failed answers the probe fluently and draws no menu,
 * so it ranked `answered` and a launch kept it. The two stale tabs Quest
 * Browser once restored were that tab: each asked to pair again.
 */
describe('a tab whose page failed to start', () => {
  it('is closed and the launch sent, rather than kept as the live tab', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [reading('9', { startupFailure: 'viewer' }), reading('10', { startupFailure: 'viewer' })] });
    expect(plan).toMatchObject({ launch: true, close: ['9', '10'] });
    expect(plan.keep).toBeUndefined();
    expect(plan.note).toContain('Closed 2 viewer tabs whose page failed to start, then opened one fresh tab.');
    expect(plan.note).toContain('cannot load this share by itself');
  });

  it('loses to a live tab beside it', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [reading('9', { startupFailure: 'viewer' }), reading('12', { menu: true })] });
    expect(plan).toMatchObject({ launch: false, keep: '12', close: ['9'] });
    expect(plan.note).toContain('closed 1 viewer tab whose page failed to start');
  });

  it('stays driveable for the drive, which re-pairs or reloads it', () => {
    expect(chooseLiveTab([reading('9', { startupFailure: 'viewer' })]).chosen?.id).toBe('9');
  });

  it('is read off the page by the probe', async () => {
    const { transport, closed } = fakeDevtools([listing('9'), listing('10')], { 9: { startupFailure: 'viewer' }, 10: { startupFailure: 'viewer' } });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.readings.map(entry => entry.startupFailure)).toEqual(['viewer', 'viewer']);
    expect(swept).toMatchObject({ probed: true, launch: true });
    expect(closed.sort()).toEqual(['10', '9']);
  });
});

/**
 * A viewer tab stopped at Quest Browser's certificate
 * warning answers the probe from Chromium's error page and draws no menu, so
 * it ranked `answered` and a launch kept it and sent no pairing code. The
 * person's Proceed would then load the address that tab failed on.
 */
describe('a tab on the certificate warning', () => {
  it('is closed and the launch sent, rather than kept as the live tab', () => {
    const plan = planLaunchHygiene({ probed: true, readings: [reading('9', { title: 'Privacy error', errorPage: true })] });
    expect(plan).toMatchObject({ launch: true, close: ['9'] });
    expect(plan.keep).toBeUndefined();
  });

  it('is read off the page, or off its title when the page does not say', async () => {
    const { transport, closed } = fakeDevtools([listing('9'), listing('10', '/viewer', 'Privacy error')], { 9: { errorPage: true }, 10: {} });
    const swept = await sweepLaunchTabs({ transport, port: 9333, expectedOrigin: origin, forward: async () => true, probeMs: 5 });
    expect(swept.readings.map(entry => entry.errorPage)).toEqual([true, true]);
    expect(swept).toMatchObject({ probed: true, launch: true });
    expect(closed.sort()).toEqual(['10', '9']);
  });
});

describe('the strip count', () => {
  it('matches a live page to its own strip entry when only the fragment differs', () => {
    const entry = (id: string) => ({ id, type: 'tab', title: 'Stereofold', url: `${origin}/viewer`, webSocketDebuggerUrl: '' });
    const listed = [{ ...listing('71'), url: `${origin}/viewer#${'a'.repeat(64)}` }];
    expect(strandedTabs({ tabs: [entry('t71'), entry('t9')], listed, expectedOrigin: origin }).map(tab => tab.id)).toEqual(['t9']);
  });
});

/**
 * The browser a launch just started. `listings` is what `/json` answers on
 * each read, the last repeating; an Error is a debugger that is not up yet.
 */
function restartedBrowser(listings: Array<Array<{ id: string; path?: string; at?: string }> | Error>, strip: string[] = []) {
  const closed: string[] = [], closedTabs: string[] = [];
  let reads = 0;
  const transport = {
    fetch: vi.fn(async (_port: number, path: string) => {
      if (path === '/json') {
        const listed = listings[Math.min(reads++, listings.length - 1)]!;
        if (listed instanceof Error) throw listed;
        return JSON.stringify(listed.filter(tab => !closed.includes(tab.id)).map(tab => ({ id: tab.id, type: 'page', title: 'Stereofold',
          url: `${tab.at ?? origin}${tab.path ?? '/viewer'}`, webSocketDebuggerUrl: `/devtools/page/${tab.id}` })));
      }
      if (path === '/json/version') return JSON.stringify({ webSocketDebuggerUrl: '/devtools/browser/b1' });
      closed.push(decodeURIComponent(path.replace('/json/close/', '')));
      return 'Target is closing';
    }),
    open: vi.fn(async (_port: number, _socketUrl: string) => ({
      send: async (method: string, parameters: Record<string, unknown>) => {
        if (method === 'Target.getTargets') return { result: { targetInfos: strip.filter(id => !closedTabs.includes(id))
          .map(id => ({ targetId: id, type: 'tab', title: 'Stereofold', url: `${origin}/viewer` })) } };
        if (method === 'Target.closeTarget') { closedTabs.push(String(parameters.targetId)); return { result: { success: true } }; }
        return {};
      },
      close: () => {},
    })),
  };
  return { transport: transport as never, fetch: transport.fetch, open: transport.open, closed, closedTabs };
}

describe('the tabs a cold start reopens', () => {
  const sweep = (browser: ReturnType<typeof restartedBrowser>, over: { attempts?: number; forward?: () => Promise<boolean> } = {}) =>
    sweepRestoredTabs({ transport: browser.transport, port: 9333, expectedOrigin: origin, forward: over.forward ?? (async () => true),
      attempts: over.attempts ?? 5, pollMs: 1, pause: async () => {} });

  it('keeps the tab the intent opened, closes the reopened ones and asks no page anything', async () => {
    const tabs = [{ id: '9' }, { id: '10' }, { id: '12' }];
    const browser = restartedBrowser([Error('socket hang up'), tabs], ['t12', 'tOld1', 'tOld2']);
    const swept = await sweep(browser);
    expect(swept).toMatchObject({ answered: true, keep: '12', closed: ['9', '10'], listed: ['9', '10', '12'] });
    expect(browser.closedTabs).toEqual(['tOld1', 'tOld2']);
    expect(swept.note).toContain('Quest Browser was not running, so this launch started it.');
    expect(swept.note).toContain('reopened 2 older tabs on this share; this Mac closed 2 and kept tab 12');
    expect(swept.note).toContain('Closed 2 discarded Stereofold tabs');
    // Only the browser endpoint is ever opened: no page is probed.
    expect(browser.open.mock.calls.map(call => call[1])).toEqual(['/devtools/browser/b1']);
  });

  it('leaves the strip for the next launch while the new tab is still pairing', async () => {
    const browser = restartedBrowser([[{ id: '9' }, { id: '12', path: '/' }]], ['tOld1']);
    const swept = await sweep(browser);
    expect(swept).toMatchObject({ keep: '12', closed: ['9'] });
    expect(swept.strip).toBeUndefined();
    expect(browser.closedTabs).toEqual([]);
    expect(swept.note).toContain('still pairing');
  });

  it('closes nothing until the same tabs are listed twice', async () => {
    const settled = restartedBrowser([[{ id: '9' }], [{ id: '9' }, { id: '12' }]]);
    expect(await sweep(settled)).toMatchObject({ keep: '12', closed: ['9'] });
    const moving = restartedBrowser([[{ id: '9' }], [{ id: '9' }, { id: '12' }], [{ id: '9' }, { id: '12' }, { id: '14' }]]);
    const unsettled = await sweep(moving, { attempts: 3 });
    expect(unsettled).toMatchObject({ answered: true, closed: [] });
    expect(unsettled.note).toContain('did not settle within');
    expect(moving.closed).toEqual([]);
  });

  it('closes nothing when the debugger never answers or cannot be forwarded', async () => {
    const silent = await sweep(restartedBrowser([Error('socket hang up')]), { attempts: 3 });
    expect(silent).toMatchObject({ answered: false, closed: [] });
    expect(silent.note).toContain('did not answer within');
    const unforwarded = await sweep(restartedBrowser([[{ id: '12' }]]), { forward: async () => false });
    expect(unforwarded).toMatchObject({ answered: false, closed: [] });
    expect(unforwarded.note).toContain('could not be forwarded');
  });

  it('never touches another origin, and closes nothing when the ids are not numbers', async () => {
    const mixed = restartedBrowser([[{ id: '12' }, { id: '30', at: 'https://unrelated.example' }]]);
    expect(await sweep(mixed)).toMatchObject({ keep: '12', closed: [], listed: ['12'] });
    expect(mixed.closed).toEqual([]);
    const named = restartedBrowser([[{ id: 'A1' }, { id: 'B2' }]]);
    const unnumbered = await sweep(named);
    expect(unnumbered).toMatchObject({ closed: [] });
    expect(unnumbered.keep).toBeUndefined();
    expect(unnumbered.note).toContain('not numbers');
  });
});

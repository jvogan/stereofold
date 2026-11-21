import { describe, expect, it, vi } from 'vitest';
import { openOnQuest, QUEST_BROWSER_PACKAGE, type LaunchTabHygiene, type RunResult, type Runner } from '../src/quest-launch.js';
import { BROWSER_START, fakeQuestAdb, SOCKET_COUNT } from './helpers/fake-quest-adb.js';

const ADDRESS = 'https://192.168.77.24:8443/';
const ADB = '/opt/homebrew/bin/adb';
const VIEW = `shell am start -a android.intent.action.VIEW -p ${QUEST_BROWSER_PACKAGE} -d ${ADDRESS}`;
const ACTIVITIES = 'shell dumpsys activity activities';
const READS = ['devices', ACTIVITIES, 'shell dumpsys power', `shell pidof ${QUEST_BROWSER_PACKAGE}`];
const PACKAGES = `shell pm list packages ${QUEST_BROWSER_PACKAGE}`;
const COLD_NOTE = 'Quest Browser was not running, so this launch started it. It reopened no other tab on this share.';
const hygiene = (note: string): LaunchTabHygiene => ({ probed: true, launch: true, closed: [], tabs: [],
  strip: { enumerated: true, stranded: 0, closed: 0 }, note });
/** What a cold start whose link landed answers. */
const COLD_RESULT = { opened: true, headset: { guardianDialog: false, display: 'Awake', worn: false, browserRunning: false },
  tabHygiene: hygiene(COLD_NOTE), message: `  launch attempted on A · put the headset on, then tap Enter VR. ${COLD_NOTE}` };

/** One real turn of the event loop, after which Node has reported any rejection nobody handled. */
const eventLoopTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('a cold start whose browser start never answers', () => {
  it('sends the link once at the ten-second limit with the ordinary cold-start answer, and handles the start rejecting later', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', record);
    vi.useFakeTimers();
    try {
      const fake = fakeQuestAdb({ devices: 'List of devices attached\nA\tdevice\n', browserPid: null, socket: '1\n' });
      // The start is asked for and recorded, then gives no answer until it is
      // refused at fifteen seconds, well past the limit.
      const run: Runner = async (command, args) => {
        const answered = await fake.run(command, args);
        if (!args.includes('-n')) return answered;
        return new Promise<RunResult>((_, reject) => { setTimeout(() => reject(Error('adb: device offline')), 15_000); });
      };
      const marks: string[] = [];
      const tabs = {
        before: vi.fn(async () => { marks.push('tabs.before'); return hygiene('unused'); }),
        restored: vi.fn(async () => { marks.push('tabs.restored'); return hygiene(COLD_NOTE); }),
      };
      const pending = openOnQuest({ url: ADDRESS, adb: ADB, run, tabs, recheckMs: 0 });
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(fake.asked()).toEqual([...READS, PACKAGES, BROWSER_START]);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await pending;
      // No debugger read: the wait ends with the unanswered start, and the
      // link goes out once, right after it.
      expect(fake.asked()).toEqual([...READS, PACKAGES, BROWSER_START, VIEW, ACTIVITIES]);
      expect(fake.asked()).not.toContain(SOCKET_COUNT);
      expect(marks).toEqual(['tabs.restored']);
      expect(result).toEqual(COLD_RESULT);

      // The start is refused later; nothing more is sent and nothing goes unhandled.
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
      await eventLoopTurn();
      await eventLoopTurn();
      expect(fake.asked()).toEqual([...READS, PACKAGES, BROWSER_START, VIEW, ACTIVITIES]);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off('unhandledRejection', record);
    }
  });
});

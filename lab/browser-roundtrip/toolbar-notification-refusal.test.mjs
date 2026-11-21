import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Isolate real unhandled-rejection events: node:test deliberately fails a test
// whose process emits one, even when the test installs an event listener.
test('tour and voice notifications quietly retain the menu during a molecular drag', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    const source = readFileSync('lab/browser-roundtrip/viewer.mjs', 'utf8');
    const errors = [], listeners = [];
    process.on('unhandledRejection', error => errors.push(error.message));
    let dragging = true, drawn = 0, measured = 0;
    const h = vm.createContext({
      canvas: { xr: { isPresenting: { value: true } } }, latestRoomPlacementPose: {},
      interactionActive: () => dragging, chapterFieldBounds: () => { measured++; return undefined; },
      detachSpatialTour: undefined, detachVoiceInteraction: undefined,
      spatialTour: undefined, voiceInteraction: undefined, rememberSpokenReply: v => v,
      immersiveSession: { refreshToolbar: async () => {
        const clearance = await h.clearChapterMenu({ points: [], isCurrent: () => true });
        if (dragging && clearance?.unmeasured !== true) throw Error('a held molecule claimed clearance');
        drawn++;
      } },
    });
    for (const name of ['clearChapterMenu', 'setSpatialTour', 'setVoiceInteraction']) {
      const start = source.search(new RegExp('  (?:async )?function ' + name + '\\\\('));
      vm.runInContext(source.slice(start, source.indexOf('\\n  }', start) + 4), h);
    }
    const subscribe = fn => { listeners.push(fn); return () => {}; };
    h.setSpatialTour({ getState() {}, subscribe });
    h.setVoiceInteraction({ toggle() {}, state() {}, subscribe });
    for (const notify of listeners) notify();
    await new Promise(resolve => setImmediate(resolve));
    const during = drawn, measuredDuring = measured;
    dragging = false;
    for (const notify of listeners) notify();
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ errors, during, drawn, measuredDuring, measured }));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.errors, []);
  // During the drag each attach and notification redraws the menu at its
  // kept seat, unmeasured: a chapter preview must not be rolled back while a
  // hand holds the molecule, and no clearance is measured against the live
  // grab transform.
  assert.equal(observed.during, 4, 'attach and notification redraws keep the menu seat');
  assert.equal(observed.measuredDuring, 0, 'no clearance is measured while the molecule is held');
  assert.equal(observed.drawn, 6, 'notifications redraw after release');
  assert.equal(observed.measured, 2, 'released notifications measure clearance again');
});

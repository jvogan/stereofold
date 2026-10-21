import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Isolate real unhandled-rejection events: node:test deliberately fails a test
// whose process emits one, even when the test installs an event listener.
test('tour and voice notifications redraw status without claiming clearance during a molecular drag', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    const source = readFileSync('lab/browser-roundtrip/viewer.mjs', 'utf8');
    const errors = [], listeners = [];
    process.on('unhandledRejection', error => errors.push(error.message));
    let dragging = true, drawn = 0; const proofs = [];
    const h = vm.createContext({
      canvas: { xr: { isPresenting: { value: true } } }, latestRoomPlacementPose: {},
      interactionActive: () => dragging, chapterFieldBounds: () => { if (dragging) throw Error('must not fit a live grab'); return undefined; },
      detachSpatialTour: undefined, detachVoiceInteraction: undefined,
      spatialTour: undefined, voiceInteraction: undefined, rememberSpokenReply: v => v,
      immersiveSession: { refreshToolbar: async () => {
        proofs.push(await h.clearChapterMenu({ points: [], isCurrent: () => true })); drawn++;
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
    const during = drawn;
    dragging = false;
    for (const notify of listeners) notify();
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ errors, during, drawn, proofs }));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.errors, []);
  assert.equal(observed.during, 4, 'attachment and notifications may redraw status during a grab');
  assert.deepEqual(observed.proofs.slice(0, 4), Array.from({ length: 4 }, () => ({ unmeasured: true })));
  assert.deepEqual(observed.proofs.slice(4), [null, null], 'release resumes ordinary clearance');
  assert.equal(observed.drawn, 6, 'notifications can redraw after release');
});

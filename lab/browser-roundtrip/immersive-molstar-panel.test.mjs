import assert from 'node:assert/strict';
import test from 'node:test';
import { createMolstarPanelUploadGate, hitMolstarPanel, immersiveMolstarPanelEnabled,
  molstarPanelPickSequence, molstarPanelPointerEvent, molstarPanelQuad, molstarPanelResolution,
  molstarPanelTrackedPointer, molstarPanelTrafficPerSecond, MOLSTAR_PANEL_BYTES_PER_TEXEL,
  MOLSTAR_PANEL_MAX_TEXELS, MOLSTAR_PANEL_MAX_UPLOAD_HZ } from './immersive-molstar-panel.mjs';

test('the prototype is off unless the wearer asked for it by name', () => {
  assert.equal(immersiveMolstarPanelEnabled(undefined), false);
  assert.equal(immersiveMolstarPanelEnabled({}), false);
  assert.equal(immersiveMolstarPanelEnabled({ molstarPanel: false }), false);
  // Nothing but the boolean the knob parser writes counts as on, so a knob
  // spelled wrong leaves the wearer in the shipped path.
  assert.equal(immersiveMolstarPanelEnabled({ molstarPanel: 'on' }), false);
  assert.equal(immersiveMolstarPanelEnabled({ molstarPanel: true }), true);
});

test('the texture is capped by the device before it is capped by the eye', () => {
  const panel = { widthMeters: 0.6, heightMeters: 0.45, rangeMeters: 0.95 };
  const quest2 = molstarPanelResolution({ ...panel, deviceClass: 'quest2' });
  assert.equal(quest2.limited, 'device', 'a Quest 2 runs out of bandwidth long before the lens runs out of pixels');
  assert.ok(quest2.texels <= MOLSTAR_PANEL_MAX_TEXELS.quest2, `${quest2.texels} texels is over the Quest 2 cap`);
  assert.equal(quest2.bytes, quest2.texels * MOLSTAR_PANEL_BYTES_PER_TEXEL);
  // The panel's aspect survives the cap: a canvas that does not match its quad
  // shows a stretched molecule, which is worse than a soft one.
  const ratio = quest2.height / quest2.width;
  assert.ok(Math.abs(ratio - 0.75) < 0.12, `aspect drifted to ${ratio}`);
  // A Quest 3 has room for the step up, which is why the cap is per device.
  const quest3 = molstarPanelResolution({ ...panel, deviceClass: 'quest3' });
  assert.ok(quest3.texels > quest2.texels);
  assert.ok(quest3.texels <= MOLSTAR_PANEL_MAX_TEXELS.quest3);
  // An unknown headset is treated as the small one. Guessing upwards spends a
  // budget nobody measured.
  assert.deepEqual(molstarPanelResolution({ ...panel }), quest2);
});

test('a panel small enough for the lens to resolve is not padded out to the cap', () => {
  // A hand-sized panel at arm's length subtends little, so the eye limit bites
  // first and the texture is the smaller of the two answers.
  const small = molstarPanelResolution({ widthMeters: 0.12, heightMeters: 0.09, rangeMeters: 0.95, deviceClass: 'quest2' });
  assert.equal(small.limited, 'eye');
  assert.ok(small.texels < MOLSTAR_PANEL_MAX_TEXELS.quest2 / 4, `${small.texels} is most of the cap for a small panel`);
  // Sizes stay on the step, so every upload row is aligned.
  assert.equal(small.width % 32, 0);
  assert.equal(small.height % 32, 0);
});

test('a very wide panel is brought under the cap on its long axis', () => {
  const wide = molstarPanelResolution({ widthMeters: 2.4, heightMeters: 0.3, rangeMeters: 0.95, deviceClass: 'quest2' });
  assert.ok(wide.texels <= MOLSTAR_PANEL_MAX_TEXELS.quest2, `${wide.width}x${wide.height} is over the cap`);
  assert.ok(wide.width > wide.height, 'a wide panel keeps a wide texture');
});

test('the texture is re-uploaded only when Mol* has drawn', () => {
  let clock = 0;
  const gate = createMolstarPanelUploadGate({ now: () => clock });
  // Nothing has drawn yet, so an XR frame arriving here copies nothing at all.
  assert.equal(gate.shouldUpload(), false);
  gate.markDrawn();
  assert.equal(gate.shouldUpload(), true);
  gate.noteUploaded();
  // The panel is idle again: the wearer is looking at the molecule, not at it.
  for (let frame = 0; frame < 72; frame += 1) { clock += 1000 / 72; assert.equal(gate.shouldUpload(), false); }
  assert.deepEqual(gate.stats().uploads, 1);
  assert.equal(gate.stats().skippedClean, 73);
  assert.equal(gate.stats().skippedFast, 0);
});

test('a Mol* drawing as fast as it can is still bounded to the upload rate', () => {
  let clock = 0;
  const gate = createMolstarPanelUploadGate({ maxHz: MOLSTAR_PANEL_MAX_UPLOAD_HZ, now: () => clock });
  // One second of a wearer dragging the structure: Mol* draws on every one of
  // its own frames and the XR loop asks on every one of its 72.
  for (let frame = 0; frame < 72; frame += 1) {
    gate.markDrawn(clock);
    if (gate.shouldUpload(clock)) gate.noteUploaded(clock);
    clock += 1000 / 72;
  }
  const stats = gate.stats();
  assert.equal(stats.draws, 72);
  assert.ok(stats.uploads <= MOLSTAR_PANEL_MAX_UPLOAD_HZ + 1, `${stats.uploads} uploads in one second`);
  assert.ok(stats.uploads >= MOLSTAR_PANEL_MAX_UPLOAD_HZ - 1, `${stats.uploads} uploads is slower than the panel promises`);
  assert.ok(stats.skippedFast > 50, 'the rate limit is what skipped the rest');
});

test('a gate with no rate limit still refuses a clean canvas', () => {
  let clock = 0;
  const gate = createMolstarPanelUploadGate({ maxHz: 0, now: () => clock });
  gate.markDrawn();
  assert.equal(gate.shouldUpload(), true);
  gate.noteUploaded();
  clock += 100_000;
  assert.equal(gate.shouldUpload(), false, 'nothing drew, so there is nothing to copy');
});

/** A panel a metre in front of a wearer looking down -Z, square to the view. */
const seated = molstarPanelQuad({ anchor: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
  widthMeters: 0.6, heightMeters: 0.45 });

test('the quad squares its own basis and winds its corners from the bottom left', () => {
  assert.ok(seated);
  assert.deepEqual(seated.normal.map(value => Math.round(value)), [0, 0, 1]);
  assert.equal(seated.halfWidth, 0.3);
  assert.equal(seated.halfHeight, 0.225);
  assert.deepEqual(seated.corners[0], [-0.3, -0.225, -1]);
  assert.deepEqual(seated.corners[2], [0.3, 0.225, -1]);
  // A basis handed in slightly out of square is re-squared rather than refused:
  // a head pose is never exactly orthogonal and a skewed quad puts the pick a
  // few pixels off the ray.
  const skewed = molstarPanelQuad({ anchor: [0, 0, -1], right: [1, 0, 0], up: [0.04, 1, 0] });
  assert.ok(Math.abs(skewed.right[0] * skewed.up[0] + skewed.right[1] * skewed.up[1]) < 1e-9);
  // Nonsense in, nothing out. A half-built quad would be a pointer that lands
  // somewhere arbitrary rather than nowhere.
  assert.equal(molstarPanelQuad({ anchor: [0, 0, -1], right: [0, 0, 0], up: [0, 1, 0] }), undefined);
  assert.equal(molstarPanelQuad({ anchor: [0, 0, -1], right: [1, 0, 0], up: [1, 0, 0] }), undefined);
  assert.equal(molstarPanelQuad({ anchor: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], widthMeters: 0 }), undefined);
});

test('a ray down the middle lands in the middle, and the corners land in the corners', () => {
  const centre = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0, -1] });
  assert.ok(centre);
  assert.ok(Math.abs(centre.u - 0.5) < 1e-9 && Math.abs(centre.v - 0.5) < 1e-9);
  assert.ok(Math.abs(centre.distance - 1) < 1e-9);
  // Texture rows count DOWN from the top, so a ray aimed high answers a small
  // `v`. Everything downstream — canvas pixels, clientY, Mol*'s eventOffset —
  // counts the same way.
  const high = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0.225, -1] });
  assert.ok(high.v < 0.01 && Math.abs(high.u - 0.5) < 1e-9);
  const left = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [-0.3, 0, -1] });
  assert.ok(left.u < 0.01);
});

test('a ray that misses the panel says so rather than clamping to the rim', () => {
  // Just outside the edge: a clamped answer here would keep Mol* highlighting
  // whatever sits under the corner while the wearer looks elsewhere.
  assert.equal(hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0.31, 0, -1] }), undefined);
  // Behind the wearer, parallel to the panel, and a ray with no direction.
  assert.equal(hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0, 1] }), undefined);
  assert.equal(hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [1, 0, 0] }), undefined);
  assert.equal(hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0, 0] }), undefined);
  assert.equal(hitMolstarPanel(undefined, { origin: [0, 0, 0], direction: [0, 0, -1] }), undefined);
  assert.equal(hitMolstarPanel(seated, undefined), undefined);
});

test('the hit becomes a tracked pointer in the panel canvas own pixels', () => {
  const canvas = { width: 512, height: 384 };
  const hit = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0, -1] });
  const first = molstarPanelTrackedPointer({ canvas, hit, handedness: 'right' });
  assert.deepEqual(first, { handedness: 'right', buttons: 0, x: 256, y: 192, dx: 0, dy: 0 });
  // A first update carries no delta at all. Mol*'s trackball reads dx/dy for a
  // drag, and an invented delta on the first frame flings the camera.
  const moved = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0.15, 0, -1] });
  const second = molstarPanelTrackedPointer({ canvas, hit: moved, buttons: 1, previous: first });
  assert.equal(second.buttons, 1);
  assert.ok(second.x > first.x && second.dx > 0);
  assert.equal(second.dy, 0);
  assert.equal(molstarPanelTrackedPointer({ canvas, hit: undefined }), undefined);
  assert.equal(molstarPanelTrackedPointer({ canvas: {}, hit }), undefined);
});

test('the fallback route lands a synthetic pointer exactly where Mol* reads it', () => {
  // Mol*'s eventOffset does `(ev.clientX || 0) - rect.left`, so these are the
  // client coordinates that read back as the intended canvas pixel.
  const rect = { left: 40, top: 24, width: 512, height: 384 };
  const hit = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0, -1] });
  const event = molstarPanelPointerEvent({ rect, hit });
  assert.equal(event.clientX - rect.left, 256);
  assert.equal(event.clientY - rect.top, 192);
  assert.equal(event.type, 'pointermove');
  assert.equal(event.bubbles, true, 'Mol* listens on the canvas, but a bubbling event is what a real one is');
  assert.equal(molstarPanelPointerEvent({ rect: { left: 0, top: 0 }, hit }), undefined);
});

test('one trigger pull is a move, a press and a release, in that order', () => {
  const rect = { left: 0, top: 0, width: 512, height: 384 };
  const hit = hitMolstarPanel(seated, { origin: [0, 0, 0], direction: [0, 0, -1] });
  const sequence = molstarPanelPickSequence({ rect, hit });
  assert.deepEqual(sequence.map(event => event.type), ['pointermove', 'pointerdown', 'pointerup']);
  assert.deepEqual(sequence.map(event => event.buttons), [0, 1, 0]);
  // Every event of the pull is at the same place, which is what makes Mol*
  // read it as a click rather than as a drag of the camera.
  assert.equal(new Set(sequence.map(event => `${event.clientX},${event.clientY}`)).size, 1);
  assert.deepEqual(molstarPanelPickSequence({ rect, hit: undefined }), []);
});

/**
 * The number the decision rests on: the readback is the half that
 * makes the Mol* `Image` route expensive, and it is counted here so nobody has
 * to take the conclusion on trust.
 */
test('the running cost of the panel is counted, both routes', () => {
  const resolution = molstarPanelResolution({ widthMeters: 0.6, heightMeters: 0.45, deviceClass: 'quest2' });
  const viaImage = molstarPanelTrafficPerSecond({ resolution, route: 'image' });
  const viaCanvas = molstarPanelTrafficPerSecond({ resolution, route: 'canvas' });
  // The Mol* representation route pays twice for every update: off the GPU as
  // a `TextureImage<Uint8Array>`, and back on again.
  assert.equal(viaImage.bytesPerUpload, resolution.bytes * 2);
  assert.equal(viaCanvas.bytesPerUpload, resolution.bytes);
  assert.ok(viaImage.bytesPerSecond > viaCanvas.bytesPerSecond);
  // At the shipped cap this is a real but payable fraction of one 72 Hz frame,
  // and a small fraction of the second. If either of these assertions starts
  // failing, the cap moved and the notes need re-reading before it ships.
  assert.ok(viaImage.frameShare < 0.25, `one upload eats ${(viaImage.frameShare * 100).toFixed(1)}% of a frame`);
  assert.ok(viaImage.dutyCycle < 0.05, `the panel costs ${(viaImage.dutyCycle * 100).toFixed(2)}% of every second`);
  // A headset with no bandwidth at all is an infinite cost rather than a
  // divide-by-zero that reads as free.
  assert.equal(molstarPanelTrafficPerSecond({ resolution, bytesPerSecond: 0 }).dutyCycle, Infinity);
});

/**
 * The chapter card's words are written on the card.
 *
 * The card has its own seat, centred above the molecule and facing the
 * wearer, while the menu column beside it is turned toward the wearer from
 * 29 degrees out. The card's glyphs were laid along the column's right axis,
 * so on the headset each line ran diagonally across and off its plate. This
 * holds every drawn glyph against the drawn plate meshes, not the layout.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const length = Math.hypot(...v); return v.map(x => x / length); };

/** The drawn faces (even groups; odd groups are bevels) as planar triangles. */
function faces(mesh) {
  return mesh.triangles.filter(triangle => triangle.group % 2 === 0).map(({ points: [a, b, c] }) => {
    const normal = cross(sub(b, a), sub(c, a));
    return Math.hypot(...normal) > 1e-12 ? { a, b, c, normal: unit(normal) } : undefined;
  }).filter(Boolean);
}
/** Whether `point`, dropped onto the face's plane, lands inside it, and how far off the plane it is. */
function onFace(face, point) {
  const offset = dot(sub(point, face.a), face.normal);
  const p = sub(point, face.normal.map(v => v * offset));
  const inside = [[face.a, face.b], [face.b, face.c], [face.c, face.a]]
    .map(([u, v]) => dot(cross(sub(v, u), sub(p, u)), face.normal));
  return { inside: inside.every(v => v >= -1e-9) || inside.every(v => v <= 1e-9), offset: Math.abs(offset) };
}

const tour = { active: true, autoplay: false, selectedId: 'atp-synthase', selectedTitle: 'ATP synthase', title: 'Wide reveal',
  progress: 'Scene 1 / 5', step: 0, total: 5, chapterStartedAt: 0, bodyPageIndex: 0, bodyPageCount: 1,
  bodyPage: 'Human mitochondrial ATP synthase, a rotary motor that makes most of the cell’s ATP.' };
const subject = { title: 'Human mitochondrial ATP synthase', pdbId: '8H9V', chains: 29 };

for (const collapsed of [false, true]) test(`every chapter card glyph lies flat on its drawn plate (${collapsed ? 'compact' : 'full'} menu)`, async () => {
  const representations = new Set();
  const f = toolbarFrameHarness(runtime, { state: { subject, tour, voice: { state: 'idle' } },
    presentation: { add: representation => representations.add(representation), remove: representation => representations.delete(representation) } });
  try {
    await f.toolbar.update();
    if (collapsed) { f.toolbar.runAction({ kind: 'collapse', value: true }); for (let i = 0; i < 200; i++) await Promise.resolve(); await f.toolbar.update(); }
    const shape = name => [...representations].find(rep => rep.shape?.name === name)?.shape;
    const glyphs = shape('Stereofold toolbar readout')?.geometry.glyphs ?? [];
    const plates = faces(shape('Stereofold toolbar plates').geometry);
    assert.ok(glyphs.length > 20, 'the card is drawn');
    for (const glyph of glyphs) {
      // Text is lifted off its glass by its own clearance (`roomPanel`), well
      // under two letter heights; anything further is not on that plate.
      const hits = plates.map(face => ({ face, ...onFace(face, glyph.position) })).filter(hit => hit.inside && hit.offset <= 1.5 * glyph.size);
      assert.ok(hits.length, `glyph '${glyph.text}' of line ${glyph.group} is over no drawn plate`);
      glyph.face = hits.sort((p, q) => p.offset - q.offset)[0].face;
    }
    // Each line runs along its own plate, not along the menu column's turned axis.
    const lines = Map.groupBy(glyphs, glyph => glyph.group);
    for (const [group, line] of lines) {
      if (line.length < 2) continue;
      const along = unit(sub(line.at(-1).position, line[0].position));
      const lean = Math.abs(dot(along, line[0].face.normal));
      assert.ok(lean < 0.02, `line ${group} '${line.map(g => g.text).join('')}' leaves its plate (${(Math.asin(lean) * 180 / Math.PI).toFixed(1)} degrees)`);
      for (const glyph of line) assert.ok(Math.abs(dot(sub(glyph.position, line[0].position), line[0].face.normal)) < 0.005,
        `line ${group} keeps one depth off its plate`);
    }
  } finally { await f.toolbar.dispose(); }
});

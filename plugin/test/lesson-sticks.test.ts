import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { lessonFigureSchema } from '../src/lesson-figure.js';
// @ts-ignore Browser renderer shared with the actual inspector.
import { createLessonFigure } from '../../lab/browser-roundtrip/lesson-figure.mjs';

describe('explicit figure sticks', () => {
  it('builds bond cylinders without atom spheres while preserving the ball-and-stick option', async () => {
    const previousDocument = globalThis.document;
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {},
      createElement() { return { setAttribute() {} }; }, head: { appendChild() {}, removeChild() {} } };
    const plugin = new PluginContext(DefaultPluginSpec());
    try {
      await plugin.init();
      const data = await plugin.builders.data.rawData({ data: readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8') });
      const trajectory = await plugin.build().to(data).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
      const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory, { modelIndex: 0 }).commit();
      const structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel, { type: { name: 'model', params: {} } }).commit();
      (plugin as any).canvas3d = { xr: { isPresenting: { value: false } }, update() {}, remove() {}, add() {}, mark() {}, syncVisibility() {} };
      const renderer = createLessonFigure({ plugin, getStructure: () => structure, getTransform: () => Mat4.identity() });
      const figure = lessonFigureSchema.parse({ layers: [{ id: 'examples', target: { chain: 'A', residueNumbers: [7,12,20,35] },
        representation: 'sticks', color: '#247fa2', sizeFactor: .14 }] });
      await renderer.install(figure);
      const sticks = renderer.molecular()[0];
      expect(sticks.props.visuals).toEqual(['intra-bond','inter-bond']);
      expect(sticks.props.adjustCylinderLength).toBe(false);
      expect(sticks.props.sizeFactor).toBe(.14);
      expect(sticks.props.sizeAspectRatio).toBe(1);
      expect(sticks.renderObjects.some((object: any) => object.values.drawCount.ref.value > 0)).toBe(true);
      expect(renderer.definition().layers[0].representation).toBe('sticks');
      const refs = renderer.molecular(); await renderer.refresh();
      expect(renderer.molecular()).toEqual(refs);
      await renderer.install(lessonFigureSchema.parse({ layers: [{ ...figure.layers[0], representation: 'ball-and-stick' }] }));
      expect(renderer.molecular()[0].props.visuals).toContain('element-sphere');
      expect(renderer.molecular()[0].props.sizeFactor).toBe(.14);
      await renderer.forget();
    } finally {
      (plugin as any).canvas3d = undefined; plugin.dispose();
      if (previousDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = previousDocument;
    }
  });
});

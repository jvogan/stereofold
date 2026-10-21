import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchPlateTextRenderable, patchPlateTextVertex } from '../src/molstar-plate-billboard-patch.js';

const read = (path: string) => readFileSync(new URL(`../node_modules/molstar/lib/${path}`, import.meta.url), 'utf8');
it('the pinned text shader compensates only opted-in perspective backing vertices', () => {
  const source = patchPlateTextVertex(read('mol-gl/shader/text.vert.js'));
  const shader = vm.runInNewContext(source.replace('export const text_vert', 'const text_vert') + '\ntext_vert;');
  expect(shader).toContain('uniform float uPlateBillboard;');
  expect(shader).toContain('uPlateBillboard > 0.5 && vTexCoord.x == 10.0 && !uHasEyeCamera && uIsOrtho == 0.0');
  expect(shader).toContain('cornerOffset *= mvCenter.z / glyphDepth');
  // Depth placement remains Mol*\'s, including the ordinary backing bias.
  expect(shader).toContain('offsetZ -= 0.001 * distance(uCameraPosition, (uProjection * mvCenter).xyz);');
  expect(() => patchPlateTextVertex(source)).toThrow();
});
it('the real renderable shares its opt-in uniform with the render object and defaults to desktop behavior', () => {
  const source = patchPlateTextRenderable(read('mol-gl/renderable/text.js')).replace(/^import .*;$/gm, '').replaceAll('export ', '');
  const spec = () => ({}), values: any = {};
  const make = vm.runInNewContext(source + '\nTextRenderable;', {
    BaseSchema: {}, SizeSchema: {}, GlobalUniformSchema: {}, GlobalTextureSchema: {}, GlobalDefineSchema: {}, InternalSchema: {},
    AttributeSpec: spec, UniformSpec: spec, ElementsSpec: spec, TextureSpec: spec, ValueSpec: spec,
    ValueCell: { create: (value: unknown) => ({ ref: { value } }) }, TextShaderCode: {},
    createGraphicsRenderItem: (_ctx: unknown, _mode: unknown, _code: unknown, schema: any, renderValues: any) => ({ schema, renderValues }),
    createRenderable: (item: any) => item,
  });
  const renderable = make({}, 1, values, {}, 1, {}, { dLightCount: 0, dColorMarker: false });
  expect(renderable.schema.uPlateBillboard).toBeDefined();
  expect(renderable.renderValues.uPlateBillboard).toBe(values.uPlateBillboard);
  expect(values.uPlateBillboard.ref.value).toBe(0);
  values.uPlateBillboard.ref.value = 1;
  expect(renderable.renderValues.uPlateBillboard.ref.value).toBe(1);
});

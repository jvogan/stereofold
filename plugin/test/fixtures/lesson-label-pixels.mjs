import { Renderer } from 'molstar/lib/mol-gl/renderer.js';
import { Scene } from 'molstar/lib/mol-gl/scene.js';
import { createContext } from 'molstar/lib/mol-gl/webgl/context.js';
import { createRenderObject } from 'molstar/lib/mol-gl/render-object.js';
import { DrawPass } from 'molstar/lib/mol-canvas3d/passes/draw.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { PostprocessingParams, PostprocessingPass, AntialiasingPass } from 'molstar/lib/mol-canvas3d/passes/postprocessing.js';
import { FxaaParams } from 'molstar/lib/mol-canvas3d/passes/fxaa.js';
import { MarkingParams } from 'molstar/lib/mol-canvas3d/passes/marking.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh.js';
import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder.js';
import { Box } from 'molstar/lib/mol-geo/primitive/box.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition.js';
import { AssetManager } from 'molstar/lib/mol-util/assets.js';

// Deliberately simple adversarial geometry: a solid slab fully covers a real
// Mol* glyph/background plate. No molecular downloads or physical device use.
globalThis.probeLessonLabels = async (mode = 'blended', postfx = false, edgeSize = 0) => {
  const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; document.body.append(canvas);
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw Error('WebGL2 required');
  const webgl = createContext(gl), scene = Scene.create(webgl, mode), renderer = Renderer.create(webgl, { backgroundColor: 0x101820 });
  const camera = new Camera(); camera.viewport.width = 400; camera.viewport.height = 300;
  camera.setState({ position: [0, 0, 60], target: [0, 0, 0], radius: 30, radiusMax: 100, fog: 0 }); camera.update();
  const props = { ...PD.getDefaultValues(Text.Params), background: true, backgroundColor: 0xffffff, backgroundOpacity: .9,
    sizeFactor: 5, offsetZ: 0, borderWidth: 0, fontQuality: 3 };
  if (edgeSize) Object.assign(props, { backgroundOpacity: 1, sizeFactor: edgeSize, offsetX: .25 });
  const builder = TextBuilder.create(props); builder.add('Buried site', 0, 0, 0, 0, 1, 0);
  const text = builder.getText(), textValues = Text.Utils.createValuesSimple(text, props, edgeSize ? 0 : 0x101820, 1);
  const plate = createRenderObject('text', textValues, Text.Utils.createRenderableState(props), -1);
  const meshState = MeshBuilder.createState(); meshState.currentGroup = 0;
  const transform = Mat4.fromScaling(Mat4(), [60, 40, 2]); transform[14] = 12;
  MeshBuilder.addPrimitive(meshState, transform, Box()); const mesh = MeshBuilder.getMesh(meshState);
  const meshProps = { ...PD.getDefaultValues(Mesh.Params), doubleSided: true, ignoreLight: true };
  const slab = createRenderObject('mesh', Mesh.Utils.createValuesSimple(mesh, meshProps, 0x904040, 1), Mesh.Utils.createRenderableState(meshProps), -1);
  scene.add(slab); scene.add(plate); scene.commit();
  const draw = new DrawPass(webgl, new AssetManager(), 400, 300, mode);
  // Mapped defaults share their nested objects; never mutate the parameter schema.
  const pp = structuredClone(PD.getDefaultValues(PostprocessingParams));
  for (const value of Object.values(pp)) if (value && typeof value === 'object' && 'name' in value) value.name = 'off';
  // Select matching FXAA parameters rather than retaining the SMAA defaults.
  if (postfx) { pp.antialiasing = { name: 'fxaa', params: PD.getDefaultValues(FxaaParams) }; pp.occlusion = structuredClone(PD.getDefaultValues(PostprocessingParams).occlusion); }
  const config = { transparentBackground: false, postprocessing: pp, marking: { ...PD.getDefaultValues(MarkingParams), enabled: false }, dpoitIterations: 2 };
  const helper = { debug: { isEnabled: false }, pointer: { isEnabled: false }, handle: { isEnabled: false }, camera: { isEnabled: false } };
  // Raw DrawPass use must finalize the programs that Canvas3D normally prepares.
  webgl.resources.linkPrograms();
  webgl.resources.finalizePrograms(undefined, true);
  let labelDraws = [], duplicate = false;
  const labelRenderable = scene.primitives.renderables.find(r => r.state === plate.state);
  const renderLabel = labelRenderable.render.bind(labelRenderable);
  labelRenderable.render = (variant, sharedTexturesCount) => { labelDraws.push(variant); renderLabel(variant, sharedTexturesCount); };
  // A deliberate duplicate is the sensitivity control for repeated blending.
  const lessonPass = renderer.renderLessonLabels;
  renderer.renderLessonLabels = (group, camera) => {
    lessonPass(group, camera);
    if (duplicate) lessonPass(group, camera);
  };
  const frame = (tagged, visibleSlab, visiblePlate = true, repeatLabels = false) => {
    labelDraws = []; duplicate = repeatLabels;
    plate.state.stereofoldLessonLabel = tagged; slab.state.visible = visibleSlab; plate.state.visible = visiblePlate; scene.syncVisibility();
    draw.render({ renderer, camera, scene, helper }, config, true);
    const pixels = new Uint8Array(400 * 300 * 4); webgl.readPixels(0, 0, 400, 300, pixels); return pixels;
  };
  const background = frame(false, true, false), buriedStock = frame(false, true), buriedFixed = frame(true, true);
  const frontStock = frame(false, false), stockLabelDraws = labelDraws.slice();
  const frontFixed = frame(true, false), fixedLabelDraws = labelDraws.slice();
  const frontDuplicate = frame(true, false, true, true);
  const differences = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4)
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i+1] - b[i+1]), Math.abs(a[i+2] - b[i+2])) > 3) count++; return count; };
  // Coverage is allowed to change glyph edges, not solid ink or plate interiors.
  // Postprocessing spreads an edge further than the one-pixel SDF transition.
  let outsideEdgeDifference = 0;
  const radius = postfx ? 4 : 2;
  for (let y = radius; y < 300 - radius; y++) for (let x = radius; x < 400 - radius; x++) {
    const i = 4 * (y * 400 + x);
    if (Math.max(...[0, 1, 2].map(c => Math.abs(frontStock[i+c] - frontFixed[i+c]))) <= 3) continue;
    let edge = false;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const j = 4 * ((y + dy) * 400 + x + dx);
      if ([0, 1, 2].some(c => Math.abs(frontStock[i+c] - frontStock[j+c]) > 20)) edge = true;
    }
    if (!edge) outsideEdgeDifference++;
  }
  const grayPixels = pixels => {
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] > 8 && pixels[i] < 247 && Math.abs(pixels[i] - pixels[i+1]) < 2 && Math.abs(pixels[i] - pixels[i+2]) < 2) count++;
    return count;
  };
  frame(true, true); // leave the repaired case visible for capture
  const result = { mode, actualMode: draw.transparency, postfx,
    postprocessingEnabled: PostprocessingPass.isEnabled(pp), antialiasingEnabled: AntialiasingPass.isEnabled(pp), stockBuriedPixels: differences(background, buriedStock),
    fixedBuriedPixels: differences(background, buriedFixed), exposedDifference: differences(frontStock, frontFixed),
    duplicateDifference: differences(frontFixed, frontDuplicate), outsideEdgeDifference,
    stockGrayPixels: grayPixels(frontStock), fixedGrayPixels: grayPixels(frontFixed),
    stockLabelDraws, fixedLabelDraws, error: gl.getError() };
  return result;
};

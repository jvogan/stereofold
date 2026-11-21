import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

// Explicit opt-in like the repository's other browser acceptance commands.
// STEREOFOLD_LAYER_PIXELS=1 runs real WebGL2 rasterization in Chromium;
// STEREOFOLD_LAYER_SCREENSHOTS=<dir> also writes the frames and the quad as PNGs:
// stock, layered composite, the layer alone, and the layer with the quad footprint.
const enabled = process.env.STEREOFOLD_LAYER_PIXELS === '1';
// Each pixel is blended once in the stock frame and twice on the layered path
// (into the layer, then over the molecule), each to 8 bits: a few levels of
// rounding is the whole allowance. No pixel may exceed it.
const ROUNDING_LEVELS = 3;
let browser: Browser, script: string;
beforeAll(async () => {
  if (!enabled) return;
  const result = await build({ entryPoints: [new URL('fixtures/presentation-layer-pixels.mjs', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'iife', write: false });
  script = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
afterAll(async () => { await browser?.close(); });

it.skipIf(!enabled).each([[false, false], [true, false], [true, true]])('draws the controls into their own layer exactly as the molecule pass did (transparent background %s, Quest sub-images %s)', async (transparentBackground, questSubImages) => {
  const page = await browser.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addScriptTag({ content: script });
    const images = Boolean(process.env.STEREOFOLD_LAYER_SCREENSHOTS);
    const result = await page.evaluate(async options => (globalThis as any).probePresentationLayer(options), { transparentBackground, images, questSubImages });
    const { pictures, records, ...facts } = result;
    console.log(JSON.stringify(facts));
    if (pictures) for (const [name, url] of Object.entries(pictures) as [string, string | null][]) {
      if (url) await writeFile(`${process.env.STEREOFOLD_LAYER_SCREENSHOTS}/${name}-${transparentBackground ? 'passthrough' : 'opaque'}${questSubImages ? '-quest' : ''}.png`,
        Buffer.from(url.split(',')[1]!, 'base64'));
    }
    expect(errors).toEqual([]);
    expect(result.error).toBe(0);
    expect(result.finalError).toBe(0);
    expect(result.facts.state).toBe('layered');
    expect(result.facts.frames).toBe(1);
    // Both eyes share the one texture, attached as a 2D texture, with no GL
    // error on the way, whatever image index each eye's sub-image reports.
    const first = records.find((r: any) => r.phase === 'first-frame');
    expect(first.targets).toBe(1);
    expect(first.framebuffer).toEqual({ layer: 'projection', status: 'FRAMEBUFFER_COMPLETE', colorAttachment: 'TEXTURE',
      attachError: 'NO_ERROR', drawError: 'NO_ERROR' });
    // The scene is not trivial: the controls cover a real share of both eyes
    // and changed what the stock frame showed over the molecule.
    expect(result.uiPixels).toBeGreaterThan(10_000);
    expect(result.controlsChanged).toBeGreaterThan(10_000);
    // Composited as a premultiplied layer, the layered frame is the stock one.
    expect(result.over).toBe(0);
    expect(result.maxDifference).toBeLessThanOrEqual(ROUNDING_LEVELS);
    // And the comparison can tell: blending the same layer as straight alpha fails.
    expect(result.wrongOver).toBeGreaterThan(1_000);
    // A still of the wearer's view, read from the molecule's layer, gets the
    // controls painted over it and is then the stock eye. Without them it is
    // the molecule alone, which is nothing like it.
    expect(result.still.painted).toBe(true);
    expect(result.still.bare).toBeGreaterThan(10_000);
    expect(result.still.off).toBe(0);
    expect(result.still.worst).toBeLessThanOrEqual(ROUNDING_LEVELS);
    // The controls went back to Canvas3D's pass when the layers were detached.
    expect(result.registered).toBe(true);
    // Mol*'s state cache survived the raw GL: a stock frame afterwards is
    // the first stock frame, bit for bit.
    expect(result.stockDrift).toBe(0);
    // The quad target divides the controls by object. The column is on its
    // quad and nowhere on the projection layer.
    expect(result.quad.state).toBe('layered');
    expect(result.quad.draws).toBe(1);
    expect(result.quad.insideBefore).toBeGreaterThan(1_000);
    expect(result.quad.columnOnProjection).toBe(0);
    // Every other control is on the projection layer exactly as it is drawn
    // with no column in the scene: whole, the part of the card that covers
    // the column included, and nothing away from the column changed.
    expect(result.quad.restDifference).toBeLessThanOrEqual(1);
    expect(result.quad.overlapInside).toBeGreaterThan(1_000);
    expect(result.quad.outsideChanged).toBe(0);
    // A still shows the column as well, where the quad puts it.
    expect(result.quadStill.painted).toBe(true);
    expect(result.quadStill.mean).toBeLessThan(2);
    expect(result.quadStill.off).toBeLessThan(600);
    // And none of them leaves a mark on the quad.
    expect(result.quad.quadForeign).toBe(0);
    // The card stands in front of the column, so its layer is composited above the quad.
    expect(result.quad.overlays).toEqual(['quad', 'projection']);
    expect(result.quad.quadGlass).toBeGreaterThan(result.quad.quadTotal * 0.5);
    expect(result.quad.quadInk).toBeGreaterThan(50);
  } finally { await page.close(); }
});

it.skipIf(!enabled)('draws the controller pointer over atoms and controls on the controls layer, as the stock pass does', async () => {
  const page = await browser.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addScriptTag({ content: script });
    const images = Boolean(process.env.STEREOFOLD_LAYER_SCREENSHOTS);
    const { pictures, ...result } = await page.evaluate(async options => (globalThis as any).probePointerLayer(options), { images });
    console.log(JSON.stringify(result));
    if (pictures) await writeFile(`${process.env.STEREOFOLD_LAYER_SCREENSHOTS}/pointer.png`, Buffer.from(pictures.pointer.split(',')[1]!, 'base64'));
    expect(errors).toEqual([]);
    expect(result.error).toBe(0);
    // The pointer covers real pixels in the stock frame.
    expect(result.pointerPixels).toBeGreaterThan(30);
    // Left in the molecule's pass, atoms hide the dots inside the ball and the
    // glass covers the ray in front of it: the fixture can tell.
    expect(result.before.state).toBe('layered');
    expect(result.before.over).toBeGreaterThan(15);
    // Drawn on the controls layer, the composite is the stock frame.
    expect(result.after.state).toBe('layered');
    expect(result.after.over).toBe(0);
    expect(result.after.worst).toBeLessThanOrEqual(ROUNDING_LEVELS);
    // And the pointer is back in the molecule's pass, as before, once the layers go.
    expect(result.stockDrift).toBe(0);
  } finally { await page.close(); }
});

// The headset's light rig (`XR_RENDERER_LIGHTING`): a strong key and little
// ambient, so a plate's shade follows how it is turned to the head.
const HEADSET_LIGHTS = { ambientColor: 0xc8d4e3, ambientIntensity: 0.18, light: [
  { inclination: 150, azimuth: 320, color: 0xfff6ea, intensity: 0.95 },
  { inclination: 142, azimuth: 145, color: 0xdce8ff, intensity: 0.10 },
  { inclination: 36, azimuth: 290, color: 0xffffff, intensity: 0.50 }] };

it.skipIf(!enabled)('shades a row on the menu quad as it is shaded in the eye, for a column turned from the way the head faces', async () => {
  const page = await browser.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addScriptTag({ content: script });
    const shade = async (turnDegrees: number) => page.evaluate(async options => (globalThis as any).probeQuadShade(options), { turnDegrees, lights: HEADSET_LIGHTS });
    const side = await shade(29), ahead = await shade(0);
    console.log(JSON.stringify({ side, ahead }));
    expect(errors).toEqual([]);
    for (const result of [side, ahead]) {
      expect(result.error).toBe(0);
      // The lights are put back after each quad draw.
      expect(result.lightAfter).toEqual(HEADSET_LIGHTS.light.map(one => [one.inclination, one.azimuth]));
      expect(result.stockDrift).toBe(0);
    }
    // The fixture can tell: turned 29 degrees from the head, the row is
    // clearly darker in the eye than the same row faced head on.
    expect(ahead.inEye[1] - side.inEye[1]).toBeGreaterThan(15);
    // On its quad the row has the shade it has in the eye, at either turn.
    for (const result of [side, ahead]) {
      for (let c = 0; c < 3; c++) expect(Math.abs(result.onQuad[c] - result.inEye[c])).toBeLessThanOrEqual(4);
    }
  } finally { await page.close(); }
});

it.skipIf(!enabled)('anti-aliases plate edges on the controls layer when the context can multisample into the layer texture', async () => {
  const page = await browser.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addScriptTag({ content: script });
    const edges = async (multisample: boolean) => page.evaluate(async options => (globalThis as any).probeQuadShade(options),
      { turnDegrees: 29, lights: HEADSET_LIGHTS, target: 'projection', multisample });
    const plain = await edges(false), smooth = await edges(true);
    for (const [name, result] of [['aliased', plain], ['antialiased', smooth]] as const) {
      if (process.env.STEREOFOLD_LAYER_SCREENSHOTS && result.picture) await writeFile(`${process.env.STEREOFOLD_LAYER_SCREENSHOTS}/edge-${name}.png`,
        Buffer.from(result.picture.split(',')[1]!, 'base64'));
      delete result.picture;
    }
    console.log(JSON.stringify({ plain, smooth }));
    expect(errors).toEqual([]);
    for (const result of [plain, smooth]) { expect(result.error).toBe(0); expect(result.stockDrift).toBe(0); }
    // As drawn until now: every edge pixel is all plate or none of it.
    expect(plain.antialias).toEqual([]);
    expect(plain.edges.lit).toBeGreaterThan(5_000);
    expect(plain.edges.partial).toBe(0);
    // Through the extension the layer is drawn with four samples a pixel and
    // resolved into its own texture, once per frame.
    expect(smooth.antialias).toEqual([4]);
    expect(smooth.multisampling).toEqual({ attaches: 2, resolves: 2 });
    // The slanted edges of the turned plates are now covered in part, with
    // premultiplied colour that never exceeds its coverage (no bright fringe).
    expect(smooth.edges.partial).toBeGreaterThan(100);
    expect(smooth.edges.brighterThanCovered).toBe(0);
    // Nothing else moved: the plates cover the same area give or take their
    // outline, and a plate's face is the colour it was.
    expect(Math.abs(smooth.edges.lit - plain.edges.lit)).toBeLessThan(smooth.edges.partial);
    expect(smooth.onLayer).toEqual(plain.onLayer);
    expect(smooth.onLayer).toEqual(smooth.inEye);
  } finally { await page.close(); }
});

/**
 * Measure where each eye's image actually sits inside its own eye window.
 *
 * The contract this probe exists to check: at the automatic fit, the visible
 * structure is centred on the camera target, the target is the stereo focus
 * plane, and a point at focus has zero disparity. So the lit pixels of each eye
 * must be centred in that eye's viewport, and the two eyes' centroids must be
 * exactly one eye-window apart. A pair whose corresponding points are further
 * apart than the interocular distance cannot be free-fused at all, which is why
 * this is measured rather than eyeballed.
 *
 * Run: `tsx scripts/stereo-centring-probe.ts [--depth 40] [--stage 720x437]
 *       [--dpr 2] [--structure path.pdb] [--out dir] [--json]`
 *
 * It drives the shipped `dist/viewer.html` through the test-only acceptance
 * hook, then turns acceptance mode off so the shipped automatic fit, letterbox
 * cap and refit path are the ones under test.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { chromium, type Page } from 'playwright';

type Rgba = { width: number; height: number; data: Uint8Array };
type Centroid = { x: number; y: number; count: number; minX: number; maxX: number; minY: number; maxY: number };

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function decodePng(source: Buffer): Rgba {
  let cursor = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (cursor < source.length) {
    const length = source.readUInt32BE(cursor);
    const type = source.subarray(cursor + 4, cursor + 8).toString('ascii');
    const content = source.subarray(cursor + 8, cursor + 8 + length);
    cursor += 12 + length;
    if (type === 'IHDR') {
      width = content.readUInt32BE(0);
      height = content.readUInt32BE(4);
      colorType = content[9] ?? -1;
    } else if (type === 'IDAT') idat.push(content);
    else if (type === 'IEND') break;
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const decoded = new Uint8Array(width * height * 4);
  let input = 0;
  let previous = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const byte = raw[input++] ?? 0;
      const left = x >= channels ? row[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      if (filter === 0) row[x] = byte;
      else if (filter === 1) row[x] = (byte + left) & 255;
      else if (filter === 2) row[x] = (byte + up) & 255;
      else if (filter === 3) row[x] = (byte + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = (byte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else throw new Error(`unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      decoded[to] = row[from]!;
      decoded[to + 1] = row[from + 1]!;
      decoded[to + 2] = row[from + 2]!;
      decoded[to + 3] = channels === 4 ? row[from + 3]! : 255;
    }
    previous = row;
  }
  return { width, height, data: decoded };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(image: Rgba): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(image.height * (image.width * 4 + 1));
  for (let y = 0; y < image.height; y++) {
    raw[y * (image.width * 4 + 1)] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + y * image.width * 4, image.width * 4)
      .copy(raw, y * (image.width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Lit scene pixel.
 *
 * Mol*'s camera-axes gizmo is drawn at a fixed place in every eye viewport with
 * zero disparity, so counting it would pull both centroids toward the same
 * offset and hide the very displacement being measured. Its three bars are the
 * only fully saturated primaries on the stage, so they are excluded by channel
 * spread rather than by cropping a guessed rectangle.
 */
function isLit(image: Rgba, x: number, y: number): boolean {
  const i = (y * image.width + x) * 4;
  const r = image.data[i]!;
  const g = image.data[i + 1]!;
  const b = image.data[i + 2]!;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma <= 28) return false;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread <= 110;
}

function centroid(image: Rgba, fromX: number, toX: number): Centroid {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let x = fromX; x < toX; x++) {
    for (let y = 0; y < image.height; y++) {
      if (!isLit(image, x, y)) continue;
      sumX += x;
      sumY += y;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x: sumX / count, y: sumY / count, count, minX, maxX, minY, maxY };
}

function arg(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback;
}

async function settle(page: Page, frames = 6): Promise<void> {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }, frames);
  await page.waitForTimeout(220);
}

export type ProbeReading = {
  depthBudgetArcmin: number;
  yawDeg: number;
  stage: { width: number; height: number };
  canvasCssPx: { width: number; height: number };
  eyeWindowCssPx: number;
  /** Signed CSS-px offset of each eye's lit centroid from its window centre. */
  leftOffsetCssPx: number;
  rightOffsetCssPx: number;
  verticalDisparityCssPx: number;
  /** Distance between corresponding points, in CSS px and in millimetres. */
  pairSeparationCssPx: number;
  pairSeparationMm: number;
  clipped: boolean;
  pose: {
    position: [number, number, number];
    target: [number, number, number];
    worldXInCameraFrame: [number, number, number];
    stereo: { eyeSeparation: number; focus: number } | undefined;
  };
  params: { eyeSeparation: number; focus: number; frontDisparityPx: number; rearDisparityPx: number } | undefined;
};

export async function probe(options: {
  structureText: string;
  depthBudgetArcmin: number;
  stageWidthCssPx: number;
  stageHeightCssPx: number;
  deviceScaleFactor: number;
  cssPxPerInch: number;
  /** Orbit the fitted camera about the world y axis, as a mouse drag does. */
  yawDeg?: number;
  outPng?: string;
}): Promise<ProbeReading> {
  const viewerUrl = pathToFileURL(resolve(pluginRoot, 'dist/viewer.html')).href;
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    // The acceptance hook hides the toolbar, so the page viewport that yields
    // the requested stage box has to be found rather than computed.
    let viewportWidth = options.stageWidthCssPx;
    let viewportHeight = options.stageHeightCssPx + 24;
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: options.deviceScaleFactor,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => { globalThis.__stereoStructureAcceptanceMode = true; });
    await page.goto(viewerUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__stereoStructureAcceptance?.state().webgl2 === true, undefined, { timeout: 30_000 });
    // From here the shipped fit, cap and refit paths are live.
    await page.evaluate(() => { globalThis.__stereoStructureAcceptanceMode = false; });
    await page.evaluate((text) => window.__stereoStructureAcceptance!.loadShipped(text), options.structureText);
    await page.evaluate((density) => {
      window.__stereoStructureAcceptance!.setDensity(density.cssPxPerInch, density.dpr);
    }, { cssPxPerInch: options.cssPxPerInch, dpr: options.deviceScaleFactor });
    await page.evaluate((depth) => window.__stereoStructureAcceptance!.setMode('parallel', depth, false), options.depthBudgetArcmin);
    await settle(page);

    for (let attempt = 0; attempt < 6; attempt++) {
      const box = await page.evaluate(() => window.__stereoStructureAcceptance!.state().pose);
      const dw = options.stageWidthCssPx - box.letterboxWidth;
      const dh = options.stageHeightCssPx - box.stageHeight;
      if (Math.abs(dw) < 1 && Math.abs(dh) < 1) break;
      viewportWidth += Math.round(dw);
      viewportHeight += Math.round(dh);
      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
      await settle(page, 4);
    }
    if ((options.yawDeg ?? 0) !== 0) {
      // A mouse orbit keeps the fit distance and changes the view direction.
      // That is the one input that decides whether a world-frame eye baseline
      // lands on the camera's own x axis, so it is what this probe varies.
      await page.evaluate(async (yawDeg) => {
        const hook = window.__stereoStructureAcceptance!;
        const pose = hook.state().pose;
        const angle = yawDeg * Math.PI / 180;
        const dx = pose.position[0] - pose.target[0];
        const dz = pose.position[2] - pose.target[2];
        await hook.setCamera([
          pose.target[0] + dx * Math.cos(angle) - dz * Math.sin(angle),
          pose.position[1],
          pose.target[2] + dx * Math.sin(angle) + dz * Math.cos(angle),
        ], pose.target);
      }, options.yawDeg ?? 0);
      await settle(page, 6);
    }
    await settle(page, 10);
    if (errors.length > 0) throw new Error(`viewer page error: ${errors.join('\n')}`);

    const state = await page.evaluate(() => window.__stereoStructureAcceptance!.state());
    const canvas = page.locator('#molstar-stage canvas').first();
    await canvas.waitFor({ state: 'visible' });
    const image = decodePng(await canvas.screenshot({ animations: 'disabled' }));
    if (options.outPng !== undefined) await writeFile(options.outPng, encodePng(image));

    const half = Math.floor(image.width / 2);
    const left = centroid(image, 0, half);
    const right = centroid(image, half, image.width);
    const dpr = options.deviceScaleFactor;
    const eyeWindow = half / dpr;
    const leftOffset = (left.x - half / 2) / dpr;
    const rightOffset = (right.x - half - half / 2) / dpr;
    const pairSeparation = (right.x - left.x) / dpr;
    return {
      depthBudgetArcmin: options.depthBudgetArcmin,
      yawDeg: options.yawDeg ?? 0,
      stage: { width: state.pose.stageWidth, height: state.pose.stageHeight },
      canvasCssPx: { width: image.width / dpr, height: image.height / dpr },
      eyeWindowCssPx: eyeWindow,
      leftOffsetCssPx: leftOffset,
      rightOffsetCssPx: rightOffset,
      verticalDisparityCssPx: (left.y - right.y) / dpr,
      pairSeparationCssPx: pairSeparation,
      pairSeparationMm: pairSeparation * 25.4 / options.cssPxPerInch,
      clipped: left.minX <= 0 || right.maxX >= image.width - 1
        || left.minY <= 0 || left.maxY >= image.height - 1
        || right.minY <= 0 || right.maxY >= image.height - 1,
      pose: {
        position: state.pose.position,
        target: state.pose.target,
        worldXInCameraFrame: state.pose.worldXInCameraFrame,
        stereo: state.pose.stereo,
      },
      params: state.params == null ? undefined : {
        eyeSeparation: state.params.eyeSeparation,
        focus: state.params.focus,
        frontDisparityPx: state.params.frontDisparityPx,
        rearDisparityPx: state.params.rearDisparityPx,
      },
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const structurePath = arg('structure', resolve(pluginRoot, 'test/fixtures/three-depth-markers.pdb'));
  const structureText = await readFile(structurePath, 'utf8');
  const [stageWidth, stageHeight] = arg('stage', '720x437').split('x').map(Number) as [number, number];
  const deviceScaleFactor = Number(arg('dpr', '2'));
  const cssPxPerInch = Number(arg('ppi', '96'));
  const depths = arg('depth', '40').split(',').map(Number);
  const yaws = arg('yaw', '0').split(',').map(Number);
  const outDir = arg('out', '');
  if (outDir !== '') await mkdir(outDir, { recursive: true });

  const readings: ProbeReading[] = [];
  for (const yawDeg of yaws) {
    for (const depthBudgetArcmin of depths) {
      readings.push(await probe({
        structureText,
        depthBudgetArcmin,
        stageWidthCssPx: stageWidth,
        stageHeightCssPx: stageHeight,
        deviceScaleFactor,
        cssPxPerInch,
        yawDeg,
        ...(outDir === '' ? {} : { outPng: resolve(outDir, `centring-yaw-${yawDeg}-depth-${depthBudgetArcmin}.png`) }),
      }));
    }
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(readings, null, 2));
    return;
  }
  const first = readings[0]!;
  console.log(`structure ${structurePath}`);
  console.log(`stage ${first.stage.width.toFixed(0)} x ${first.stage.height.toFixed(0)} CSS px, dpr ${deviceScaleFactor}, ${cssPxPerInch} CSS px/in`);
  console.log(`canvas ${first.canvasCssPx.width} x ${first.canvasCssPx.height} CSS px, eye window ${first.eyeWindowCssPx} CSS px`);
  const u = first.pose.worldXInCameraFrame;
  console.log(`camera position ${first.pose.position.map((v) => v.toFixed(2)).join(', ')} target ${first.pose.target.map((v) => v.toFixed(2)).join(', ')}`);
  console.log(`world x in camera frame (${u.map((v) => v.toFixed(4)).join(', ')})  -> 1 - u.x = ${(1 - u[0]).toFixed(4)}`);
  console.log('');
  console.log('  yaw  depth  left off  right off  vertical  pair sep   pair mm  B (A)   F (A)   clipped');
  for (const r of readings) {
    console.log(
      `${String(r.yawDeg).padStart(5)}`
      + `  ${String(r.depthBudgetArcmin).padStart(5)}`
      + `  ${r.leftOffsetCssPx.toFixed(2).padStart(8)}`
      + `  ${r.rightOffsetCssPx.toFixed(2).padStart(9)}`
      + `  ${r.verticalDisparityCssPx.toFixed(2).padStart(8)}`
      + `  ${r.pairSeparationCssPx.toFixed(2).padStart(8)}`
      + `  ${r.pairSeparationMm.toFixed(2).padStart(8)}`
      + `  ${(r.params?.eyeSeparation ?? 0).toFixed(3).padStart(6)}`
      + `  ${(r.params?.focus ?? 0).toFixed(2).padStart(6)}`
      + `  ${r.clipped ? 'yes' : 'no'}`,
    );
  }
  console.log('');
  console.log(`the pair is fusable only if pair sep is the eye window (${first.eyeWindowCssPx} CSS px, `
    + `${(first.eyeWindowCssPx * 25.4 / cssPxPerInch).toFixed(1)} mm) to within a few px`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

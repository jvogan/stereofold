import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  disparityPx,
  projectPointThroughEye,
  type CameraSnapshot,
  type StereoParams,
} from '@stereo/geometry';
import { eyeChannelLuma as anaglyphEyeChannelLuma, filterChannelLuma, srgbToLinear } from '@stereo/anaglyph';

type Pixel = readonly [number, number, number, number];
type Rgba = { width: number; height: number; data: Uint8Array };
type Marker = 'front' | 'centre' | 'rear';
type Centroid = { x: number; y: number; count: number };

/**
 * Fixture geometry, mirroring `test/fixtures/three-depth-markers.pdb`. The
 * scripted camera sits on +z looking at the origin, so a marker's camera-frame
 * depth is `CAMERA_Z - worldZ`.
 */
const CAMERA_Z = 65;
const MARKERS: Record<Marker, { worldY: number; worldZ: number }> = {
  front: { worldY: 4, worldZ: 20 },
  centre: { worldY: 0, worldZ: 0 },
  rear: { worldY: -4, worldZ: -20 },
};
const MARKER_ORDER = ['front', 'centre', 'rear'] as const;

function markerDepth(marker: Marker): number {
  return CAMERA_Z - MARKERS[marker].worldZ;
}

type AcceptanceState = {
  mode: 'off' | 'parallel' | 'cross' | 'anaglyph';
  params?: StereoParams;
  camera: CameraSnapshot;
  stageWidth: number;
  webgl2: boolean;
};

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

/** Minimal RGBA8 PNG decoder for Playwright selector screenshots. */
function decodePng(source: Buffer): Rgba {
  assert.equal(source.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  let cursor = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (cursor < source.length) {
    const length = u32(source, cursor);
    const type = source.subarray(cursor + 4, cursor + 8).toString('ascii');
    const content = source.subarray(cursor + 8, cursor + 8 + length);
    cursor += 12 + length;
    if (type === 'IHDR') {
      width = u32(content, 0);
      height = u32(content, 4);
      assert.equal(content[8], 8, 'PNG must use 8-bit channels');
      colorType = content[9];
      assert.ok(colorType === 6 || colorType === 2, `unsupported PNG color type ${colorType}`);
    } else if (type === 'IDAT') idat.push(content);
    else if (type === 'IEND') break;
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (rowBytes + 1), 'unexpected PNG scanline length');
  const decoded = new Uint8Array(width * height * 4);
  let input = 0;
  let previous = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const sourceByte = raw[input++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 0) row[x] = sourceByte;
      else if (filter === 1) row[x] = (sourceByte + left) & 255;
      else if (filter === 2) row[x] = (sourceByte + up) & 255;
      else if (filter === 3) row[x] = (sourceByte + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = (sourceByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else throw new Error(`unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      decoded[to] = row[from];
      decoded[to + 1] = row[from + 1];
      decoded[to + 2] = row[from + 2];
      decoded[to + 3] = channels === 4 ? row[from + 3] : 255;
    }
    previous = row;
  }
  return { width, height, data: decoded };
}

/** Widest PNG this script writes into the report directory. */
const MAX_SAVED_WIDTH = 800;

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
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(image: Rgba): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.data.subarray(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Integer box average. Used only for the saved copies, never for measurement. */
function downscale(image: Rgba, factor: number): Rgba {
  if (factor <= 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * image.width + x * factor + dx) * 4;
          for (let c = 0; c < 4; c++) sums[c] += image.data[i + c];
        }
      }
      const to = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[to + c] = Math.round(sums[c] / (factor * factor));
    }
  }
  return { width, height, data };
}

async function savePng(path: string, image: Rgba): Promise<void> {
  await writeFile(path, encodePng(downscale(image, Math.ceil(image.width / MAX_SAVED_WIDTH))));
}

function pixel(image: Rgba, x: number, y: number): Pixel {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

function isMarker(marker: Marker, [r, g, b, a]: Pixel): boolean {
  if (a < 200) return false;
  if (marker === 'front') return g > 55 && g > r * 1.23 && g > b * 1.45;
  if (marker === 'centre') return r > 70 && r > g * 1.55 && r > b * 1.55;
  return b > 70 && b > r * 1.45 && b > g * 1.2;
}

function centroid(image: Rgba, marker: Marker, minX: number, maxX: number): Centroid {
  let xSum = 0;
  let ySum = 0;
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = minX; x < maxX; x++) {
      if (!isMarker(marker, pixel(image, x, y))) continue;
      // Sample at pixel centres so the centroid is in the same continuous
      // coordinates the geometry package projects into.
      xSum += x + 0.5;
      ySum += y + 0.5;
      count++;
    }
  }
  return count === 0 ? { x: Number.NaN, y: Number.NaN, count } : { x: xSum / count, y: ySum / count, count };
}

type MarkerMeasurement = { left: Centroid; right: Centroid; disparity: number; vertical: number };
type StereoMeasurement = Record<Marker, MarkerMeasurement>;

/**
 * Centroid both halves of a side-by-side pair in *half-local* coordinates.
 *
 * `centroid` scans absolute image columns, so the right half's centroid is
 * offset by the half width. Subtracting it before differencing is what makes
 * `disparity` the eye-to-eye disparity rather than the disparity plus the
 * constant half offset.
 */
function measureStereo(image: Rgba): StereoMeasurement {
  assert.equal(image.width % 2, 0, 'side-by-side canvas must have even width');
  const half = image.width / 2;
  return Object.fromEntries(MARKER_ORDER.map((marker) => {
    const left = centroid(image, marker, 0, half);
    const rightAbsolute = centroid(image, marker, half, image.width);
    const right = { x: rightAbsolute.x - half, y: rightAbsolute.y, count: rightAbsolute.count };
    return [marker, { left, right, disparity: left.x - right.x, vertical: left.y - right.y }];
  })) as StereoMeasurement;
}

function printMeasurements(
  label: string,
  measured: StereoMeasurement,
  predicted: Record<Marker, number>,
): void {
  for (const marker of MARKER_ORDER) {
    const item = measured[marker];
    console.log(`${label} ${marker}: left=(${item.left.x.toFixed(2)},${item.left.y.toFixed(2)}) n=${item.left.count}; right=(${item.right.x.toFixed(2)},${item.right.y.toFixed(2)}) n=${item.right.count}; disparity=${item.disparity.toFixed(2)} px; vertical=${item.vertical.toFixed(2)} px; prediction=${predicted[marker].toFixed(2)} px`);
  }
}

function assertMarkersPresent(measured: StereoMeasurement): void {
  for (const marker of MARKER_ORDER) {
    assert.ok(measured[marker].left.count > 16, `${marker} marker not found in left viewport`);
    assert.ok(measured[marker].right.count > 16, `${marker} marker not found in right viewport`);
  }
}

function maxHalfDelta(image: Rgba): { max: number; at: string; differing: number } {
  assert.equal(image.width % 2, 0, 'side-by-side canvas must have even width');
  const half = image.width / 2;
  let max = 0;
  let at = 'none';
  let differing = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < half; x++) {
      const a = pixel(image, x, y);
      const b = pixel(image, x + half, y);
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a[c] - b[c]));
      if (delta > 0) differing++;
      if (delta > max) {
        max = delta;
        at = `half-local (${x},${y}) left=[${a.join(',')}] right=[${b.join(',')}]`;
      }
    }
  }
  return { max, at, differing };
}

function maxSwappedHalfDelta(parallel: Rgba, cross: Rgba): { max: number; at: string; differing: number } {
  assert.equal(parallel.width, cross.width);
  assert.equal(parallel.height, cross.height);
  const half = parallel.width / 2;
  let max = 0;
  let at = 'none';
  let differing = 0;
  for (let y = 0; y < parallel.height; y++) {
    for (let x = 0; x < half; x++) {
      const parallelLeft = pixel(parallel, x, y);
      const parallelRight = pixel(parallel, x + half, y);
      const crossLeft = pixel(cross, x, y);
      const crossRight = pixel(cross, x + half, y);
      let delta = 0;
      for (let c = 0; c < 4; c++) {
        delta = Math.max(delta, Math.abs(parallelRight[c] - crossLeft[c]), Math.abs(parallelLeft[c] - crossRight[c]));
      }
      if (delta > 0) differing++;
      if (delta > max) {
        max = delta;
        at = `half-local (${x},${y}) parallel L=[${parallelLeft.join(',')}] R=[${parallelRight.join(',')}]; cross L=[${crossLeft.join(',')}] R=[${crossRight.join(',')}]`;
      }
    }
  }
  return { max, at, differing };
}

function maxPixelDelta(a: Rgba, b: Rgba): number {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let max = 0;
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]));
  return max;
}

/**
 * Per-eye centroids inside a full-frame anaglyph composite.
 *
 * The Dubois compositor drives the red channel from the left eye and the
 * green/blue channels from the right eye, so a pixel covered by one eye only
 * carries that eye's channels and a pixel covered by both carries all three.
 * Testing channel *presence* rather than dominance therefore recovers each
 * eye's whole silhouette, including the overlap. Each marker is measured
 * inside a band around its own mono row so the three markers, and the single
 * blended row at the canvas edge, cannot contaminate one another.
 */
/**
 * Coverage floor for one eye's channels, read from the composite instead of
 * fixed.
 *
 * A red/cyan composite leaves a *red* marker with almost no cyan content, so
 * the right eye's channels for the centre marker sit far below the green and
 * blue markers'. Measured on this fixture: centre 16, rear 58, front 117, on
 * an anaglyph ground of 1. A constant floor tuned to the two bright markers
 * therefore loses the red one. Anti-aliasing is off in the acceptance render,
 * so every pixel in a marker band is either ground or marker with nothing in
 * between, and the floor only has to clear the ground.
 */
function anaglyphChannelFloor(image: Rgba): number {
  const ground = pixel(image, 1, 1);
  const groundMax = Math.max(ground[0], ground[1], ground[2]);
  assert.ok(groundMax < 32, `anaglyph ground at (1,1) is not dark: [${ground.join(',')}]`);
  return groundMax + 6;
}

function measureAnaglyph(image: Rgba, monoY: Record<Marker, number>): StereoMeasurement {
  const channelFloor = anaglyphChannelFloor(image);
  const bandHalfHeight = 10;
  return Object.fromEntries(MARKER_ORDER.map((marker) => {
    const minY = Math.max(0, Math.round(monoY[marker]) - bandHalfHeight);
    const maxY = Math.min(image.height, Math.round(monoY[marker]) + bandHalfHeight);
    const accumulate = (covered: (p: Pixel) => boolean): Centroid => {
      let xSum = 0;
      let ySum = 0;
      let count = 0;
      for (let y = minY; y < maxY; y++) {
        for (let x = 0; x < image.width; x++) {
          if (!covered(pixel(image, x, y))) continue;
          xSum += x + 0.5;
          ySum += y + 0.5;
          count++;
        }
      }
      return count === 0 ? { x: Number.NaN, y: Number.NaN, count } : { x: xSum / count, y: ySum / count, count };
    };
    const left = accumulate(([r]) => r >= channelFloor);
    const right = accumulate(([, g, b]) => Math.max(g, b) >= channelFloor);
    return [marker, { left, right, disparity: left.x - right.x, vertical: left.y - right.y }];
  })) as StereoMeasurement;
}

/**
 * Marker x offsets for the mirror and gradient fixture, in Angstrom.
 *
 * The shipped fixture puts all three markers on world x = 0 so every measured
 * horizontal disparity comes from the baseline alone. That also makes an
 * x-mirror a no-op on it and leaves all three markers at one screen midpoint,
 * which is a zero denominator for the disparity gradient. This variant spreads
 * them, and nothing else about it changes.
 */
const OFF_AXIS_MARKER_X: Record<Marker, number> = { front: -4, centre: 0, rear: 4 };

/** Rewrite columns 31-38 (x) of each HETATM record, in fixture order. */
function withMarkerX(fixtureText: string, sign: 1 | -1): string {
  let index = 0;
  return fixtureText.split('\n').map((line) => {
    if (!line.startsWith('HETATM')) return line;
    const marker = MARKER_ORDER[index++];
    if (marker === undefined) throw new Error('fixture has more HETATM records than markers');
    const value = (sign * OFF_AXIS_MARKER_X[marker]).toFixed(3).padStart(8, ' ');
    return line.slice(0, 30) + value + line.slice(38);
  }).join('\n');
}

/**
 * The mirror comparison: flip each half horizontally, then exchange the halves.
 *
 * Mirroring the world in x maps the left eye's view of the scene onto the
 * horizontally mirrored right eye's view of the mirrored scene, because the
 * patched StereoCamera is antisymmetric in x: `left.view[12] = -right.view[12]`
 * and `left.projection[8] - camera.projection[8] = -(right.projection[8] -
 * camera.projection[8])` (`plugin/src/molstar-stereo-patch.ts`). Applying this
 * transform to a render of the mirrored scene must therefore reproduce the
 * render of the original scene. This is the browser-rendered form of the
 * `packages/geometry` raster mirror test at
 * `packages/geometry/test/geometry.test.ts:118-158,207-231`.
 *
 * The mirror is in x, not in z. A z-mirror about the focus plane does not
 * negate disparity under a perspective camera: this fixture measures +10.43 px
 * at 45 A and -5.62 px at 85 A, which are 20 A either side of the 65 A focus
 * and are not equal and opposite.
 */
function mirrorHalvesAndSwap(image: Rgba): Rgba {
  assert.equal(image.width % 2, 0, 'side-by-side canvas must have even width');
  const half = image.width / 2;
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < half; x++) {
      const fromRight = (y * image.width + half + (half - 1 - x)) * 4;
      const fromLeft = (y * image.width + (half - 1 - x)) * 4;
      data.set(image.data.subarray(fromRight, fromRight + 4), (y * image.width + x) * 4);
      data.set(image.data.subarray(fromLeft, fromLeft + 4), (y * image.width + half + x) * 4);
    }
  }
  return { width: image.width, height: image.height, data };
}

function differingPixels(a: Rgba, b: Rgba): { max: number; differing: number; at: string } {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let max = 0;
  let differing = 0;
  let at = 'none';
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const p = pixel(a, x, y);
      const q = pixel(b, x, y);
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(p[c] - q[c]));
      if (delta > 0) differing++;
      if (delta > max) {
        max = delta;
        at = `(${x},${y}) a=[${p.join(',')}] b=[${q.join(',')}]`;
      }
    }
  }
  return { max, differing, at };
}

/**
 * Screen-space disparity gradient, measured on rendered centroids.
 *
 * The perceptual constraint is that disparity must not change faster than the
 * screen separation of the points it is measured between, which is the
 * rendered form of the check at `packages/geometry/test/geometry.test.ts:
 * 232-255`. Markers are sorted by screen midpoint so consecutive pairs are
 * genuinely adjacent on screen.
 */
function screenGradient(measured: StereoMeasurement): { max: number; at: string; minSeparation: number } {
  const points = MARKER_ORDER.map((marker) => ({
    marker,
    midpoint: (measured[marker].left.x + measured[marker].right.x) / 2,
    disparity: measured[marker].disparity,
  })).sort((a, b) => a.midpoint - b.midpoint);
  let max = 0;
  let at = 'none';
  let minSeparation = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const separation = Math.abs(points[i].midpoint - points[i - 1].midpoint);
    minSeparation = Math.min(minSeparation, separation);
    const gradient = Math.abs(points[i].disparity - points[i - 1].disparity) / separation;
    if (gradient > max) {
      max = gradient;
      at = `${points[i - 1].marker}->${points[i].marker}`;
    }
  }
  return { max, at, minSeparation };
}

/**
 * Pixels whose green and blue channels differ.
 *
 * A balanced red-cyan composite writes `k * Y` into both the green and the
 * blue channel from the same matrix rows, so every composited pixel has G = B
 * exactly, and any screen-space pass that blends neighbouring pixels with
 * equal channel weights preserves that. A Mol* frame that never went through
 * the compositor does not have it: the mono ground alone is (7, 16, 21). This
 * is therefore a signature of the balanced composite having reached the
 * drawing buffer, and it does not depend on two captures being pixel-identical.
 */
function greenBlueMismatch(image: Rgba): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 1] !== image.data[i + 2]) count++;
  }
  return count;
}

function anaglyphResidualPercent(image: Rgba): number {
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < image.data.length; i += 4) {
    const linear = srgbToLinear([image.data[i] / 255, image.data[i + 1] / 255, image.data[i + 2] / 255]);
    r += linear[0];
    g += linear[1];
    b += linear[2];
  }
  return anaglyphEyeChannelLuma([r / pixels, g / pixels, b / pixels]).residualPercent;
}

async function settle(page: import('playwright').Page): Promise<void> {
  await page.evaluate(async () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  await page.waitForTimeout(180);
}

async function screenshotCanvas(
  page: import('playwright').Page,
  saveAs?: string,
): Promise<Rgba> {
  const canvas = page.locator('#molstar-stage canvas').first();
  await canvas.waitFor({ state: 'visible' });
  const png = await canvas.screenshot();
  const image = decodePng(png);
  // Playwright rasterises the canvas element's CSS box. A fractional box makes
  // that box round to a different size than Mol*'s drawing buffer, which
  // silently drops or duplicates an edge column. Refuse anything but a whole
  // drawing buffer, allowing at most the single rounding row or column the
  // page cannot control, which is then discarded.
  const backing = await page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('#molstar-stage canvas');
    if (element == null) throw new Error('Mol* canvas missing');
    return { width: element.width, height: element.height };
  });
  assert.ok(
    image.width >= backing.width && image.width <= backing.width + 1,
    `screenshot width ${image.width} does not cover the ${backing.width} px drawing buffer`,
  );
  assert.ok(
    image.height >= backing.height && image.height <= backing.height + 1,
    `screenshot height ${image.height} does not cover the ${backing.height} px drawing buffer`,
  );
  const cropped = crop(image, backing.width, backing.height);
  if (saveAs !== undefined) await savePng(saveAs, cropped);
  return cropped;
}

function crop(image: Rgba, width: number, height: number): Rgba {
  if (image.width === width && image.height === height) return image;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * image.width * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

async function main(): Promise<void> {
  const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outFlagIndex = process.argv.indexOf('--out');
  const outArg = process.argv.find((value) => value.startsWith('--out='))?.slice('--out='.length)
    ?? (outFlagIndex === -1 ? undefined : process.argv[outFlagIndex + 1]);
  if (outFlagIndex !== -1 && (outArg == null || outArg.startsWith('--'))) {
    throw new Error('--out needs a directory path, as `--out <dir>` or `--out=<dir>`.');
  }
  if (outArg != null && outArg.length === 0) throw new Error('--out was given an empty directory path.');
  const pixelDir = outArg == null
    ? resolve(pluginRoot, 'reports/pixels')
    : resolve(outArg);
  const fixture = await readFile(resolve(pluginRoot, 'test/fixtures/three-depth-markers.pdb'), 'utf8');
  const viewerUrl = pathToFileURL(resolve(pluginRoot, 'dist/viewer.html')).href;
  await mkdir(pixelDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.addInitScript(() => { globalThis.__stereoStructureAcceptanceMode = true; });
    await page.goto(viewerUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__stereoStructureAcceptance?.state().webgl2 === true, undefined, { timeout: 20_000 });
    if (failures.length) throw new Error(`viewer page error: ${failures.join('\n')}`);

    await page.evaluate(async (input) => {
      const hook = window.__stereoStructureAcceptance;
      if (!hook) throw new Error('acceptance hook missing');
      await hook.load(input.structureText);
      hook.setDensity(110, 1);
      await hook.setCamera([0, 0, input.cameraZ], [0, 0, 0]);
      await hook.setMode('parallel', 0, false);
    }, { structureText: fixture, cameraZ: CAMERA_Z });
    await settle(page);
    const zero = await screenshotCanvas(page, resolve(pixelDir, 'zero-baseline.png'));
    const zeroState = await page.evaluate(() => window.__stereoStructureAcceptance?.state());
    assert.ok(zeroState?.webgl2, 'WebGL2 unavailable: pixel acceptance refuses to fall back');
    assert.ok(zeroState?.params, 'zero-baseline parameters unavailable');
    // Everything below reads camera depths off the fixture, so the scripted
    // camera pose has to be the one Mol* is actually using.
    assert.ok(
      Math.abs(zeroState.camera.distanceToTarget - CAMERA_Z) < 1e-6,
      `scripted camera was displaced: distanceToTarget ${zeroState.camera.distanceToTarget} != ${CAMERA_Z}`,
    );
    const zeroMeasures = measureStereo(zero);
    printMeasurements('zero-baseline', zeroMeasures, { front: 0, centre: 0, rear: 0 });
    assertMarkersPresent(zeroMeasures);
    const zeroHalfDelta = maxHalfDelta(zero);
    console.log(`zero-baseline half comparison: max channel delta ${zeroHalfDelta.max} over ${zeroHalfDelta.differing} differing pixels; worst at ${zeroHalfDelta.at}`);
    assert.equal(zeroHalfDelta.max, 0, 'zero depth-strength halves are not pixel-identical');
    // Each marker has world x = 0, so at zero baseline both halves must show it
    // at the mono projection @stereo/geometry predicts for that marker's depth
    // and height. The horizontal prediction is the half centre for all three.
    const monoY = {} as Record<Marker, number>;
    for (const marker of MARKER_ORDER) {
      const mono = projectPointThroughEye(
        { x: 0, y: MARKERS[marker].worldY, z: markerDepth(marker) },
        zeroState.camera,
        0,
        zeroState.params.focus,
        'left',
      );
      monoY[marker] = mono.yPx;
      console.log(`zero-baseline ${marker} mono prediction: x=${mono.xPx.toFixed(2)} y=${mono.yPx.toFixed(2)}`);
      for (const eye of ['left', 'right'] as const) {
        assert.ok(Math.abs(zeroMeasures[marker][eye].x - mono.xPx) <= 1, `${marker} ${eye} centroid x ${zeroMeasures[marker][eye].x.toFixed(2)} misses mono projection ${mono.xPx.toFixed(2)}`);
        assert.ok(Math.abs(zeroMeasures[marker][eye].y - mono.yPx) <= 1, `${marker} ${eye} centroid y ${zeroMeasures[marker][eye].y.toFixed(2)} misses mono projection ${mono.yPx.toFixed(2)}`);
      }
    }

    await page.evaluate(() => window.__stereoStructureAcceptance?.setMode('parallel', 20, false));
    await settle(page);
    const parallel = await screenshotCanvas(page, resolve(pixelDir, 'parallel.png'));
    const parallelState = await page.evaluate(() => window.__stereoStructureAcceptance?.state());
    assert.ok(parallelState?.webgl2, 'WebGL2 unavailable: pixel acceptance refuses to fall back');
    assert.ok(parallelState?.params, 'stereo parameters unavailable');
    const stereoParams = parallelState.params;
    const parallelMeasures = measureStereo(parallel);
    const expected = Object.fromEntries(MARKER_ORDER.map((marker) => [
      marker,
      disparityPx(markerDepth(marker), parallelState.camera, stereoParams.eyeSeparation, stereoParams.focus),
    ])) as Record<Marker, number>;
    printMeasurements('stereo', parallelMeasures, expected);
    console.log(`stereo params: B=${stereoParams.eyeSeparation.toFixed(6)} Å; focus=${stereoParams.focus.toFixed(4)} Å; budget front=${stereoParams.frontDisparityPx.toFixed(3)} px at depth ${(parallelState.camera.boundingDepthNear ?? Number.NaN).toFixed(3)} Å; rear=${stereoParams.rearDisparityPx.toFixed(3)} px at depth ${(parallelState.camera.boundingDepthFar ?? Number.NaN).toFixed(3)} Å`);
    assert.ok(parallelState.stageWidth <= (63 / 25.4) * 110 * 2 + 1, 'parallel canvas did not letterbox to 63 mm per eye');
    assertMarkersPresent(parallelMeasures);
    assert.ok(parallelMeasures.front.disparity >= 10, `front disparity ${parallelMeasures.front.disparity.toFixed(2)} < 10 px`);
    assert.ok(Math.abs(parallelMeasures.centre.disparity) < 1, `centre disparity ${parallelMeasures.centre.disparity.toFixed(2)} px is not zero`);
    assert.ok(parallelMeasures.rear.disparity <= -5, `rear disparity ${parallelMeasures.rear.disparity.toFixed(2)} > -5 px`);
    for (const marker of MARKER_ORDER) {
      assert.ok(Math.abs(parallelMeasures[marker].vertical) < 0.5, `${marker} vertical disparity ${parallelMeasures[marker].vertical.toFixed(2)} px`);
    }
    for (const marker of MARKER_ORDER) {
      assert.ok(Math.abs(parallelMeasures[marker].disparity - expected[marker]) <= 1, `${marker} pixel disparity differs from @stereo/geometry: measured ${parallelMeasures[marker].disparity.toFixed(2)}, predicted ${expected[marker].toFixed(2)}`);
    }

    await page.evaluate(() => window.__stereoStructureAcceptance?.setMode('parallel', 20, true));
    await settle(page);
    const swappedImage = await screenshotCanvas(page, resolve(pixelDir, 'parallel-swap-eyes.png'));
    const swapped = measureStereo(swappedImage);
    printMeasurements('swap-eyes', swapped, {
      front: -parallelMeasures.front.disparity,
      centre: -parallelMeasures.centre.disparity,
      rear: -parallelMeasures.rear.disparity,
    });
    assertMarkersPresent(swapped);
    for (const marker of MARKER_ORDER) {
      assert.ok(Math.abs(swapped[marker].disparity + parallelMeasures[marker].disparity) <= 1, `${marker} swapEyes did not negate disparity`);
    }

    await page.evaluate(() => window.__stereoStructureAcceptance?.setMode('cross', 20, false));
    await settle(page);
    const cross = await screenshotCanvas(page, resolve(pixelDir, 'cross.png'));
    const crossMeasures = measureStereo(cross);
    printMeasurements('cross', crossMeasures, {
      front: -parallelMeasures.front.disparity,
      centre: -parallelMeasures.centre.disparity,
      rear: -parallelMeasures.rear.disparity,
    });
    const crossDelta = maxSwappedHalfDelta(parallel, cross);
    console.log(`cross against parallel with halves exchanged: max channel delta ${crossDelta.max} over ${crossDelta.differing} differing pixels; worst at ${crossDelta.at}`);
    assert.equal(crossDelta.max, 0, 'cross mode is not the parallel pair with halves exchanged');

    // ---- Depth-slider ladder ----
    //
    // What the slider claims to be: a depth budget in arcminutes, 0 to 40,
    // default 20, converted to a peak on-screen disparity at the assumed
    // viewing distance and screen density, and turned into a Mol* eye
    // separation B. Two consequences follow that a person can check by moving
    // the slider, and both are asserted here on rendered frames rather than
    // argued from the formula: the disparity of every feature scales linearly
    // with the number, and at 0 the two eyes are the same image.
    //
    // Linear in the slider, not in tan(theta): the conversion is
    // tan(theta) · D · ppi / 25.4, and over 0 to 40 arcmin tan(theta) departs
    // from theta by about one part in 10^5, so the tan ratio is the expected
    // value and the linear ratio is inside the tolerance either way.
    const LADDER = [0, 10, 20, 40] as const;
    type LadderRow = {
      depth: number;
      front: number;
      rear: number;
      centre: number;
      vertical: number;
      eyeSeparation: number;
      predictedFront: number;
      predictedRear: number;
    };
    const ladder: LadderRow[] = [];
    for (const depth of LADDER) {
      await page.evaluate((value) => window.__stereoStructureAcceptance?.setMode('parallel', value, false), depth);
      await settle(page);
      const image = await screenshotCanvas(page, resolve(pixelDir, `parallel-depth-${depth}.png`));
      const measured = measureStereo(image);
      const state = await page.evaluate(() => window.__stereoStructureAcceptance?.state());
      assert.ok(state?.params, `depth ${depth} stereo parameters unavailable`);
      assertMarkersPresent(measured);
      ladder.push({
        depth,
        front: measured.front.disparity,
        rear: measured.rear.disparity,
        centre: measured.centre.disparity,
        vertical: Math.max(...MARKER_ORDER.map((marker) => Math.abs(measured[marker].vertical))),
        eyeSeparation: state.params.eyeSeparation,
        predictedFront: disparityPx(markerDepth('front'), state.camera, state.params.eyeSeparation, state.params.focus),
        predictedRear: disparityPx(markerDepth('rear'), state.camera, state.params.eyeSeparation, state.params.focus),
      });
    }
    console.log('depth ladder (slider arcmin -> eye separation -> rendered disparity, px):');
    for (const row of ladder) {
      console.log(
        `  ${String(row.depth).padStart(2)}′  B ${row.eyeSeparation.toFixed(6)} Å`
        + `  front ${row.front.toFixed(2).padStart(6)} (predicted ${row.predictedFront.toFixed(2).padStart(6)})`
        + `  rear ${row.rear.toFixed(2).padStart(6)} (predicted ${row.predictedRear.toFixed(2).padStart(6)})`
        + `  centre ${row.centre.toFixed(2).padStart(5)}  |vertical| <= ${row.vertical.toFixed(2)}`,
      );
    }
    const rung = (depth: number): LadderRow => {
      const row = ladder.find((entry) => entry.depth === depth);
      if (row === undefined) throw new Error(`depth ${depth} was not measured`);
      return row;
    };

    // 0 is flat: no eye separation, and the two eyes coincide on every marker.
    const flat = rung(0);
    assert.equal(flat.eyeSeparation, 0, `depth 0 did not zero the eye separation: B=${flat.eyeSeparation}`);
    for (const marker of MARKER_ORDER) {
      const disparity = marker === 'front' ? flat.front : marker === 'centre' ? flat.centre : flat.rear;
      assert.ok(Math.abs(disparity) <= 0.5, `depth 0 ${marker} disparity ${disparity.toFixed(3)} px is not flat`);
    }

    // Linearity is exact in the two places it can be stated exactly: the eye
    // separation the slider derives, and the disparity @stereo/geometry
    // predicts from it. The rendered centroid of a shaded marker carries its
    // own error of a few tenths of a pixel — the two eyes see genuinely
    // different silhouettes at 40′ — so the rendered ramp is held to a looser
    // bound and the tight assertion is against the prediction.
    const reference = rung(20);
    for (const depth of [10, 40] as const) {
      const row = rung(depth);
      const ratio = Math.tan((depth / 60) * Math.PI / 180) / Math.tan((20 / 60) * Math.PI / 180);
      assert.ok(
        Math.abs(row.eyeSeparation / reference.eyeSeparation - ratio) < 1e-6,
        `depth ${depth} eye separation ${row.eyeSeparation} is not ${ratio.toFixed(6)} x the depth-20 baseline`,
      );
      for (const marker of ['front', 'rear'] as const) {
        const predicted = marker === 'front' ? row.predictedFront : row.predictedRear;
        const referencePredicted = marker === 'front' ? reference.predictedFront : reference.predictedRear;
        assert.ok(
          Math.abs(predicted - referencePredicted * ratio) < 1e-6,
          `depth ${depth} predicted ${marker} disparity ${predicted} is not linear in the budget`,
        );
        assert.ok(
          Math.abs(row[marker] - predicted) <= 1,
          `depth ${depth} rendered ${marker} disparity ${row[marker].toFixed(3)} px misses the prediction ${predicted.toFixed(3)} px`,
        );
        assert.ok(
          Math.abs(row[marker] - reference[marker] * ratio) <= 0.6,
          `depth ${depth} rendered ${marker} disparity ${row[marker].toFixed(3)} px is off the measured ramp through depth 20 (${(reference[marker] * ratio).toFixed(3)} px)`,
        );
      }
      assert.ok(Math.abs(row.centre) <= 0.5, `depth ${depth} centre disparity ${row.centre.toFixed(3)} px is not zero`);
      assert.ok(row.vertical < 0.5, `depth ${depth} vertical disparity ${row.vertical.toFixed(3)} px`);
    }
    assert.ok(
      rung(40).front > rung(20).front && rung(20).front > rung(10).front && rung(10).front > flat.front,
      'front disparity is not monotonic in the depth budget',
    );
    assert.ok(
      rung(40).rear < rung(20).rear && rung(20).rear < rung(10).rear && rung(10).rear < flat.rear,
      'rear disparity is not monotonic in the depth budget',
    );

    // ---- Anaglyph luma criterion ----
    //
    // Measured on the shipped rendering: lighting on and Mol*'s own SMAA pass
    // on. That is what the two filters actually receive, and it is only
    // measurable now that the DrawPass fork composites after AntialiasingPass
    // instead of being painted over by it.
    await page.evaluate(async () => {
      const hook = window.__stereoStructureAcceptance;
      if (!hook) throw new Error('acceptance hook missing');
      hook.setGlasses('red-cyan');
      hook.setVariant('balanced');
      await hook.setMarkerShading('shipped');
      hook.setPasses({ antialiasing: true, multiSample: false });
      await hook.setMode('anaglyph', 0, false);
    });
    await settle(page);
    const balancedZero = await screenshotCanvas(page, resolve(pixelDir, 'anaglyph-balanced-zero.png'));
    const balancedResidual = anaglyphResidualPercent(balancedZero);
    const balancedMismatch = greenBlueMismatch(balancedZero);
    const workshopLumaResidual = filterChannelLuma(
      srgbToLinear([1, 0, 0]),
      srgbToLinear([0, 142 / 255, 142 / 255]),
    ).residualPercent;
    console.log(`anaglyph balanced zero-depth literal rendered-channel residual=${balancedResidual.toFixed(4)}% (limit 0.25%); green-blue mismatched pixels ${balancedMismatch}`);
    console.log(`direct workshop red/cyan ink residual=${workshopLumaResidual.toFixed(4)}%`);

    // Every balanced red-cyan pixel has G = B, because both channels come from
    // the same matrix rows. A frame that never reached the compositor does not.
    await page.evaluate(() => window.__stereoStructureAcceptance?.setMode('off', 0, false));
    await settle(page);
    const shippedMono = await screenshotCanvas(page, resolve(pixelDir, 'shipped-mono-zero.png'));
    const monoMismatch = greenBlueMismatch(shippedMono);
    console.log(`shipped-pass mono frame green-blue mismatched pixels ${monoMismatch}`);
    assert.ok(monoMismatch > 0, 'green-blue equality is vacuous: the mono frame has G = B everywhere');
    assert.equal(balancedMismatch, 0, 'balanced anaglyph composite did not reach the drawing buffer under antialiasing');

    await page.evaluate(async () => {
      const hook = window.__stereoStructureAcceptance;
      hook?.setPasses({ antialiasing: true, multiSample: true });
      await hook?.setMode('anaglyph', 0, false);
    });
    await settle(page);
    const balancedMultiSample = await screenshotCanvas(page, resolve(pixelDir, 'anaglyph-balanced-multisample.png'));
    const multiSamplePasses = await page.evaluate(() => window.__stereoStructureAcceptance?.state().passes);
    const multiSampleAccumulated = differingPixels(balancedMultiSample, balancedZero);
    const multiSampleMismatch = greenBlueMismatch(balancedMultiSample);
    // The pass being enabled is read from Mol*'s own props rather than
    // inferred. Temporal multisampling advances one jittered sample per idle
    // frame and the acceptance render never gets a second one, so this frame
    // is sample 0 and is expected to equal the frame above. What it proves is
    // that MultiSamplePass no longer replaces the composite with its own copy
    // of the scene, which is what it did before the DrawPass fork honoured
    // `toDrawingBuffer`.
    console.log(`anaglyph with Mol* passes antialiasing=${multiSamplePasses?.antialiasing} multiSample=${multiSamplePasses?.multiSample}: ${multiSampleAccumulated.differing} pixels differ from the single-sample frame; green-blue mismatched pixels ${multiSampleMismatch}`);
    assert.equal(multiSamplePasses?.multiSample, 'temporal', 'temporal multisampling was not enabled for this capture');
    assert.equal(multiSamplePasses?.antialiasing, 'smaa', 'antialiasing was not enabled for this capture');
    assert.equal(multiSampleMismatch, 0, 'balanced anaglyph composite did not survive temporal multisampling');

    // Dubois is recorded, never asserted. It is the colour projector and every
    // matrix writes into both filter groups, so it fails the adopted criterion
    // by design.
    await page.evaluate(async () => {
      const hook = window.__stereoStructureAcceptance;
      hook?.setPasses({ antialiasing: true, multiSample: false });
      hook?.setVariant('dubois');
      await hook?.setMode('anaglyph', 0, false);
    });
    await settle(page);
    const duboisZero = await screenshotCanvas(page, resolve(pixelDir, 'anaglyph-dubois-zero.png'));
    const duboisResidual = anaglyphResidualPercent(duboisZero);
    console.log(`INFORMATIONAL anaglyph dubois zero-depth literal rendered-channel residual=${duboisResidual.toFixed(4)}% (not a pass; Dubois cross-talk is by design)`);

    // Back to the gate presentation: flat swatches the classifier can separate,
    // and no screen-space pass indexed by absolute framebuffer coordinate.
    await page.evaluate(async () => {
      const hook = window.__stereoStructureAcceptance;
      if (!hook) throw new Error('acceptance hook missing');
      hook.setVariant('balanced');
      hook.setPasses({ antialiasing: false, multiSample: false });
      // `setVariant` schedules a Mol* theme commit while anaglyph is active.
      // Drain that presentation work before the acceptance-only representation
      // update, otherwise the two state commits race and the theme update can
      // restore shaded marker props after this asks for flat swatches.
      await hook.setMode('anaglyph', 0, false);
      await hook.setMarkerShading('flat');
    });
    await settle(page);
    const anaglyphZero = await screenshotCanvas(page, resolve(pixelDir, 'anaglyph-flat-zero.png'));
    const flatResidual = anaglyphResidualPercent(anaglyphZero);
    console.log(`INFORMATIONAL anaglyph balanced zero-depth residual on the gate's flat unlit swatches=${flatResidual.toFixed(4)}% (four colours only, so 8-bit rounding cannot average out)`);

    await page.evaluate(() => window.__stereoStructureAcceptance?.setMode('off', 20, false));
    await settle(page);
    const mono = await screenshotCanvas(page, resolve(pixelDir, 'mono.png'));
    await page.evaluate(() => window.__stereoStructureAcceptance?.setMode('anaglyph', 20, false));
    await settle(page);
    const anaglyphDepth = await screenshotCanvas(page, resolve(pixelDir, 'anaglyph.png'));
    assert.ok(maxPixelDelta(anaglyphDepth, mono) > 0, 'depth-on anaglyph did not differ from mono');

    // The anaglyph pass renders both eyes full frame instead of splitting the
    // viewport, so it must reproduce the same predicted disparity the
    // side-by-side modes do.
    const anaglyphState = await page.evaluate(() => window.__stereoStructureAcceptance?.state());
    assert.ok(anaglyphState?.params, 'anaglyph parameters unavailable');
    assert.ok(
      anaglyphState.look.representations.length > 0
        && anaglyphState.look.representations.every((representation) => representation.ignoreLight === true),
      'anaglyph marker classifier requires the acceptance fixture to remain flat-shaded',
    );
    const anaglyphExpected = Object.fromEntries(MARKER_ORDER.map((marker) => [
      marker,
      disparityPx(markerDepth(marker), anaglyphState.camera, anaglyphState.params!.eyeSeparation, anaglyphState.params!.focus),
    ])) as Record<Marker, number>;
    const anaglyphMeasures = measureAnaglyph(anaglyphDepth, monoY);
    printMeasurements('anaglyph', anaglyphMeasures, anaglyphExpected);
    assertMarkersPresent(anaglyphMeasures);
    for (const marker of MARKER_ORDER) {
      assert.ok(Math.abs(anaglyphMeasures[marker].vertical) < 0.5, `${marker} anaglyph vertical disparity ${anaglyphMeasures[marker].vertical.toFixed(2)} px`);
      assert.ok(Math.abs(anaglyphMeasures[marker].disparity - anaglyphExpected[marker]) <= 1, `${marker} anaglyph disparity differs from @stereo/geometry: measured ${anaglyphMeasures[marker].disparity.toFixed(2)}, predicted ${anaglyphExpected[marker].toFixed(2)}`);
    }
    // ---- Rendered mirror and screen-gradient checks ----
    //
    // Both use a variant of the fixture whose markers are spread in world x.
    // On the shipped fixture every marker sits on x = 0, which makes an
    // x-mirror a no-op and puts all three markers at one screen midpoint.
    const offAxis = withMarkerX(fixture, 1);
    const offAxisMirrored = withMarkerX(fixture, -1);
    const loadOffAxis = async (structureText: string) => {
      await page.evaluate(async (input) => {
        const hook = window.__stereoStructureAcceptance;
        if (!hook) throw new Error('acceptance hook missing');
        await hook.load(input.structureText);
        await hook.setCamera([0, 0, input.cameraZ], [0, 0, 0]);
        await hook.setMode('parallel', 20, false);
      }, { structureText, cameraZ: CAMERA_Z });
      await settle(page);
    };

    await loadOffAxis(offAxis);
    const offAxisImage = await screenshotCanvas(page, resolve(pixelDir, 'mirror-normal.png'));
    const offAxisState = await page.evaluate(() => window.__stereoStructureAcceptance?.state());
    assert.ok(offAxisState?.params, 'off-axis fixture parameters unavailable');
    // Horizontal disparity in a sheared stereo pair depends on depth only, so
    // the same prediction holds for markers that are no longer on the axis.
    const offAxisExpected = Object.fromEntries(MARKER_ORDER.map((marker) => [
      marker,
      disparityPx(markerDepth(marker), offAxisState.camera, offAxisState.params!.eyeSeparation, offAxisState.params!.focus),
    ])) as Record<Marker, number>;
    const offAxisMeasures = measureStereo(offAxisImage);
    printMeasurements('off-axis', offAxisMeasures, offAxisExpected);
    assertMarkersPresent(offAxisMeasures);
    for (const marker of MARKER_ORDER) {
      assert.ok(
        Math.abs(offAxisMeasures[marker].disparity - offAxisExpected[marker]) <= 1,
        `${marker} off-axis disparity differs from @stereo/geometry: measured ${offAxisMeasures[marker].disparity.toFixed(2)}, predicted ${offAxisExpected[marker].toFixed(2)}`,
      );
    }

    await loadOffAxis(offAxisMirrored);
    const mirroredImage = await screenshotCanvas(page, resolve(pixelDir, 'mirror-mirrored.png'));
    const mirroredMeasures = measureStereo(mirroredImage);
    printMeasurements('mirrored', mirroredMeasures, offAxisExpected);
    assertMarkersPresent(mirroredMeasures);

    const exchanged = mirrorHalvesAndSwap(mirroredImage);
    await savePng(resolve(pixelDir, 'mirror-exchanged.png'), exchanged);
    const mirrorDelta = differingPixels(exchanged, offAxisImage);
    const exchangedMeasures = measureStereo(exchanged);
    console.log(`mirror comparison: max channel delta ${mirrorDelta.max} over ${mirrorDelta.differing} differing pixels; worst at ${mirrorDelta.at}`);
    for (const marker of MARKER_ORDER) {
      for (const eye of ['left', 'right'] as const) {
        const measured = exchangedMeasures[marker][eye].x;
        const reference = offAxisMeasures[marker][eye].x;
        assert.ok(
          Math.abs(measured - reference) <= 1,
          `${marker} ${eye} centroid x ${measured.toFixed(2)} does not exchange with the mirrored scene's ${reference.toFixed(2)}`,
        );
        const measuredY = exchangedMeasures[marker][eye].y;
        const referenceY = offAxisMeasures[marker][eye].y;
        assert.ok(
          Math.abs(measuredY - referenceY) <= 1,
          `${marker} ${eye} centroid y ${measuredY.toFixed(2)} does not exchange with the mirrored scene's ${referenceY.toFixed(2)}`,
        );
      }
      assert.ok(
        Math.abs(exchangedMeasures[marker].disparity - offAxisMeasures[marker].disparity) <= 1,
        `${marker} mirrored disparity ${exchangedMeasures[marker].disparity.toFixed(2)} does not match ${offAxisMeasures[marker].disparity.toFixed(2)}`,
      );
    }

    const gradient = screenGradient(offAxisMeasures);
    console.log(`screen-space disparity gradient ${gradient.max.toFixed(6)} px/px, worst ${gradient.at}; smallest midpoint separation ${gradient.minSeparation.toFixed(2)} px`);
    assert.ok(gradient.minSeparation > 1, 'screen gradient is degenerate: markers share a screen midpoint');
    assert.ok(gradient.max <= 1, `screen-space disparity gradient ${gradient.max.toFixed(6)} px/px exceeds 1`);

    if (failures.length) throw new Error(`viewer page error: ${failures.join('\n')}`);

    // The luma criterion is asserted last so a red gate still prints every
    // measurement above it.
    assert.ok(workshopLumaResidual <= 0.25, `workshop filter luma residual ${workshopLumaResidual.toFixed(4)}% > 0.25%`);
    assert.ok(
      balancedResidual <= 0.25,
      `balanced anaglyph rendered literal luma residual ${balancedResidual.toFixed(4)}% > 0.25%`,
    );

    console.log(`depth ladder PASS; ${ladder.map((row) => `${row.depth}′ B ${row.eyeSeparation.toFixed(6)} Å front ${row.front.toFixed(2)} rear ${row.rear.toFixed(2)}`).join('; ')}.`);
    console.log(`WebGL2 PASS; front ${parallelMeasures.front.disparity.toFixed(2)} px, centre ${parallelMeasures.centre.disparity.toFixed(2)} px, rear ${parallelMeasures.rear.disparity.toFixed(2)} px; balanced rendered literal luma residual ${balancedResidual.toFixed(4)}% (limit 0.25%); Dubois ${duboisResidual.toFixed(4)}% recorded, not asserted; mirror max delta ${mirrorDelta.max}; gradient ${gradient.max.toFixed(4)} px/px; half width ${(parallelState.stageWidth / 2).toFixed(2)} CSS px.`);
    console.log('ALL CHECKS PASS — a patched-matrix regression on the three-marker fixture in headless Chromium, not evidence for arbitrary proteins or for any human percept.');
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error('CHECKS FAILED');
  console.error(error);
  process.exitCode = 1;
});

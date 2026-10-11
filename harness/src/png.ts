import { inflateSync } from 'node:zlib';

export type DecodedPng = {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major. */
  pixels: Uint8Array;
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal PNG reader for the subset Playwright emits: 8-bit, non-interlaced,
 * colour type 2 (RGB) or 6 (RGBA). Used only to measure screenshots
 * numerically; it is not a general-purpose decoder.
 */
export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG buffer.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8]!;
      colorType = buffer[dataStart + 9]!;
      interlace = buffer[dataStart + 12]!;
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]!;
    cursor += 1;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[cursor + x]!;
      const left = x >= channels ? line[x - channels]! : 0;
      const up = prior[x]!;
      const upLeft = x >= channels ? prior[x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + left; break;
        case 2: value = rawByte + up; break;
        case 3: value = rawByte + ((left + up) >> 1); break;
        case 4: value = rawByte + paeth(left, up, upLeft); break;
        default: throw new Error(`Unknown PNG filter ${filter} on row ${y}.`);
      }
      line[x] = value & 0xff;
    }
    cursor += stride;
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = rowBase + x * 4;
      out[target] = line[source]!;
      out[target + 1] = line[source + 1]!;
      out[target + 2] = line[source + 2]!;
      out[target + 3] = channels === 4 ? line[source + 3]! : 255;
    }
    prior.set(line);
  }
  return { width, height, pixels: out };
}

export type CanvasStats = {
  width: number;
  height: number;
  /** Mean Rec.709 luma, 0-255. */
  meanLuma: number;
  /** Fraction of pixels more than 12/255 away from the modal background colour. */
  inkFraction: number;
  /**
   * Mean absolute RGB difference between the left and right halves, 0-255.
   * A side-by-side stereo pair renders near-identical halves, so this drops
   * sharply relative to a single full-width render.
   */
  halfDifference: number;
  /**
   * Mean |R - (G+B)/2| over inked pixels, 0-255. Rises when the frame carries
   * a red/cyan channel split.
   */
  channelSplit: number;
  /**
   * Pearson correlation of luma between the left and right halves. A
   * side-by-side stereo pair puts a near-copy of the same view in each half, so
   * this runs high; a single full-width render leaves it near zero.
   */
  halfCorrelation: number;
  /**
   * Horizontal shift, in image px, at which the red channel best matches the
   * green channel, searched over +/-24 px, with the correlation reached there.
   * An anaglyph carries the two eyes in those channels, so the best shift is
   * the channel disparity.
   */
  redGreenBestShiftPx: number;
  redGreenBestCorrelation: number;
};

function pearson(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  if (n === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let devA = 0;
  let devB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  const denom = Math.sqrt(devA * devB);
  return denom === 0 ? 0 : num / denom;
}

export function canvasStats(png: DecodedPng): CanvasStats {
  const { width, height, pixels } = png;
  const histogram = new Map<number, number>();
  for (let i = 0; i < pixels.length; i += 4) {
    const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  let background = 0;
  let backgroundCount = -1;
  for (const [key, count] of histogram) {
    if (count > backgroundCount) {
      backgroundCount = count;
      background = key;
    }
  }
  const bgR = (background >> 16) & 0xff;
  const bgG = (background >> 8) & 0xff;
  const bgB = background & 0xff;

  let lumaSum = 0;
  let inked = 0;
  let splitSum = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 12) {
      inked += 1;
      splitSum += Math.abs(r - (g + b) / 2);
    }
  }

  const half = Math.floor(width / 2);
  let halfSum = 0;
  let halfCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < half; x += 1) {
      const a = (y * width + x) * 4;
      const b = (y * width + x + half) * 4;
      halfSum += Math.abs(pixels[a]! - pixels[b]!)
        + Math.abs(pixels[a + 1]! - pixels[b + 1]!)
        + Math.abs(pixels[a + 2]! - pixels[b + 2]!);
      halfCount += 3;
    }
  }

  const leftLuma = new Float64Array(half * height);
  const rightLuma = new Float64Array(half * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < half; x += 1) {
      const target = y * half + x;
      const a = (y * width + x) * 4;
      const b = (y * width + x + half) * 4;
      leftLuma[target] = 0.2126 * pixels[a]! + 0.7152 * pixels[a + 1]! + 0.0722 * pixels[a + 2]!;
      rightLuma[target] = 0.2126 * pixels[b]! + 0.7152 * pixels[b + 1]! + 0.0722 * pixels[b + 2]!;
    }
  }

  const maxShift = 24;
  const inner = width - 2 * maxShift;
  let bestShift = 0;
  let bestCorrelation = -2;
  if (inner > 0) {
    const red = new Float64Array(inner * height);
    const green = new Float64Array(inner * height);
    for (let shift = -maxShift; shift <= maxShift; shift += 1) {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < inner; x += 1) {
          const target = y * inner + x;
          red[target] = pixels[(y * width + x + maxShift) * 4]!;
          green[target] = pixels[(y * width + x + maxShift + shift) * 4 + 1]!;
        }
      }
      const correlation = pearson(red, green);
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestShift = shift;
      }
    }
  }

  const pixelCount = width * height;
  return {
    width,
    height,
    meanLuma: Number((lumaSum / pixelCount).toFixed(3)),
    inkFraction: Number((inked / pixelCount).toFixed(5)),
    halfDifference: Number((halfCount === 0 ? 0 : halfSum / halfCount).toFixed(3)),
    channelSplit: Number((inked === 0 ? 0 : splitSum / inked).toFixed(3)),
    halfCorrelation: Number(pearson(leftLuma, rightLuma).toFixed(4)),
    redGreenBestShiftPx: bestShift,
    redGreenBestCorrelation: Number((bestCorrelation === -2 ? 0 : bestCorrelation).toFixed(4)),
  };
}

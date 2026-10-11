import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canvasStats, decodePng, type DecodedPng } from './png.js';

/** Minimal encoder: 8-bit RGBA, non-interlaced, filter 0 on every row. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    // The decoder skips the CRC, so a zero placeholder is enough here.
    return Buffer.concat([length, body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(raw, y * (1 + width * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function blank(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return pixels;
}

function paint(pixels: Uint8Array, width: number, x: number, y: number, r: number, g: number, b: number): void {
  const index = (y * width + x) * 4;
  pixels[index] = r;
  pixels[index + 1] = g;
  pixels[index + 2] = b;
}

describe('screenshot measurement', () => {
  it('round-trips an RGBA image through the decoder', () => {
    const pixels = blank(4, 3);
    paint(pixels, 4, 2, 1, 200, 100, 50);
    const decoded = decodePng(encodePng(4, 3, pixels));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect([...decoded.pixels.subarray(4 * (1 * 4 + 2), 4 * (1 * 4 + 2) + 3)]).toEqual([200, 100, 50]);
  });

  it('reports near-zero half correlation for a one-sided render', () => {
    const width = 40;
    const height = 20;
    const pixels = blank(width, height);
    for (let y = 4; y < 16; y += 1) for (let x = 4; x < 16; x += 1) paint(pixels, width, x, y, 220, 220, 220);
    const stats = canvasStats({ width, height, pixels } as DecodedPng);
    expect(stats.halfCorrelation).toBeLessThan(0.1);
    expect(stats.inkFraction).toBeGreaterThan(0);
  });

  it('reports high half correlation for a side-by-side pair', () => {
    const width = 40;
    const height = 20;
    const pixels = blank(width, height);
    for (let y = 4; y < 16; y += 1) {
      for (let x = 4; x < 16; x += 1) {
        paint(pixels, width, x, y, 220, 220, 220);
        paint(pixels, width, x + 20, y, 220, 220, 220);
      }
    }
    const stats = canvasStats({ width, height, pixels } as DecodedPng);
    expect(stats.halfCorrelation).toBeGreaterThan(0.9);
  });

  it('finds the red-to-green shift of a channel-separated frame', () => {
    const width = 80;
    const height = 20;
    const pixels = blank(width, height);
    for (let y = 4; y < 16; y += 1) {
      for (let x = 30; x < 42; x += 1) {
        paint(pixels, width, x, y, 240, pixels[(y * width + x) * 4 + 1]!, 0);
        paint(pixels, width, x + 6, y, pixels[(y * width + x + 6) * 4]!, 240, 0);
      }
    }
    const stats = canvasStats({ width, height, pixels } as DecodedPng);
    expect(stats.redGreenBestShiftPx).toBe(6);
    expect(stats.redGreenBestCorrelation).toBeGreaterThan(0.9);
  });
});

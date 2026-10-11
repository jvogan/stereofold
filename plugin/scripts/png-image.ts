/**
 * A dependency-free PNG reader and writer for the XR gate.
 *
 * The gate has to look at the harness's frames, not just at numbers derived
 * from them, and it has to hand a human one image to look at. Neither needs a
 * renderer: the harness writes 8-bit non-interlaced PNGs straight out of a
 * canvas, and a contact sheet is a paste-and-scale job. `node:zlib` supplies
 * the only hard part, so this file adds no dependency to the plugin.
 *
 * Deliberately narrow: 8-bit colour type 2 (RGB) or 6 (RGBA), no interlace, no
 * palette, no 16-bit. Anything else throws by name rather than decoding wrong.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface RasterImage {
  width: number;
  height: number;
  /** Row-major RGBA, four bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Paeth predictor, exactly as the PNG specification defines it. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

export function decodePng(bytes: Buffer): RasterImage {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw Error('Not a PNG: the eight-byte signature is missing.');
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw Error(`Unsupported PNG bit depth ${bitDepth}; the gate reads 8-bit images.`);
  if (colorType !== 2 && colorType !== 6) throw Error(`Unsupported PNG colour type ${colorType}; the gate reads RGB and RGBA.`);
  if (interlace !== 0) throw Error('Unsupported interlaced PNG; the gate reads progressive-free images.');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let cursor = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[cursor++];
    const line = new Uint8Array(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? line[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      if (filter === 1) line[index] = (line[index] + left) & 0xff;
      else if (filter === 2) line[index] = (line[index] + up) & 0xff;
      else if (filter === 3) line[index] = (line[index] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) line[index] = (line[index] + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw Error(`Unknown PNG row filter ${filter}.`);
    }
    for (let column = 0; column < width; column++) {
      const source = column * channels, target = (row * width + column) * 4;
      data[target] = line[source];
      data[target + 1] = line[source + 1];
      data[target + 2] = line[source + 2];
      data[target + 3] = channels === 4 ? line[source + 3] : 255;
    }
    previous = line;
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
  return Buffer.concat([header, body, crc]);
}

export function encodePng(image: RasterImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let row = 0; row < image.height; row++) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + row * stride, stride)
      .copy(raw, row * (stride + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export function createImage(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 255]): RasterImage {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill[0];
    data[index + 1] = fill[1];
    data[index + 2] = fill[2];
    data[index + 3] = fill[3];
  }
  return { width, height, data };
}

export function cropImage(image: RasterImage, x: number, y: number, width: number, height: number): RasterImage {
  const left = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const right = Math.max(left + 1, Math.min(image.width, Math.round(x + width)));
  const bottom = Math.max(top + 1, Math.min(image.height, Math.round(y + height)));
  const out = createImage(right - left, bottom - top);
  for (let row = top; row < bottom; row++) {
    const source = (row * image.width + left) * 4;
    out.data.set(image.data.subarray(source, source + (right - left) * 4), (row - top) * (right - left) * 4);
  }
  return out;
}

/** Nearest-neighbour resample. A gate image is read for position and ink, not for smoothness. */
export function resizeImage(image: RasterImage, width: number, height: number): RasterImage {
  const out = createImage(width, height);
  for (let row = 0; row < height; row++) {
    const sourceRow = Math.min(image.height - 1, Math.floor((row * image.height) / height));
    for (let column = 0; column < width; column++) {
      const sourceColumn = Math.min(image.width - 1, Math.floor((column * image.width) / width));
      const source = (sourceRow * image.width + sourceColumn) * 4;
      out.data.set(image.data.subarray(source, source + 4), (row * width + column) * 4);
    }
  }
  return out;
}

export function blit(target: RasterImage, source: RasterImage, x: number, y: number): void {
  for (let row = 0; row < source.height; row++) {
    const targetRow = y + row;
    if (targetRow < 0 || targetRow >= target.height) continue;
    for (let column = 0; column < source.width; column++) {
      const targetColumn = x + column;
      if (targetColumn < 0 || targetColumn >= target.width) continue;
      const from = (row * source.width + column) * 4, to = (targetRow * target.width + targetColumn) * 4;
      target.data.set(source.data.subarray(from, from + 4), to);
    }
  }
}

export function drawRect(image: RasterImage, x: number, y: number, width: number, height: number,
  color: [number, number, number], thickness = 1): void {
  const set = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return;
    const index = (py * image.width + px) * 4;
    image.data[index] = color[0];
    image.data[index + 1] = color[1];
    image.data[index + 2] = color[2];
    image.data[index + 3] = 255;
  };
  for (let step = 0; step < thickness; step++) {
    for (let column = x - step; column <= x + width + step; column++) { set(column, y - step); set(column, y + height + step); }
    for (let row = y - step; row <= y + height + step; row++) { set(x - step, row); set(x + width + step, row); }
  }
}

/**
 * A 5x7 bitmap for the ASCII the gate labels frames with.
 *
 * Contact-sheet captions have to survive being read on a laptop, so the glyphs
 * are drawn at an integer scale rather than antialiased. Each entry is seven
 * rows of five bits, most significant bit leftmost.
 */
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00], '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c], ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00], '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00], '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04], '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  '*': [0x00, 0x0a, 0x04, 0x1f, 0x04, 0x0a, 0x00], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], "'": [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

export const TEXT_GLYPH_WIDTH = 6;

export function textWidth(text: string, scale = 2): number {
  return text.length * TEXT_GLYPH_WIDTH * scale;
}

export function drawText(image: RasterImage, text: string, x: number, y: number,
  color: [number, number, number] = [255, 255, 255], scale = 2): void {
  let cursor = x;
  for (const character of text.toUpperCase()) {
    const glyph = FONT[character] ?? FONT['?'];
    for (let row = 0; row < 7; row++) {
      for (let bit = 0; bit < 5; bit++) {
        if (!(glyph[row] & (1 << (4 - bit)))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = cursor + bit * scale + dx, py = y + row * scale + dy;
            if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
            const index = (py * image.width + px) * 4;
            image.data[index] = color[0];
            image.data[index + 1] = color[1];
            image.data[index + 2] = color[2];
            image.data[index + 3] = 255;
          }
        }
      }
    }
    cursor += TEXT_GLYPH_WIDTH * scale;
  }
}

/**
 * Turn a deposited cryo-EM density map into the small one a headset can hold.
 *
 * A whole decorated microtubule has no atomic tier a Quest 2 can draw: the
 * 13-protofilament tube is 177,268 atom sites against a 43,066-site ceiling
 * (`src/molecular-growth.ts`). Its density map has no such problem, because a
 * map's cost is the isosurface it meshes to rather than the atoms behind it.
 * EMD-6347 (the GTPgammaS microtubule co-polymerised with EB3) is
 * 512^3 float32 voxels, 512 MB expanded, and meshes to
 * 4,581,248 triangles at the author's recommended contour of 5.0 — nine times
 * over a Quest 2's static-mesh budget, and far over any byte budget the share
 * carries. Mean-downsampled 4x it is 128^3 and 8.4 MB. At the prepared
 * contour of 3.3, Mol* draws 178,236 triangles on its quantized GPU grid.
 *
 * So this runs on the Mac, once, and what reaches the headset is the prepared
 * map. Nothing here invents density: every output voxel is the mean of the
 * f^3 deposited voxels underneath it, and the header is rewritten so the mesh
 * retains the deposited map's angstrom frame.
 *
 *   pnpm --dir plugin exec tsx scripts/prepare-map.ts \
 *     ~/Downloads/emd_6347.map.gz ~/Library/Caches/Stereofold/demos/emd_6347-4x.map \
 *     --downsample 4
 *
 * The frame, precisely. A CCP4/MRC sample (0,0,0) sits at the cartesian point
 * `origin` when the ORIGIN records are set and at `N*START * voxel` when they
 * are not; sample i sits one voxel further along. Mean-downsampling by f makes
 * output sample j the mean of input samples [j*f, j*f+f), whose centre of mass
 * is input sample j*f + (f-1)/2 — so the output voxel is f times wider AND the
 * output origin moves half a block along each axis. Dropping that half-block
 * shift is how a downsampled map ends up offset from its own fitted model by
 * a couple of angstroms; it is small, it is silent, and it is wrong.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** The fixed CCP4/MRC header, in bytes, before any symmetry records. */
export const MAP_HEADER_BYTES = 1_024;
/** MRC mode 2: one 32-bit float per voxel. The only mode this script writes. */
export const MAP_MODE_FLOAT32 = 2;
const LABEL_BYTES = 80;

export type MapHeader = {
  /** Grid extent, in the file's own column/row/section order. */
  columns: number; rows: number; sections: number;
  mode: number;
  columnStart: number; rowStart: number; sectionStart: number;
  /** MX/MY/MZ: how many samples the unit cell is divided into. */
  sampling: readonly [number, number, number];
  /** CELLA, in angstroms, and CELLB, in degrees. */
  cell: readonly [number, number, number];
  angles: readonly [number, number, number];
  /** MAPC/MAPR/MAPS: which cartesian axis the columns, rows and sections run along. */
  axisOrder: readonly [number, number, number];
  min: number; max: number; mean: number; rms: number;
  spacegroup: number; symmetryBytes: number;
  /** The ORIGIN records, in angstroms. Zero on a map that uses N*START instead. */
  origin: readonly [number, number, number];
  label: string;
};

export type PreparedMap = { header: MapHeader; values: Float32Array };

const int32 = (bytes: Buffer, word: number): number => bytes.readInt32LE(word * 4);
const float32 = (bytes: Buffer, word: number): number => bytes.readFloatLE(word * 4);

/**
 * Read a CCP4/MRC header. Little-endian mode 2 only, and only the plain
 * x/y/z axis order: a permuted map would need its data transposed as well as
 * its header rewritten, and no map this product ships is permuted.
 */
export function parseMapHeader(bytes: Buffer): MapHeader {
  if (bytes.length < MAP_HEADER_BYTES) throw Error(`A CCP4/MRC map is at least ${MAP_HEADER_BYTES} bytes; this is ${bytes.length}.`);
  const magic = bytes.subarray(208, 212).toString('ascii');
  if (magic.trim() !== 'MAP') throw Error(`This is not a CCP4/MRC map: the magic reads ${JSON.stringify(magic)}, not "MAP ".`);
  const machst = [bytes.readUInt8(212), bytes.readUInt8(213)];
  if (!(machst[0] === 68 && machst[1] === 65)) throw Error(`Only little-endian maps are prepared here; this one stamps ${machst.join(',')}.`);
  const mode = int32(bytes, 3);
  if (mode !== MAP_MODE_FLOAT32) throw Error(`Only MRC mode 2 (float32) is prepared here; this map is mode ${mode}.`);
  const axisOrder = [int32(bytes, 16), int32(bytes, 17), int32(bytes, 18)] as const;
  if (axisOrder[0] !== 1 || axisOrder[1] !== 2 || axisOrder[2] !== 3)
    throw Error(`This map's axes run ${axisOrder.join('/')}; only the plain 1/2/3 order is prepared here.`);
  const header: MapHeader = {
    columns: int32(bytes, 0), rows: int32(bytes, 1), sections: int32(bytes, 2),
    mode,
    columnStart: int32(bytes, 4), rowStart: int32(bytes, 5), sectionStart: int32(bytes, 6),
    sampling: [int32(bytes, 7), int32(bytes, 8), int32(bytes, 9)],
    cell: [float32(bytes, 10), float32(bytes, 11), float32(bytes, 12)],
    angles: [float32(bytes, 13), float32(bytes, 14), float32(bytes, 15)],
    axisOrder,
    min: float32(bytes, 19), max: float32(bytes, 20), mean: float32(bytes, 21),
    spacegroup: int32(bytes, 22), symmetryBytes: int32(bytes, 23),
    origin: [float32(bytes, 49), float32(bytes, 50), float32(bytes, 51)],
    rms: float32(bytes, 54),
    label: bytes.subarray(224, 224 + LABEL_BYTES).toString('ascii').replace(/\0/gu, ' ').trimEnd(),
  };
  if (header.sampling.some(value => value <= 0)) throw Error('This map divides its unit cell into no samples.');
  if (header.cell.some(value => !(value > 0))) throw Error('This map has no unit cell, so its voxels have no size.');
  return header;
}

/** The angstrom size of one voxel, along each cartesian axis. */
export function mapVoxelSize(header: MapHeader): [number, number, number] {
  return [header.cell[0] / header.sampling[0], header.cell[1] / header.sampling[1], header.cell[2] / header.sampling[2]];
}

/**
 * Where sample (0,0,0) sits, in angstroms.
 *
 * Mol*'s own reader (`mol-model-formats/volume/ccp4.js:getCcp4Origin`) takes
 * the ORIGIN records when any of them is non-zero and falls back to
 * N[CRS]START otherwise, so this says the same thing in cartesian terms.
 */
export function mapSampleOrigin(header: MapHeader): [number, number, number] {
  const voxel = mapVoxelSize(header);
  if (header.origin.some(value => value !== 0)) return [header.origin[0], header.origin[1], header.origin[2]];
  return [header.columnStart * voxel[0], header.rowStart * voxel[1], header.sectionStart * voxel[2]];
}

/** The voxels, in the file's column-fastest order. */
export function readMapValues(bytes: Buffer, header: MapHeader): Float32Array {
  const count = header.columns * header.rows * header.sections;
  const offset = MAP_HEADER_BYTES + header.symmetryBytes;
  if (bytes.length < offset + count * 4) throw Error(`This map is truncated: ${bytes.length} bytes hold fewer than the ${count} voxels its header declares.`);
  // A Buffer's own memory is rarely 4-byte aligned, so the float view is taken
  // over a copy rather than over the read buffer.
  const aligned = Buffer.allocUnsafe(count * 4);
  bytes.copy(aligned, 0, offset, offset + count * 4);
  return new Float32Array(aligned.buffer, aligned.byteOffset, count);
}

export type MapCrop = { start: readonly [number, number, number]; size: readonly [number, number, number] };
export type PrepareMapOptions = { downsample?: number; crop?: MapCrop; label?: string };

const voxelStats = (values: Float32Array): { min: number; max: number; mean: number; rms: number } => {
  let min = Infinity, max = -Infinity, sum = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const mean = sum / values.length;
  let squares = 0;
  for (let index = 0; index < values.length; index++) squares += (values[index] - mean) ** 2;
  return { min, max, mean, rms: Math.sqrt(squares / values.length) };
};

/**
 * Crop, mean-downsample and re-frame a parsed map. Pure: no file is read or
 * written here, which is what makes the header math testable on a synthetic
 * map small enough to build in a unit test.
 */
export function prepareMap(source: PreparedMap, options: PrepareMapOptions = {}): PreparedMap {
  const factor = options.downsample ?? 1;
  if (!Number.isInteger(factor) || factor < 1) throw Error(`A downsample factor is a whole number of voxels per output voxel; got ${factor}.`);
  const { header, values } = source;
  const extent = [header.columns, header.rows, header.sections] as const;
  const start = options.crop?.start ?? [0, 0, 0];
  const size = options.crop?.size ?? extent;
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isInteger(start[axis]) || start[axis] < 0) throw Error(`A crop starts at whole non-negative voxel indices; got ${start.join(',')}.`);
    if (!Number.isInteger(size[axis]) || size[axis] < factor) throw Error(`A crop must be at least one output voxel (${factor}) wide on every axis; got ${size.join(',')}.`);
    if (start[axis] + size[axis] > extent[axis]) throw Error(`A crop of ${size.join(',')} at ${start.join(',')} reaches outside this ${extent.join('x')} map.`);
  }
  // A partial block at the far edge is dropped rather than averaged over
  // fewer voxels: a block of a different width is a voxel of a different size,
  // and the header can only describe one.
  const out = [Math.floor(size[0] / factor), Math.floor(size[1] / factor), Math.floor(size[2] / factor)] as const;
  const prepared = new Float32Array(out[0] * out[1] * out[2]);
  const block = factor ** 3;
  for (let section = 0; section < out[2]; section++) {
    for (let row = 0; row < out[1]; row++) {
      for (let column = 0; column < out[0]; column++) {
        let sum = 0;
        for (let dz = 0; dz < factor; dz++) {
          for (let dy = 0; dy < factor; dy++) {
            const base = ((start[2] + section * factor + dz) * extent[1] + (start[1] + row * factor + dy)) * extent[0] + start[0] + column * factor;
            for (let dx = 0; dx < factor; dx++) sum += values[base + dx];
          }
        }
        prepared[(section * out[1] + row) * out[0] + column] = sum / block;
      }
    }
  }

  const voxel = mapVoxelSize(header);
  const sourceOrigin = mapSampleOrigin(header);
  const scaled: [number, number, number] = [voxel[0] * factor, voxel[1] * factor, voxel[2] * factor];
  // The crop offset plus the half-block shift of a mean. See the file header.
  const shift = (factor - 1) / 2;
  const origin: [number, number, number] = [
    sourceOrigin[0] + (start[0] + shift) * voxel[0],
    sourceOrigin[1] + (start[1] + shift) * voxel[1],
    sourceOrigin[2] + (start[2] + shift) * voxel[2],
  ];
  const stats = voxelStats(prepared);
  return {
    values: prepared,
    header: {
      columns: out[0], rows: out[1], sections: out[2],
      mode: MAP_MODE_FLOAT32,
      // The output cell is exactly the output box, so its sampling is the
      // extent and `cell / sampling` is the new voxel size by construction.
      // The origin travels in the ORIGIN records instead of N*START, because
      // a half-block shift is not a whole number of voxels.
      columnStart: 0, rowStart: 0, sectionStart: 0,
      sampling: [out[0], out[1], out[2]],
      cell: [out[0] * scaled[0], out[1] * scaled[1], out[2] * scaled[2]],
      angles: header.angles,
      axisOrder: [1, 2, 3],
      ...stats,
      spacegroup: header.spacegroup, symmetryBytes: 0,
      origin,
      label: options.label ?? header.label,
    },
  };
}

/** The prepared map as CCP4/MRC bytes: a 1024-byte header and its voxels. */
export function encodeMap({ header, values }: PreparedMap): Buffer {
  const count = header.columns * header.rows * header.sections;
  if (values.length !== count) throw Error(`This header declares ${count} voxels and ${values.length} were supplied.`);
  const bytes = Buffer.alloc(MAP_HEADER_BYTES + count * 4);
  const writeInt = (word: number, value: number) => bytes.writeInt32LE(value, word * 4);
  const writeFloat = (word: number, value: number) => bytes.writeFloatLE(value, word * 4);
  writeInt(0, header.columns); writeInt(1, header.rows); writeInt(2, header.sections);
  writeInt(3, MAP_MODE_FLOAT32);
  writeInt(4, header.columnStart); writeInt(5, header.rowStart); writeInt(6, header.sectionStart);
  header.sampling.forEach((value, axis) => writeInt(7 + axis, value));
  header.cell.forEach((value, axis) => writeFloat(10 + axis, value));
  header.angles.forEach((value, axis) => writeFloat(13 + axis, value));
  header.axisOrder.forEach((value, axis) => writeInt(16 + axis, value));
  writeFloat(19, header.min); writeFloat(20, header.max); writeFloat(21, header.mean);
  writeInt(22, header.spacegroup); writeInt(23, 0);
  header.origin.forEach((value, axis) => writeFloat(49 + axis, value));
  bytes.write('MAP ', 208, 'ascii');
  bytes.writeUInt8(68, 212); bytes.writeUInt8(65, 213);
  writeFloat(54, header.rms);
  writeInt(55, 1);
  bytes.write(header.label.slice(0, LABEL_BYTES).padEnd(LABEL_BYTES, ' '), 224, 'ascii');
  Buffer.from(values.buffer, values.byteOffset, count * 4).copy(bytes, MAP_HEADER_BYTES);
  return bytes;
}

/** Parse whatever a `.map` or `.map.gz` download holds. */
export function readMap(bytes: Buffer): PreparedMap {
  const plain = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 2_147_483_648 }) : bytes;
  const header = parseMapHeader(plain);
  return { header, values: readMapValues(plain, header) };
}

export function describeMap(header: MapHeader): string {
  const voxel = mapVoxelSize(header);
  const origin = mapSampleOrigin(header);
  return [
    `  grid ${header.columns} x ${header.rows} x ${header.sections}`,
    `  voxel ${voxel.map(value => value.toFixed(3)).join(' x ')} A`,
    `  cell ${header.cell.map(value => value.toFixed(2)).join(' x ')} A`,
    `  sample (0,0,0) at ${origin.map(value => value.toFixed(3)).join(', ')} A`,
    `  values min ${header.min.toFixed(3)} max ${header.max.toFixed(3)} mean ${header.mean.toFixed(5)} rms ${header.rms.toFixed(4)}`,
  ].join('\n');
}

export const usage = `Usage: pnpm --dir plugin exec tsx scripts/prepare-map.ts <in .map|.map.gz> <out .map> [options]

  --downsample <n>              mean-downsample by n voxels per axis (default 1)
  --crop <x,y,z,nx,ny,nz>       keep this box of the deposited grid, in voxels
  --label <text>                the 80-character MRC label of the output
  --help

Writes the prepared map and a <out>.sha256 sidecar holding its digest.`;

export function parsePrepareArgs(argv: readonly string[]): { input: string; output: string } & PrepareMapOptions {
  const positional: string[] = [];
  let downsample = 1, crop: MapCrop | undefined, label: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const value = argv[++index];
    if (value == null) throw Error(`${argument} needs a value.`);
    if (argument === '--downsample') downsample = Number(value);
    else if (argument === '--label') label = value;
    else if (argument === '--crop') {
      const numbers = value.split(',').map(Number);
      if (numbers.length !== 6 || numbers.some(number => !Number.isInteger(number)))
        throw Error('--crop takes six whole numbers: x,y,z,nx,ny,nz.');
      crop = { start: [numbers[0], numbers[1], numbers[2]], size: [numbers[3], numbers[4], numbers[5]] };
    } else throw Error(`Unknown option ${argument}.`);
  }
  if (positional.length !== 2) throw Error('Pass one input map and one output path.');
  return { input: positional[0], output: positional[1], downsample, crop, label };
}

export async function main(argv: readonly string[], log: (message: string) => void = message => process.stdout.write(`${message}\n`)): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { log(usage); return 0; }
  const { input, output, ...options } = parsePrepareArgs(argv);
  const downloaded = await readFile(resolve(input));
  log(`prepare-map · ${input}`);
  log(`  download sha256 ${createHash('sha256').update(downloaded).digest('hex')}`);
  const source = readMap(downloaded);
  log('deposited map');
  log(describeMap(source.header));
  const prepared = prepareMap(source, options);
  log(`prepared map · downsample ${options.downsample ?? 1}${options.crop ? ` · crop ${options.crop.size.join('x')} at ${options.crop.start.join(',')}` : ''}`);
  log(describeMap(prepared.header));
  const bytes = encodeMap(prepared);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(output), bytes, { mode: 0o600 });
  await writeFile(`${resolve(output)}.sha256`, `${sha256}  ${output.split('/').pop()}\n`, { mode: 0o600 });
  log(`  wrote ${bytes.length} bytes`);
  log(`  sha256 ${sha256}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exit(1); }
}

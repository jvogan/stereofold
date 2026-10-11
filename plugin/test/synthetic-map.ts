/**
 * A real CCP4/MRC map, small enough to sit inside a test.
 *
 * The `filament` tier's own map is 8.39 MB, cached rather than committed, and
 * downloaded from EMDB. No test reads it. This builds the same header the
 * product's `assertCcp4Map` checks and `Mol*`'s `ParseCcp4` reads — grid extent
 * in words 1-3, mode 2 for float32, no extended header, `MAP ` at offset 208 —
 * over a grid small enough that the whole file is a few kilobytes. The one
 * property that matters for both is the identity `assertCcp4Map` turns on:
 * 1,024 bytes of header plus exactly one float32 per voxel, and nothing else.
 */
export function syntheticMap(side = 8, edit?: (bytes: Buffer) => void): Buffer {
  const bytes = Buffer.alloc(1024 + side * side * side * 4);
  bytes.writeInt32LE(side, 0); bytes.writeInt32LE(side, 4); bytes.writeInt32LE(side, 8);
  bytes.writeInt32LE(2, 12); // mode 2: float32.
  bytes.writeInt32LE(0, 92); // nsymbt: no extended header.
  bytes.write('MAP ', 208, 'latin1');
  // A varying field rather than zeros, so a contour has something to cut and a
  // truncation changes the digest rather than leaving a run of identical bytes.
  for (let voxel = 0; voxel < side * side * side; voxel++) {
    bytes.writeFloatLE(Math.sin(voxel) * 4, 1024 + voxel * 4);
  }
  if (edit) edit(bytes);
  return bytes;
}

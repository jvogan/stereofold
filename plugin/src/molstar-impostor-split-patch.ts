/**
 * Measurement-only builds that separate the two costs of a sphere impostor.
 *
 * The impostor fragment shader both discards (outside the sphere, and in the
 * transparency and LOD checks) and writes `gl_FragDepth`. Either can stop a
 * GPU from rejecting hidden fragments before shading. Each split keeps one:
 *
 * - `discard`: discards as before; the depth write is removed, so depth is
 *   the quad's rasterized depth and atoms intersect as flat discs.
 * - `depth`: writes depth as before; nothing discards. A fragment that misses
 *   the sphere writes the far plane, which a `LESS` test against the cleared
 *   buffer never passes, so the image is the stock one for opaque spheres.
 * - `neither`: no discard and no depth write; quad corners are drawn.
 *
 * None of these is a rendering candidate. They exist to time the three cases
 * on a headset against the stock impostor.
 */

export type ImpostorSplit = 'discard' | 'depth' | 'neither';

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  anchor = anchor.replaceAll('\n', nl); replacement = replacement.replaceAll('\n', nl);
  if (source.split(anchor).length !== 2) throw Error('Mol* impostor split source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

/** mol-gl/shader/spheres.frag.js, after the impostor scale transform. */
export function patchMolstarImpostorSplitSource(source: string, split: ImpostorSplit): string {
  if (split === 'depth' || split === 'neither') {
    source = replaceOnce(source, `        if (!hit) discard;

        if (fragmentDepth < 0.0) discard;
        if (fragmentDepth > 1.0) discard;
`, `        if (!hit || fragmentDepth < 0.0 || fragmentDepth > 1.0) fragmentDepth = 1.0;
`);
    source = replaceOnce(source, '    #include fade_lod\n', '');
    source = replaceOnce(source, '    #include check_transparency\n', '');
  }
  if (split === 'discard' || split === 'neither')
    source = replaceOnce(source, '        gl_FragDepthEXT = fragmentDepth;\n', '');
  return source;
}

/** Unset is off; any other value must name a split. Scratch builds only. */
export function impostorSplitSetting(value: string | undefined): ImpostorSplit | null {
  if (value === undefined || value === '' || value === 'off') return null;
  if (value === 'discard' || value === 'depth' || value === 'neither') return value;
  throw Error('STEREOFOLD_IMPOSTOR_SPLIT must be discard, depth, neither or off.');
}

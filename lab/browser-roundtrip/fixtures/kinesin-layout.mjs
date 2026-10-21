// CPU projection of the prepared demo coordinates; no browser or GPU claim.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { evaluateTrack } from '../../../packages/motion/src/keyframes.mjs';
import { poseMatrix } from '../molecular-animation.mjs';
import { drawnPlateRects, screenRectFromPoints } from '../label-layout.mjs';
import { FIGURE_REFERENCE_SCALE } from '../immersive-annotations.mjs';

export function coordinates(path, digest) {
  // Prepared composites are content-addressed; the bare name is a legacy copy.
  const addressed = path.replace(/\.cif$/, `.${digest}.cif`);
  const text = readFileSync(existsSync(addressed) ? addressed : path, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== digest) throw Error('Rebuild the demo composite cache: source digest differs.');
  // The recipe writer emits one unquoted atom row per line with these headers.
  const lines = text.split('\n'), headers = lines.filter(l => l.startsWith('_atom_site.')).map(l => l.trim().slice(11));
  const col = name => headers.indexOf(name);
  return lines.filter(l => /^(ATOM|HETATM)\s/.test(l)).map(line => {
    const r = line.trim().split(/\s+/);
    return { copyId:'["copy","asymmetric_unit",null,[]]', chain:r[col('auth_asym_id')], residue:+r[col('auth_seq_id')], atom:r[col('auth_atom_id')], component:r[col('auth_comp_id')],
      position:['x','y','z'].map(axis => +r[col('Cartn_' + axis)]) };
  });
}

const indexed = new WeakMap();
export function frame(chapter, atoms, seconds, placement = 1.738056, eyeX = 0) {
  let chains = indexed.get(atoms);
  if (!chains) {
    chains = new Map();
    for (const atom of atoms) {
      if (!chains.has(atom.chain)) chains.set(atom.chain, []);
      chains.get(atom.chain).push(atom);
    }
    indexed.set(atoms, chains);
  }
  const tracks = chapter.animation?.tracks ?? [];
  const poses = new Map(tracks.flatMap(track => {
    const pose = evaluateTrack(track, seconds);
    return track.chains.map(chain => [chain, {visible:pose.visible, matrix:poseMatrix(pose)}]);
  }));
  const shown = new Set(chapter.immersive.visibility.chains);
  const visible = chain => poses.has(chain) ? poses.get(chain).visible : shown.has(chain);
  const transform = (p, chain) => poses.has(chain) ? Array.from(Vec3.transformMat4(Vec3(), p, poses.get(chain).matrix)) : p;
  // Default front view, +Y up. The recorded walking scale is 1.738056;
  // also test unscaled placement. Convert metre-sized XR glyphs/offsets back
  // to source Å, matching sizeImmersiveAnnotation (billboards ignore scale).
  const metresPerAngstrom = .00504 * placement, gain = FIGURE_REFERENCE_SCALE / metresPerAngstrom;
  const view = {eye:[eyeX / metresPerAngstrom, 45, 6.5 / metresPerAngstrom], target:[eyeX / metresPerAngstrom,45,0], up:[0,1,0]};
  const selected = target => (chains.get(target.chain) ?? []).filter(a => (!target.residues || a.residue >= target.residues.from && a.residue <= target.residues.to)
    && (!target.atomName || a.atom === target.atomName));
  const labels = chapter.immersive.figure.labels.filter(l => visible(l.target.chain)).map(label => {
    const points = selected(label.target).map(a => a.position);
    if (!points.length) throw Error(`Missing label target ${label.id}`);
    // All tested labels use an exact CA, so this is the same anchor as Mol*.
    const anchor = points[0];
    if (points.length !== 1) throw Error(`Use a single atom for the sampled label ${label.id}`);
    return drawnPlateRects({plates:[{...label,anchor:transform(anchor,label.target.chain)}],
      placements:[{...label, offsetX:(label.offsetX ?? 0)*gain, offsetY:(label.offsetY ?? 0)*gain}],
      characterUnits:.8*6*label.sizeFactor*gain, backgroundMargin:.25,
      // Figure labels are one line, with the same conservative .55-em metrics
      // used by the existing desktop annotation regression.
      maxWidthEm:Infinity, standoff:3*gain, ...view})[0];
  });
  const bodies = [...chains.keys()].filter(chain => /^(K|NC)/.test(chain) && visible(chain)).map(chain => {
    const rect = screenRectFromPoints({points:chains.get(chain).map(a => transform(a.position,chain)),...view});
    // Include cartoon thickness beyond atom centres (2 Å in either axis).
    rect.halfWidth += 2 / view.eye[2]; rect.halfHeight += 2 / view.eye[2];
    return {id:chain,rect};
  });
  return {labels,bodies,poses,transform,visible};
}

// Rigid bodies of the walking model share their end residues: [chain, residue, chain, residue].
// A head joins its first linker piece, or its docked 8RHB linker, at 324; the
// last piece ends on a copy of the coil's first residue (human 337 = rat 339).
export function walkJoins(h, visible) {
  const head = ['T','A','D'].map(s => `K${h}${s}`).find(visible);
  return visible(`K${h}L`) ? [[head,324,`K${h}L`,324],[`K${h}L`,334,`N${h}d`,334],[`N${h}d`,337,`NC${h}`,339]]
    : [[head,324,`N${h}a`,324],[`N${h}a`,328,`N${h}b`,328],[`N${h}b`,331,`N${h}c`,331],[`N${h}c`,334,`N${h}d`,334],[`N${h}d`,337,`NC${h}`,339]];
}

// Every keyframe interval's midpoint, in every track, and a sweep every `step` seconds.
export function denseTimes(chapter, step = .01) {
  const a = chapter.animation, times = new Set();
  for (let i = 0; i * step <= a.durationSeconds + 1e-9; i++) times.add(Math.min(a.durationSeconds, +(i * step).toFixed(6)));
  for (const track of a.tracks) for (let i = 1; i < track.keyframes.length; i++)
    times.add((track.keyframes[i-1].t + track.keyframes[i].t) / 2);
  return [...times].sort((x, y) => x - y);
}

/** Heavy-atom pairs closer than `limit` between bodies that can move apart.
 * Not counted: bodies that never move relative to each other (one track, or
 * both static), duplicate joint residues and their directly bonded neighbours,
 * and atom/residue contacts present at the deposited bound-head/tubulin
 * interface. Pairs two residues apart across a joint count. The free 1BG2
 * head counts everywhere. */
export function walkClashes(chapter, atoms, limit = 2.5) {
  const trackOf = new Map(chapter.animation.tracks.flatMap(t => t.chains.map(c => [c, t])));
  const chains = [...new Set(atoms.map(a => a.chain))], index = new Map(chains.map((c, i) => [c, i]));
  const bound = c => /^K[12][TAL]$/.test(c), lattice = c => /^T[AB]/.test(c);
  // Only atom/residue contacts present in a deposited bound copy's initial
  // placement are permitted. A bound-state name is not a blanket exemption
  // for the whole lattice (or for novel contacts during interpolation).
  const interfaceContacts = new Map();
  const contactKey = (a,b) => `${a.chain}:${a.residue}:${a.atom}|${b.chain.slice(0,2)}:${b.residue}:${b.atom}`;
  const latticeAtoms = atoms.filter(a => lattice(a.chain));
  for (const c of chains.filter(bound)) {
    const track = trackOf.get(c), time = track.visibility?.find(v => v.visible)?.t ?? 0;
    const matrix = poseMatrix(evaluateTrack(track,time));
    for (const a of atoms.filter(a => a.chain === c)) {
      const p = Vec3.transformMat4(Vec3(),a.position,matrix);
      for (const b of latticeAtoms) {
        const distance = Vec3.distance(p,b.position), key = contactKey(a,b);
        if (distance < Math.min(limit,2.5)) interfaceContacts.set(key,Math.min(interfaceContacts.get(key) ?? Infinity,distance));
      }
    }
  }
  const exempt = chains.map(c1 => chains.map(c2 => c1 === c2 || trackOf.get(c1) === trackOf.get(c2)));
  const key = (x, y, z) => ((Math.floor(x / limit) + 512) * 1024 + Math.floor(y / limit) + 512) * 1024 + Math.floor(z / limit) + 512;
  const insert = (grid, k, i) => { const list = grid.get(k); if (list) list.push(i); else grid.set(k, [i]); };
  // Bodies without a track never move: grid them once.
  const still = new Map(), moving = [];
  atoms.forEach((a, i) => trackOf.has(a.chain) ? moving.push(i) : insert(still, key(...a.position), i));
  const world = atoms.map(a => [...a.position]), p = Vec3();
  return seconds => {
    const poses = new Map(chapter.animation.tracks.flatMap(t => {
      const pose = evaluateTrack(t, seconds); return t.chains.map(c => [c, {visible:pose.visible, matrix:poseMatrix(pose)}]);
    }));
    const visible = c => poses.has(c) ? poses.get(c).visible : true;
    const joins = [1,2].flatMap(h => walkJoins(h, visible));
    const nearJoin = (c1, r1, c2, r2) => joins.some(([a, ra, b, rb]) =>
      (a === c1 && b === c2 && Math.abs(r1 - ra) <= 1 && Math.abs(r2 - rb) <= 1 && Math.abs((r1-ra)-(r2-rb)) <= 1) || (a === c2 && b === c1 && Math.abs(r2 - ra) <= 1 && Math.abs(r1 - rb) <= 1 && Math.abs((r2-ra)-(r1-rb)) <= 1));
    const grid = new Map(), out = [];
    for (const i of moving) {
      const c = atoms[i].chain, pose = poses.get(c); if (!pose.visible) continue;
      Vec3.transformMat4(p, atoms[i].position, pose.matrix); world[i][0] = p[0]; world[i][1] = p[1]; world[i][2] = p[2];
      insert(grid, key(p[0], p[1], p[2]), i);
    }
    const check = (i, j) => {
      const a = atoms[i], b = atoms[j];
      if (exempt[index.get(a.chain)][index.get(b.chain)]) return;
      const d = Math.hypot(world[i][0]-world[j][0], world[i][1]-world[j][1], world[i][2]-world[j][2]);
      if (d >= limit) return;
      const depositedContact = bound(a.chain) && lattice(b.chain) && d >= (interfaceContacts.get(contactKey(a,b)) ?? Infinity) - .01
        || bound(b.chain) && lattice(a.chain) && d >= (interfaceContacts.get(contactKey(b,a)) ?? Infinity) - .01;
      if (!depositedContact && !nearJoin(a.chain, a.residue, b.chain, b.residue))
        out.push({a:`${a.chain}:${a.residue}:${a.atom}`, b:`${b.chain}:${b.residue}:${b.atom}`, distance:d});
    };
    for (const [k, members] of grid) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = k + (dx * 1024 + dy) * 1024 + dz, other = grid.get(n), fixed = still.get(n);
      for (const i of members) {
        if (other) for (const j of other) if (j > i) check(i, j);
        if (fixed) for (const j of fixed) check(i, j);
      }
    }
    return out;
  };
}

// Where a walking-kinesin plate may overlap a body. A head plate may cross a
// linker piece, the neck coil or the stalk for a moment (bounded by the
// tests). When ATP binds a head (its T copy appears), the other head is still
// waiting free behind it, where the bound head's plate stands for the rest of
// the walk; that plate may cover the waiting head until it swings past.
export const WAITING_SECONDS = .8;
export function walkPlateAllowance(chapter) {
  const tracks = chapter.animation?.tracks ?? [];
  const binds = h => (tracks.find(t => t.id === `k${h}t`)?.visibility ?? []).filter(v => v.visible && v.t > 0).map(v => v.t);
  return (labelId, bodyId, t) => {
    const head = /^k([12])[tad]-name$/.exec(labelId)?.[1];
    if (!head) return false;
    if (/^(N[12][a-d]|NC[12]|ST[12])$/.test(bodyId)) return 'crossing';
    const other = head === '1' ? '2' : '1';
    if (labelId === `k${head}t-name` && bodyId === `K${other}D` && binds(head).some(at => t >= at && t - at <= WAITING_SECONDS)) return 'waiting';
    return false;
  };
}

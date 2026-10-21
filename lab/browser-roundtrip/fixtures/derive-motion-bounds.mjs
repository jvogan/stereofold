// Reproduce source-space framing evidence from prepared demo composites.
// node lab/browser-roundtrip/fixtures/derive-motion-bounds.mjs COORDINATES_DIR OUTPUT.json
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CIF } from 'molstar/lib/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif.js';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure.js';
import { animationEnvelope, poseMatrix, transformSphere } from '../molecular-animation.mjs';
import { selectAnimationTrack } from '../animation-selection.mjs';
import { resolveFigureLoci } from '../lesson-figure.mjs';
import { evaluateTrack } from '../../../packages/motion/src/keyframes.mjs';
import { readCachedDemoCoordinates } from '../demo-cache.mjs';

const demos = [ ['kinesin-walk', 'kinesin-walk-motion.cif'],
  ['atp-synthase-rotor', 'atp-synthase-rotor-motion.cif'], ['hemoglobin-switch', 'hemoglobin-tr-motion.cif'] ];
const result = [];
for (const [demo, file] of demos) {
  const text = readCachedDemoCoordinates(demo, 'motion', { cache: resolve(process.argv[2]) });
  const parsed = await CIF.parse(text).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const source = Structure.ofModel(trajectory.representative);
  const lessonText = readFileSync(new URL(`../../../plugin/demos/${demo}/motion.json`, import.meta.url), 'utf8');
  const lesson = JSON.parse(lessonText);
  if (createHash('sha256').update(text).digest('hex') !== lesson.provenance.sourceSha256)
    throw Error(`${demo}: composite does not match the lesson source identity`);
  for (const chapter of lesson.chapters) {
    const im = chapter.immersive, animation = chapter.animation;
    if (!animation) continue;
    const targets = [...(im.figure?.focus ?? []), ...(im.emphasis?.parts ?? [])
      .filter(part => (im.emphasis.focus ?? []).includes(part.id))];
    const focus = targets.reduce((loci, target) => StructureElement.Loci.union(loci, resolveFigureLoci(target, source)), StructureElement.Loci.none(source));
    const raw = animationEnvelope(source, animation, { movingOnly: true, focus });
    const target = { center: raw.center, radius: raw.radius * 1.1 };
    const travel = animation.tracks.map(track => {
      const sphere = StructureElement.Loci.getBoundingSphere(selectAnimationTrack(source, track));
      const times = new Set(track.keyframes.map(frame => frame.t));
      for (let i = 1; i < track.keyframes.length; i++) for (let j = 1; j < 4; j++)
        times.add(track.keyframes[i-1].t + (track.keyframes[i].t - track.keyframes[i-1].t) * j / 4);
      return { id: track.id, poses: [...times].map(time => transformSphere(sphere, poseMatrix(evaluateTrack(track, time)))) };
    });
    result.push({ demo, chapter: chapter.id, composite: file,
      sha256: createHash('sha256').update(text).digest('hex'),
      lessonSha256: createHash('sha256').update(lessonText).digest('hex'), atoms: source.elementCount,
      source: source.boundary.sphere, whole: animationEnvelope(source, animation), target, travel });
  }
}
writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');

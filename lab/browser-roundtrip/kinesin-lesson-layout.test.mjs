import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleTimes, prepareLabelScene, labelFrame, plateGaps, demoSeats } from './fixtures/motion-label-layout.mjs';
import { coordinates, frame, walkJoins, denseTimes, walkClashes, walkPlateAllowance } from './fixtures/kinesin-layout.mjs';
import { platesOverlap, countPlateOverlaps, PLATE_FIELD } from './label-layout.mjs';
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { poseMatrix } from './molecular-animation.mjs';

const lesson = stage => JSON.parse(readFileSync(new URL(`../../plugin/demos/kinesin-walk/${stage}.json`,import.meta.url),'utf8'));
const cache = process.env.STEREOFOLD_DEMO_CACHE;
const motion = lesson('motion'), flipbook = lesson('flipbook'), cycle = lesson('cycle');

test('kinesin opens with motion within one second and keeps scientific limitations', () => {
  const first = motion.chapters[0];
  assert.equal(first.id,'two-steps');
  assert.equal(first.animation.playback.autoplay,true);
  // The walk ends both heads bound two steps on and holds there; a replay
  // would jump the dimer 16.3 nm back along a still lattice.
  assert.equal(first.animation.playback.loop,false);
  assert.equal(first.animation.durationSeconds,7,'two steps in about seven seconds');
  // The rear head lets go at 0.35 s and is visibly swinging before 0.75 s.
  const free = first.animation.tracks.find(t => t.id === 'k1d'), edge = Vec3.add(Vec3(),free.pivot,[20,0,0]);
  const at = t => Vec3.transformMat4(Vec3(),edge,poseMatrix(evaluateTrack(free,t)));
  assert.ok(Vec3.distance(at(.35),at(.75)) > 10);
  assert.match(first.caption,/illustrative/);
  assert.match(motion.provenance.note,/AMP-PNP stands in for ATP/);
  for (const d of [motion,flipbook,cycle]) for (const c of d.chapters)
    for (const plate of [...c.immersive.figure.labels,...c.immersive.figure.distances]) assert.ok(plate.sizeFactor >= 1.1);
});

test('the forward walk has no seamless loop seam on its fixed lattice', () => {
  const animation=motion.chapters[0].animation;
  for(const id of ['k1t','k2a','neck']) {
    const track=animation.tracks.find(t=>t.id===id);
    const start=evaluateTrack(track,0),end=evaluateTrack(track,animation.durationSeconds);
    assert.ok(Vec3.distance(start.translation,end.translation)>160,`${id} advances more than 16 nm`);
  }
  assert.ok(!animation.tracks.some(t=>t.chains.some(c=>/^T[AB]/.test(c))),'the lattice stays fixed');
  assert.equal(animation.playback.loop,false,'a modulo-clock repeat would teleport the dimer back');
});

test('the walking dimer stays one molecule within its linker reach', {skip:!cache}, () => {
  const atoms = coordinates(`${cache}/kinesin-walk-motion.cif`,motion.provenance.sourceSha256);
  const chapter = motion.chapters[0];
  const bare = {...chapter, immersive:{...chapter.immersive, figure:{...chapter.immersive.figure, labels:[]}}};
  const ca = new Map(atoms.filter(a => a.atom === 'CA').map(a => [`${a.chain}:${a.residue}`,a.position]));
  // A head changes copy (state) in one millisecond, and its first linker piece
  // steps with it; that is the only place a joint may open.
  const swaps = chapter.animation.tracks.filter(t => /^k[12][tad]$/.test(t.id)).flatMap(t => (t.visibility ?? []).map(v => [t.chains[0],v.t]));
  const stepping = (chain,t) => swaps.some(([c,at]) => c === chain && at - t > 0 && at - t <= .001);
  // Every keyframe interval's midpoint, in every track, and a 10 ms sweep.
  for (const t of denseTimes(chapter)) {
    const f = frame(bare,atoms,t), at = (chain,residue) => f.transform(ca.get(`${chain}:${residue}`),chain);
    for (const h of [1,2]) {
      const heads = ['T','A','D'].map(s => `K${h}${s}`).filter(f.visible);
      assert.equal(heads.length,1,`one head ${h} at ${t}`);
      for (const [c1,r1,c2,r2] of walkJoins(h,f.visible)) {
        assert.ok(f.visible(c1) && f.visible(c2),`${c1}-${c2} drawn at ${t}`);
        if (stepping(c1,t)) continue;
        assert.ok(Vec3.distance(at(c1,r1),at(c2,r2)) < 1.5,`${c1}-${c2} joint at ${t}`);
      }
      assert.ok(Vec3.distance(at(heads[0],324),at(`NC${h}`,339)) <= .85*13*3.8,`linker ${h} span at ${t}`);
    }
  }
});

test('no two parts of the walk pass through each other, swept every 10 ms', {skip:!cache}, () => {
  const atoms = coordinates(`${cache}/kinesin-walk-motion.cif`,motion.provenance.sourceSha256);
  const chapter = motion.chapters[0], clashes = walkClashes(chapter,atoms,2.5);
  for (let i = 0; i <= 700; i++) {
    const t = i / 100, found = clashes(t);
    assert.deepEqual(found.slice(0,3),[],`${found.length} heavy-atom pairs under 2.5 Å at ${t} s`);
  }
});

test('walking plates clear the motor and each other every 0.1 s, at swaps and across replay', {skip:!cache}, () => {
  const atoms = coordinates(`${cache}/kinesin-walk-motion.cif`,motion.provenance.sourceSha256);
  const chapter = motion.chapters[0], scene = prepareLabelScene(chapter,atoms), seat = demoSeats['kinesin-walk'];
  const allow = walkPlateAllowance(chapter), crossing = new Map(chapter.immersive.figure.labels.map(l => [l.id,new Set()]));
  for(const placement of [1,seat.placement]) for(const eye of [-.032,.032]) for(const t of sampleTimes(chapter)) {
    const f = labelFrame(scene,seat,t,placement,eye);
    assert.equal(f.labels.length,5,`one plate per head, the coil, the plus end and the track at ${t}`);
    for (const h of [1,2]) assert.equal(f.labels.filter(l => l.id.startsWith(`k${h}`)).length,1,`one head ${h} plate at ${t}`);
    assert.equal(countPlateOverlaps(f.labels),0,`plate collision at ${t}, scale ${placement}`);
    for(const {rect} of f.labels) {
      assert.ok(Math.abs(rect.x)+rect.halfWidth<=PLATE_FIELD.halfWidth,'plate stays inside horizontal field');
      assert.ok(Math.abs(rect.y)+rect.halfHeight<=PLATE_FIELD.halfHeight,'plate stays inside vertical field');
    }
    // No plate covers tubulin or a head, apart from the waiting free head
    // just after ATP binds; head plates may cross a linker, the coil or the stalk.
    for(const label of f.labels) for(const body of f.bodies) if (platesOverlap(label,body)) {
      const allowed = allow(label.id,body.id,t);
      assert.ok(allowed,`${label.id} covers ${body.id} at ${t}, scale ${placement}`);
      if (allowed === 'crossing') crossing.get(label.id).add(Math.round(t*10));
    }
  }
  // A crossing is brief: at most 1.3 s of the walk for each plate.
  for (const [id,bins] of crossing) assert.ok(bins.size <= 13,`${id} crosses linkers or the coil for ${bins.size/10} s`);
});

test('each head plate stays on its head and above the lattice edge, front and 60° to each side', {skip:!cache}, () => {
  const atoms = coordinates(`${cache}/kinesin-walk-motion.cif`,motion.provenance.sourceSha256);
  const chapter = motion.chapters[0], scene = prepareLabelScene(chapter,atoms), seat = demoSeats['kinesin-walk'];
  const swaps = chapter.animation.tracks.flatMap(t => (t.visibility ?? []).map(v => v.t)).filter(t => t > 0);
  const times = [...new Set([...Array.from({length:71},(_,i) => i/10), ...swaps.flatMap(t => [t-.001,t+.001])])];
  let worst = 0;
  for (const yaw of [-Math.PI/3,0,Math.PI/3]) for (const placement of [1,seat.placement]) for (const eye of [-.032,.032]) for (const t of times)
    for (const {id,gap,below} of plateGaps(scene,{...seat,yaw},t,placement,eye)) {
      if (!/^k[12][tad]-name$/.test(id)) continue;
      worst = Math.max(worst,gap);
      assert.ok(gap <= 45,`${id} sits ${gap.toFixed(1)} Å from its head at ${t}, yaw ${yaw}, scale ${placement}`);
      assert.ok(!below,`${id} falls below the lattice at ${t}`);
    }
  assert.ok(worst > 0);
});

test('the microtubule plate sits just under the lattice, under the walk', {skip:!cache}, () => {
  const atoms = coordinates(`${cache}/kinesin-walk-motion.cif`,motion.provenance.sourceSha256);
  const chapter = motion.chapters[0], scene = prepareLabelScene(chapter,atoms), seat = demoSeats['kinesin-walk'];
  for (const placement of [1,seat.placement]) for (const eye of [-.032,.032]) for (const t of [0,3.5,7]) {
    const f = labelFrame(scene,seat,t,placement,eye), track = f.labels.find(l => l.id === 'track-name');
    const lattice = f.bodies.filter(b => /^T/.test(b.id)), bottom = Math.min(...lattice.map(b => b.rect.y-b.rect.halfHeight));
    const left = Math.min(...lattice.map(b => b.rect.x-b.rect.halfWidth)), right = Math.max(...lattice.map(b => b.rect.x+b.rect.halfWidth));
    const top = track.rect.y+track.rect.halfHeight, depth = seat.distance/(seat.scale*placement);
    assert.ok(top <= bottom && (bottom-top)*depth <= 25,`Microtubule plate top ${((bottom-top)*depth).toFixed(1)} Å under the lattice`);
    assert.ok(track.rect.x-track.rect.halfWidth > left && track.rect.x+track.rect.halfWidth < right,'Microtubule plate stays under the lattice');
  }
});

test('every flipbook page keeps its plates beside their parts and off the molecule', {skip:!cache}, () => {
  const atoms=coordinates(`${cache}/kinesin-walk-flipbook.cif`,flipbook.provenance.sourceSha256), seat=demoSeats['kinesin-walk'];
  for(const chapter of flipbook.chapters) {
    const scene=prepareLabelScene(chapter,atoms);
    for(const yaw of [-.35,0,.35]) for(const pitch of [-.2,0,.2]) for(const placement of [1,seat.placement]) for(const eye of [-.032,.032]) {
      const f=labelFrame(scene,{...seat,yaw,pitch},0,placement,eye), view=`${chapter.id} yaw ${yaw} pitch ${pitch} at ${placement.toFixed(2)}`;
      assert.equal(countPlateOverlaps(f.labels),0,view);
      for(const label of f.labels) {
        for(const body of f.bodies) assert.ok(!platesOverlap(label,body),`${view}: ${label.id} covers ${body.id}`);
        for(const other of f.labels) assert.ok(other===label || !platesOverlap(label,{rect:other.anchorRect}),`${view}: ${label.id} covers the anchor of ${other.id}`);
        if(placement===seat.placement) assert.ok(Math.abs(label.rect.x)+label.rect.halfWidth<=PLATE_FIELD.halfWidth
          && Math.abs(label.rect.y)+label.rect.halfHeight<=PLATE_FIELD.halfHeight,`${view}: ${label.id} leaves the field`);
      }
    }
    // A head's plate stays beside that head, never under the lattice, from the front and 60° to either side.
    for(const yaw of [-Math.PI/3,0,Math.PI/3]) for(const placement of [1,seat.placement]) for(const eye of [-.032,.032])
      for(const {id,gap,below} of plateGaps(scene,{...seat,yaw},0,placement,eye,/^[AB]\d$/)) if(/^k[12][tad]\d-name$/.test(id)) {
        assert.ok(gap<=45,`${chapter.id}: ${id} sits ${gap.toFixed(0)} Å from its head at yaw ${yaw.toFixed(2)}`);
        assert.ok(!below,`${chapter.id}: ${id} drops under the lattice`);
      }
    // A readout between two sites would sit on the bound heads; there the caption carries the figure.
    for(const d of chapter.immersive.figure.distances) assert.equal(d.showText!==false,chapter.id==='track',`${chapter.id} ${d.id}`);
  }
});

// The lesson-wide colour key repeats a part on every page that shows it, so a
// head that holds still between pages is one copy with one name.
test('flipbook pages share a copy that has not moved and caption what the copies measure', {skip:!cache}, () => {
  const atoms=coordinates(`${cache}/kinesin-walk-flipbook.cif`,flipbook.provenance.sourceSha256);
  const ca=chain=>new Map(atoms.filter(a=>a.chain===chain&&a.atom==='CA').map(a=>[a.residue,a.position]));
  const moved=(a,b)=>{const p=ca(a),q=ca(b),ks=[...p.keys()].filter(k=>q.has(k));return ks.reduce((s,k)=>s+Vec3.distance(p.get(k),q.get(k)),0)/ks.length;};
  const centre=chains=>{const ps=atoms.filter(a=>chains.includes(a.chain)).map(a=>a.position);return Vec3.scale(Vec3(),ps.reduce((s,p)=>Vec3.add(s,s,p),Vec3()),1/ps.length);};
  const page=id=>flipbook.chapters.find(c=>c.id===id).immersive.visibility.chains;
  assert.deepEqual(page('rear-lets-go').filter(c=>/^K2/.test(c)),['K2A0'],'head 2 holds still while head 1 lets go');
  assert.deepEqual(page('step-two').filter(c=>/^K1[TAD]\d$/.test(c)),['K1T5']);
  const site=i=>ca(`B${i}`).get(393), caption=id=>flipbook.chapters.find(c=>c.id===id).caption;
  assert.equal((Vec3.distance(site(0),site(1))/10).toFixed(1),'8.2');
  assert.match(caption('both-bound'),/sites 8\.2 nm apart/);
  assert.equal((moved('K1T0','K1A3')/10).toFixed(1),'16.3'); assert.equal((moved('K2T2','K2A6')/10).toFixed(1),'16.3');
  assert.match(caption('step-one'),/Head 1 moved 16\.3 nm/); assert.match(caption('step-two'),/Each head moved 16\.3 nm/);
  const coil=id=>centre(page(id).filter(c=>/^NC/.test(c)));
  assert.equal((Vec3.distance(coil('both-bound'),coil('step-one'))/10).toFixed(1),'8.2');
  assert.match(caption('step-one'),/the motor moved 8\.2 nm/);
  assert.equal((Vec3.distance(coil('both-bound'),coil('step-two'))/10).toFixed(1),'16.4');
  assert.match(caption('hand-over-hand'),/moved 16\.4 nm, about 8\.2 nm per step/);
});


test('the still overview names its six parts without covering any of them', {skip:!cache}, () => {
  const atoms=coordinates(`${cache}/kinesin-walk-motion.cif`,motion.provenance.sourceSha256);
  const still=motion.chapters[1], scene=prepareLabelScene(still,atoms), seat=demoSeats['kinesin-walk'];
  // The modelled linker runs between the coil, both heads and the lattice; every
  // plate within reach of it stands over a head and reads as that head's tag.
  // The caption discloses it instead.
  assert.ok(!still.immersive.figure.labels.some(l=>/^N2/.test(l.target.chain)),'no plate on the modelled linker');
  assert.match(still.caption,/the pale linker is modelled/);
  for(const placement of [1,seat.placement]) for(const eye of [-.032,.032]) {
    const f=labelFrame(scene,seat,0,placement,eye);
    assert.equal(f.labels.length,6);
    assert.equal(countPlateOverlaps(f.labels),0);
    for(const label of f.labels)for(const body of f.bodies)assert.ok(!platesOverlap(label,body),`${label.id} covers ${body.id}`);
  }
});


// The cycle figure is fitted to the entry view by its width, so its panels grow
// only as the gap between its two columns closes. An XR render seated it at
// 7.46 mm per Å, 3.04 m away; the check also runs 3% either side of that.
const cycleSeat = atoms => {
  const xs = atoms.map(a => a.position[0]), ys = atoms.map(a => a.position[1]);
  return {scale:.00746,placement:1,distance:3.04,center:[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2,0],
    width:Math.max(...xs)-Math.min(...xs)};
};
// The modelled stalk and linker chains hold one copy per panel; each copy is its own body.
const panelBodies = (scene, seat) => {
  const chains = new Map();
  for (const [c,points] of scene.chains) for (const p of points) {
    const id = /^(STK|LNK)/.test(c) ? `${c}#${(p[0] > seat.center[0] ? 2 : 1) + (p[1] < seat.center[1] ? 2 : 0)}` : c;
    if (!chains.has(id)) chains.set(id,[]);
    chains.get(id).push(p);
  }
  return {...scene,chains};
};

test('the cycle figure keeps its panels wide and each plate beside its head, front and 30° to each side', {skip:!cache}, () => {
  const atoms = coordinates(`${cache}/kinesin-walk-cycle.cif`,cycle.provenance.sourceSha256), chapter = cycle.chapters[0];
  const seat = cycleSeat(atoms), scene = panelBodies(prepareLabelScene(chapter,atoms),seat);
  const lattice = atoms.filter(a => a.chain === 'P1A' || a.chain === 'P1B').map(a => a.position[0]);
  assert.ok((Math.max(...lattice)-Math.min(...lattice))/seat.width >= .45,'each panel spans at least 45% of the figure width');
  const head = /^P\dH/, tags = chapter.immersive.figure.labels.filter(l => head.test(l.target.chain));
  assert.equal(tags.length,8,'both heads tagged in all four panels');
  for (const placement of [.97,1,1.03]) for (const eye of [-.032,.032]) {
    const front = labelFrame(scene,seat,0,placement,eye);
    assert.equal(countPlateOverlaps(front.labels),0);
    for (const label of front.labels) {
      for (const body of front.bodies) assert.ok(!platesOverlap(label,body),`${label.id} covers ${body.id} in front`);
      for (const other of front.labels) if (other !== label) assert.ok(!platesOverlap(label,{rect:other.anchorRect}),`${label.id} covers ${other.id}'s anchor`);
      assert.ok(Math.abs(label.rect.x)+label.rect.halfWidth <= PLATE_FIELD.halfWidth && Math.abs(label.rect.y)+label.rect.halfHeight <= PLATE_FIELD.halfHeight,`${label.id} inside the plate field`);
    }
    // Panel 2's free head and panel 4's two heads were the plates' old hiding places.
    const covers = (f,id,chain) => platesOverlap(f.labels.find(l => l.id === id),f.bodies.find(b => b.id === chain));
    assert.ok(!covers(front,'p2h1-tag','P2H1'),'panel 2 H1 tag clear of the free head');
    for (const yaw of [-Math.PI/9,Math.PI/9]) assert.equal(countPlateOverlaps(labelFrame(scene,{...seat,yaw},0,placement,eye).labels),0,`plates clear at yaw ${yaw}`);
    for (const yaw of [-Math.PI/6,Math.PI/6]) {
      const f = labelFrame(scene,{...seat,yaw},0,placement,eye);
      for (const label of f.labels) for (const body of f.bodies.filter(b => head.test(b.id)))
        assert.ok(!platesOverlap(label,body),`${label.id} behind ${body.id} at yaw ${yaw}`);
    }
  }
  for (const {id,gap} of plateGaps(scene,seat,0,1,0,/^P\d[AB]$/)) if (tags.some(t => t.id === id)) assert.ok(gap <= 32,`${id} within 32 Å of its head (${gap.toFixed(1)})`);
});

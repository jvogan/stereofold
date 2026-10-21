import {expect,it} from 'vitest';
// @ts-ignore Shared committed entry geometry fixture.
import {entryGeometry} from '../../lab/browser-roundtrip/fixtures/entry-standoff.mjs';

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {pageText} from '../src/tour-player.js';
import {molecularLessonToTour} from '../src/molecular-lesson-tour.js';

// @ts-ignore Shared JavaScript grip binding, the same one the companion bundles.
import {DEFAULT_LISTENING_TEXT,attachGripPushToTalk} from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Shared JavaScript agent-presence reading.
import {listeningStatusLine,noteAgentPresence,resetAgentPresence} from '../../lab/browser-roundtrip/agent-presence.mjs';

// Three rules, proven against the real module rather than its source text:
//   the menu must not move while the wearer is moving -> the latched seat
//   captions fill the space they are given            -> the caption window
//   nothing claims Claude is listening until a press
//
// `spatial-toolbar.mjs` pulls Mol* for its mesh and text builders, so the
// module is bundled with those replaced by the smallest stand-ins the readout
// and the seat actually touch. Nothing here needs a GPU.
const MOLSTAR_STUB=`
export const MeshBuilder={createState:()=>({currentGroup:-1}),addTriangleWithNormal:()=>{},getMesh:()=>({kind:'mesh'})};
export const Mesh={Utils:{kind:'mesh'}};
export const TextBuilder={create:()=>({add(){},getText(){const cell=()=>({ref:{value:new Float32Array(0)}});return {kind:'text',charCount:0,centerBuffer:cell(),mappingBuffer:cell(),groupBuffer:cell()};}})};
export const Text={Utils:{kind:'text'}};
export const Shape={create:()=>({})};
export const ShapeRepresentation=()=>({renderObjects:[],visible:true,createOrUpdate:()=>({async run(){}}),setState(){},destroy(){}});
export const Color=value=>value;
export const getFontAtlas=()=>({buffer:0,lineHeight:1,get:()=>({nw:0.6})});
`;

async function labRuntime(module:string){
  const built=await build({entryPoints:[fileURLToPath(new URL('../../lab/browser-roundtrip/'+module,import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'molstar-stub',setup(api){
      api.onResolve({filter:/^molstar\//},args=>({path:args.path,namespace:'molstar-stub'}));
      api.onLoad({filter:/.*/,namespace:'molstar-stub'},()=>({contents:MOLSTAR_STUB}));
    }}]});
  return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}
const toolbarRuntime=()=>labRuntime('spatial-toolbar.mjs');

const NARRATION='A guide RNA finds its twenty letters and the enzyme cuts both strands.';
const chapter=(over:Record<string,unknown>={})=>({selectedId:'crispr',selectedTitle:'CRISPR',active:true,step:1,total:5,
  title:'The cut',progress:'Scene 2 / 5',body:NARRATION,bodyPage:NARRATION,bodyPageIndex:0,bodyPageCount:1,...over});

const lines=(readout:{text:string}[])=>readout.map(line=>line.text);

it('marks the real filament summary continuation before the caption wrapper',async()=>{
  const {tourReadout,createToolbarPanel}=await toolbarRuntime() as any;
  const lesson=JSON.parse(readFileSync(new URL('../demos/microtubule-growth/filament.json',import.meta.url),'utf8'));
  const tour=molecularLessonToTour(lesson);
  const pages=pageText(tour.summary);
  expect(pages[0].replace(/\s+/g,' ')).toBe('EMD-6347 is a 3.4 Angstrom cryo-EM');
  const state={selectedId:tour.id,selectedTitle:tour.title,title:tour.title,
    progress:`${tour.steps.length} scenes ready`,step:-1,total:tour.steps.length,
    body:tour.summary,bodyPage:pages[0],bodyPageIndex:0,bodyPageCount:pages.length,talking:true};
  const readout=tourReadout(state,false,1000);
  expect(readout.at(-1).text).toBe(`${pages[0]}…`);
  const head={position:{x:0,y:1.6,z:0},matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
  const panel=createToolbarPanel({head,rows:Array.from({length:8},()=>({label:'Menu'})),readout});
  const drawn=panel.readoutPoints.map((line:any)=>line.text).join(' ');
  expect(drawn).toContain('EMD-6347 is a 3.4 Angstrom cryo-EM…');
  expect(panel.readoutPoints.length).toBeLessThanOrEqual(panel.readoutLineBudget);
  const final=tourReadout({...state,bodyPage:pages.at(-1),bodyPageIndex:pages.length-1},false,1000);
  expect(final.at(-1).text).toBe(pages.at(-1));
});

it('keeps a twelve-word status beyond 140 characters in the live toolbar',async()=>{
  const {createSpatialToolbar}=await toolbarRuntime() as any;
  const answer='Molecular-representation configuration preserves protofilament reconstruction measurements while individual molecular components remain unavailable.';
  expect(answer.split(' ')).toHaveLength(12);
  expect(answer.length).toBeGreaterThan(140);
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const frame={getViewerPose:()=>({transform:{position:{x:0,y:1.6,z:0},matrix}})};
  const session=Object.assign(new EventTarget(),{inputSources:[],
    requestAnimationFrame(callback:any){setTimeout(()=>callback(0,frame),0);return 1;},cancelAnimationFrame(){}});
  const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},
    presentation:{add(){},remove(){},update(){},roomMatrix:()=>matrix},session,space:{},Mat4:{},
    getState:()=>({}),getMolecularBounds:()=>({center:[0,1.6,-1],radius:0.1}),getDepthRange:()=>({})});
  try {
    await toolbar.setStatus('Listening…');
    // Replies now own separate glass. The visible menu must no longer expand
    // into an empty card when the reply is moved away from the controls.
    const menu=toolbar.drawnMenuPoints();
    expect(menu.length).toBeGreaterThan(0);
    await toolbar.setStatus(answer);
    expect(toolbar.statusText()).toBe(answer);
    expect(toolbar.drawnMenuPoints()).toEqual(menu);
  } finally { await toolbar.dispose(); }
});

it('keeps the whole spoken line on the chapter card for as long as the chapter shows',async()=>{
  const {tourReadout}=await toolbarRuntime() as any;
  const subject={title:'SpCas9 ternary complex, amino acids (1242-1263) replaced with Gly-Ser linker',pdbId:'9KJ6',
    chains:4,assembly:'asymmetric_unit',selectionCount:0,representation:'cartoon',color:'chain-id'};
  // The card used to hold the sentence for a four-second window and then settle
  // on the structure's own lines: `SpCas9 ternary` over `complex,…`. Settled,
  // stepped with Next or read to, under a page-load stamp, a wall-clock stamp
  // or none, it is the chapter: title and counter on one line, the whole
  // sentence, and none of the structure's description or identity.
  for(const stamp of [{chapterStartedAt:1_000},{chapterStartedAt:Date.now()},{}])
    for(const now of [1_000,5_000,60_000])
      for(const over of [{},{autoplay:true},{talking:true}])
        expect(lines(tourReadout(chapter({...stamp,...over}),subject,now))).toEqual(['The cut · 2/5',NARRATION]);
});

it('a growth answer leaves the chapter readout unchanged',async()=>{
  const {tourReadout}=await toolbarRuntime() as any;
  const spoken='Grown to a dimer.';
  const tour=chapter({chapterStartedAt:0,growth:{spoken,atMs:9_000}});
  expect(tourReadout(tour,false,9_100)).toEqual(tourReadout(chapter({chapterStartedAt:0}),false,9_100));
});

// A lesson whose manifest says `presentation.captionCard:
// 'hidden'` reaches the readout as `captionCard: 'hidden'` on the tour state.
// The plate draws nothing: no title, no `Scene n / m` row, no narration line.
it('a lesson that hides its caption card draws no tour chrome',async()=>{
  const {tourReadout}=await toolbarRuntime() as any;
  expect(lines(tourReadout(chapter({captionCard:'hidden',chapterStartedAt:1_000}),false,1_000))).toEqual([]);
  expect(lines(tourReadout(chapter({captionCard:'hidden',chapterStartedAt:1_000}),false,41_000))).toEqual([]);
  // Growth replies use the talk card, never hidden chapter glass.
  const spoken='Grown to a dimer.';
  expect(lines(tourReadout(chapter({captionCard:'hidden',growth:{spoken,atMs:9_000}}),false,9_100)))
    .toEqual([]);
  // A lesson that does not set the field reads as shown, exactly as before.
  expect(lines(tourReadout(chapter({chapterStartedAt:1_000}),false,1_000))).toContain(NARRATION);
});

it('the menu seat is measured once and then latched, whatever the structure does',async()=>{
  const {createSpatialToolbar}=await toolbarRuntime() as any;
  const records:any[]=[];
  (globalThis as any).__stereofoldDiagnostics={record:(kind:string,detail:unknown)=>{records.push({kind,detail});}};
  const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const frame={getViewerPose:()=>({transform:{position:{x:0,y:1.6,z:0},matrix:IDENTITY}}),getPose:(space:any)=>space?.pose};
  const session=Object.assign(new EventTarget(),{inputSources:[] as any[],
    requestAnimationFrame(callback:(time:number,f:unknown)=>void){setTimeout(()=>callback(0,frame),0);return 1;},
    cancelAnimationFrame(){}});
  // The scene-from-room matrix the stand-off measures the structure through.
  // Identity: the fixture's bounds are already the room's metres.
  const presentation={add(){},remove(){},update(){},roomMatrix:()=>IDENTITY};
  try{
    // The structure the stand-off is measured against. A chapter reframes it
    // and a grab moves it; both used to re-seat the menu under the wearer.
    let radius=0.6;
    const geometry=entryGeometry();
    geometry.objects[0].values.aTransform.ref.value[13]=1.6;
    for(const view of geometry.views) view.transform.inverse.matrix[13]=-1.6;
    const toolbar=createSpatialToolbar({plugin:{runTask:(task:any)=>task.run()},canvas:{},presentation,session,space:{},Mat4:{},
      getState:()=>({tour:{active:false,step:-1}}), getEntryGeometry:()=>geometry,
      getMolecularBounds:()=>({center:[0,1.6,-1],radius}),getDepthRange:()=>({})});
    expect(toolbar.isLatched()).toBe(false);
    await toolbar.update();
    expect(toolbar.isLatched()).toBe(true);
    expect(toolbar.drawnMenuPoints().length).toBeGreaterThan(0);
    const seatOf=()=>records.filter(e=>e.kind==='toolbar'&&e.detail?.phase==='standoff').map(e=>e.detail.meters);
    const seated=seatOf();
    expect(seated.length).toBe(1);
    radius=8; await toolbar.update();
    radius=0.05; await toolbar.update();
    expect(seatOf()).toEqual(seated);
    // Only asking for the menu unlatches it, and the ring names who asked.
    toolbar.unlatchSeat('menu');
    expect(toolbar.isLatched()).toBe(false);
    await toolbar.update({origin:'wearer'});
    expect(toolbar.isLatched()).toBe(true);
    expect(seatOf().length).toBe(2);
    const seats=records.filter(e=>e.kind==='toolbar'&&e.detail?.event==='seat');
    expect(seats.some(e=>e.detail.latched===true)).toBe(true);
    expect(seats.map(e=>e.detail.reason)).toEqual(expect.arrayContaining(['entry','menu']));
    // The entry seat's clearance verdict is measured, not asserted. It reads
    // `true` for compact entry: the narrower full glass clears this fixture. The
    // record still has to carry that rectangle and a lit, per-eye measurement.
    const entry=records.filter(e=>e.kind==='plate-standoff'&&e.detail?.phase==='entry').pop();
    expect(entry?.detail?.frame?.menu?.clear).toBe(true);
    expect(entry?.detail?.frame?.menu?.rect).toBeTruthy();
    expect(entry?.detail?.lit).toBe(true);
    expect(Number.isFinite(entry?.detail?.clearanceLeft)).toBe(true);
    expect(Number.isFinite(entry?.detail?.clearanceRight)).toBe(true);
    expect(entry?.detail?.frame?.menu?.outboard).toBe(1);
    await toolbar.dispose();
  } finally { delete (globalThis as any).__stereofoldDiagnostics; }
});

it('the press caption uses the menu voice-delivery model',()=>{
  try {
    resetAgentPresence();
    expect(listeningStatusLine()).toBe(DEFAULT_LISTENING_TEXT);
    noteAgentPresence(true,Date.now(),{mode:'none',assistant:'Codex'});
    expect(listeningStatusLine()).toBe(DEFAULT_LISTENING_TEXT);
    noteAgentPresence(false,Date.now(),{mode:'polling',assistant:'Codex'});
    expect(listeningStatusLine()).toBe('Codex is listening');
  } finally { resetAgentPresence(); }
});

it('says nothing about Claude merely because an agent is attached',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../../lab/browser-roundtrip/immersive-session.mjs',import.meta.url),'utf8');
  // Entry used to speak the line whenever `agentAttached()` was true. It now
  // says nothing, and the only route to the line is the
  // `listeningText` reader the press calls.
  expect(source).not.toMatch(/voiceCommandSpeaker\(\)\?\.\(.*is listening/u);
  expect(source).toContain('const listeningText = () => listeningStatusLine();');
});

it('the held press asks for its line at each press, not at bind time',async()=>{
  const shown:string[]=[];
  let attached=false;
  const session={inputSources:[],addEventListener(){},removeEventListener(){}};
  const talk=attachGripPushToTalk({session,send:async()=>({}),audio:null,
    status:(text:string)=>{shown.push(text);},
    listeningText:()=>(attached?'Codex is listening':DEFAULT_LISTENING_TEXT)});
  // An agent that attaches between two presses changes the second line and
  // not the first: a binding that read the line once would show the stale one.
  await talk.start();
  expect(shown.at(-1)).toBe(DEFAULT_LISTENING_TEXT);
  await talk.stop();
  attached=true;
  await talk.start();
  expect(shown.at(-1)).toBe('Codex is listening');
  await talk.stop();
  await talk.dispose();
});

it('shows specific experience failures on the glass and the loaded structure when idle', async () => {
  const { tourReadout } = await toolbarRuntime() as any;
  const subject = { pdbId: '4HHB', title: 'Hemoglobin tetramer', chains: 4, assembly: 'asymmetric_unit',
    selectionCount: 5, representation: 'cartoon', color: 'chain-id' };
  expect(lines(tourReadout({ active: false, menuOpen: false }, subject))).toEqual([
    'Hemoglobin tetramer', '4HHB · 4 chains · asymmetric unit', 'cartoon by chain · 5 selected',
  ]);
  const feedback = 'Journey could not render: atom budget exceeded. Previous view restored.';
  expect(lines(tourReadout(chapter({ feedback, feedbackError: true }), subject))).toEqual([
    'Tour paused. Previous view restored.', 'Hemoglobin tetramer', '4HHB · 4 chains · asymmetric unit', 'cartoon by chain · 5 selected',
  ]);
});

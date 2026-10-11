import {expect,it} from 'vitest';
// @ts-ignore Shared committed entry geometry fixture.
import {entryGeometry} from '../../lab/browser-roundtrip/fixtures/entry-standoff.mjs';

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {pageText} from '../src/tour-player.js';
import {molecularLessonToTour} from '../src/molecular-lesson-tour.js';

// @ts-ignore Shared JavaScript wearer-placement rules.
import {CAPTION_FULL_MS} from '../../lab/browser-roundtrip/wearer-placement.mjs';
// @ts-ignore Shared JavaScript grip binding, the same one the companion bundles.
import {DEFAULT_LISTENING_TEXT,attachGripPushToTalk} from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Shared JavaScript agent-presence reading.
import {AGENT_LISTENING_LINE,NOBODY_LISTENING_LINE,agentAttached,listeningStatusLine,noteAgentPresence,resetAgentPresence} from '../../lab/browser-roundtrip/agent-presence.mjs';

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
export const TextBuilder={create:()=>({add(){},getText(){return {kind:'text'};}})};
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
const chapter=(over:Record<string,unknown>={})=>({selectedId:'crispr',selectedTitle:'CRISPR',active:true,step:1,
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

it('draws the whole spoken line for the reading window, then keeps the short plate',async()=>{
  const {tourReadout}=await toolbarRuntime() as any;
  const tour=chapter({chapterStartedAt:1_000});
  // Inside the window the wearer gets the sentence.
  expect(lines(tourReadout(tour,false,1_000))).toContain(NARRATION);
  expect(lines(tourReadout(tour,false,1_000+CAPTION_FULL_MS-1))).toContain(NARRATION);
  // Past it the plate is the title and the page row: one short line of payload,
  // which is what tells the wearer where the lesson is without covering it.
  const collapsed=lines(tourReadout(tour,false,1_000+CAPTION_FULL_MS));
  expect(collapsed).not.toContain(NARRATION);
  expect(collapsed).toEqual(['The cut','Scene 2 / 5']);
});

it('brings the sentence back whenever the wearer is being read to',async()=>{
  const {tourReadout}=await toolbarRuntime() as any;
  const late=1_000+CAPTION_FULL_MS*10;
  expect(lines(tourReadout(chapter({chapterStartedAt:1_000,talking:true}),false,late))).toContain(NARRATION);
  expect(lines(tourReadout(chapter({chapterStartedAt:1_000,autoplay:true}),false,late))).toContain(NARRATION);
  expect(lines(tourReadout(chapter({chapterStartedAt:1_000,playing:true}),false,late))).toContain(NARRATION);
});

it('never reads a wall-clock stamp as a reading window',async()=>{
  const {tourReadout}=await toolbarRuntime() as any;
  // The bug this guards: `Date.now()` in the tour player against
  // `performance.now()` here. The stamp is then hours in the future, and the
  // window must stay shut rather than stay open forever.
  const epoch=Date.now();
  expect(lines(tourReadout(chapter({chapterStartedAt:epoch}),false,12_345))).not.toContain(NARRATION);
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
  expect(lines(tourReadout(chapter({captionCard:'hidden',chapterStartedAt:1_000}),false,1_000+CAPTION_FULL_MS*10))).toEqual([]);
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

it('names Claude on the status row only while a press is open',async()=>{
  // The row is drawn by `push-to-talk-grip.mjs` while push-to-talk is held or
  // the press is being transcribed, and by nothing else. An attached follower
  // on its own buys no line at all.
  expect(NOBODY_LISTENING_LINE).toBe(DEFAULT_LISTENING_TEXT);
  expect(listeningStatusLine(()=>true)).toBe(AGENT_LISTENING_LINE);
  expect(listeningStatusLine(()=>false)).toBe(DEFAULT_LISTENING_TEXT);
  expect(listeningStatusLine(()=>{throw Error('presence unreadable');})).toBe(DEFAULT_LISTENING_TEXT);
  // And the real reading behind it: a heartbeat that has gone quiet stops
  // naming Claude rather than leaving the claim up.
  try{
    noteAgentPresence(true,1_000);
    expect(listeningStatusLine(()=>agentAttached(1_500))).toBe(AGENT_LISTENING_LINE);
    expect(listeningStatusLine(()=>agentAttached(1_000_000))).toBe(DEFAULT_LISTENING_TEXT);
  } finally { resetAgentPresence(); }
});

it('says nothing about Claude merely because an agent is attached',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../../lab/browser-roundtrip/immersive-session.mjs',import.meta.url),'utf8');
  // Entry used to speak the line whenever `agentAttached()` was true. It now
  // says nothing, and the only route to the line is the
  // `listeningText` reader the press calls.
  expect(source).not.toMatch(/voiceCommandSpeaker\(\)\?\.\(AGENT_LISTENING_LINE\)/u);
  expect(source).toContain('const listeningText = () => listeningStatusLine();');
});

it('the held press asks for its line at each press, not at bind time',async()=>{
  const shown:string[]=[];
  let attached=false;
  const session={inputSources:[],addEventListener(){},removeEventListener(){}};
  const talk=attachGripPushToTalk({session,send:async()=>({}),audio:null,
    status:(text:string)=>{shown.push(text);},
    listeningText:()=>(attached?AGENT_LISTENING_LINE:DEFAULT_LISTENING_TEXT)});
  // An agent that attaches between two presses changes the second line and
  // not the first: a binding that read the line once would show the stale one.
  await talk.start();
  expect(shown.at(-1)).toBe(DEFAULT_LISTENING_TEXT);
  await talk.stop();
  attached=true;
  await talk.start();
  expect(shown.at(-1)).toBe(AGENT_LISTENING_LINE);
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

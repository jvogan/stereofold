import {expect,it} from 'vitest';
// @ts-ignore Import-free UI policy shared by the headset and local review harness.
import {shouldShowRoomWelcome,spatialToolbarRows,COMPACT_ROW_BUDGET,MENU_LABEL_BUDGET_CHARACTERS,ROOM_WELCOME_LINES,MOLECULAR_REPRESENTATIONS,nextMolecularRepresentation} from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';
// @ts-ignore The compact menu must fit the panel's full-size row budget.
import {SPATIAL_TOOLBAR_LAYOUT,toolbarDensity,createToolbarPanel,hitToolbarPanel} from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Active-button paint numbers shared by the headset painter.
import {menuAlpha,toolbarTextProps} from '../../lab/browser-roundtrip/spatial-toolbar-contrast.mjs';
// @ts-ignore Shared row cases keep the lab and Mac contract in agreement.
import {COMPACT_TOUR_CASES,compactTourVariants,MID_CHAPTER_TOUR,FINAL_CHAPTER_TOUR} from '../../lab/browser-roundtrip/fixtures/tour-toolbar-contract.mjs';
const HEAD = {position:{x:0,y:1.6,z:0},matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
it('cycles supported molecular styles with a stable action and readable current label',()=>{
  const labels=['Atoms','Ribbons','Spacefill','Surface'];
  for(const [index,representation] of MOLECULAR_REPRESENTATIONS.entries()){
    expect(nextMolecularRepresentation(representation)).toBe(MOLECULAR_REPRESENTATIONS[(index+1)%4]);
    expect(spatialToolbarRows({appearance:{representation}}).find((row:any)=>row.id==='appearance'))
      .toMatchObject({label:labels[index],action:{kind:'appearance-cycle'}});
  }
  expect(nextMolecularRepresentation('cartoon',['cartoon','molecular-surface'])).toBe('molecular-surface');
  expect(nextMolecularRepresentation('molecular-surface',['cartoon','molecular-surface'])).toBe('cartoon');
  expect(nextMolecularRepresentation('spacefill',['cartoon','molecular-surface'])).toBe('cartoon');
  expect(nextMolecularRepresentation('cartoon',[])).toBeUndefined();
  expect(spatialToolbarRows({appearance:{representation:'cartoon'},representations:['cartoon']})
    .find((row:any)=>row.id==='appearance').state).toBe(true);
});
it('disables density and unavailable history while keeping Undo and Redo discoverable',()=>{
  const state={collapsed:false,appearance:{representation:'isosurface'},history:{canUndo:false,canRedo:false,undoCount:2,redoCount:3}};
  const rows=spatialToolbarRows(state),panel=createToolbarPanel({rows,head:HEAD});
  const close=rows.findIndex((row:any)=>row.id==='menu');
  expect(rows.slice(close+1,close+4).map((row:any)=>row.id)).toEqual(['appearance','undo','redo']);
  expect(rows.find((row:any)=>row.id==='appearance').label).toBe('Density');
  for(const id of ['appearance','undo','redo']){
    const button=panel.buttons.find((row:any)=>row.id===id);
    expect(button.targetable).toBe(false);
    expect(hitToolbarPanel(panel,{origin:[button.point[0],button.point[1],-0.3],direction:[0,0,-1]})).toBeUndefined();
  }
  for(const history of [{undoCount:1,redoCount:1},{canUndo:true,canRedo:true,undoCount:0,redoCount:0}])
    for(const id of ['undo','redo']) expect(spatialToolbarRows({collapsed:false,history}).find((row:any)=>row.id===id).state).toBeUndefined();
});
it('keeps molecular controls compact and reserves Re-seat for expanded recovery',()=>{
  const molecular={appearance:{representation:'cartoon'},history:{canUndo:true,canRedo:true}};
  for(const state of compactTourVariants()){
    const rows=spatialToolbarRows({...state,...molecular});
    expect(rows.length).toBeLessThanOrEqual(COMPACT_ROW_BUDGET);
    expect(toolbarDensity(rows.length)).toBe(1);
    expect(rows.some((row:any)=>['undo','redo'].includes(row.id))).toBe(false);
    expect(rows.some((row:any)=>row.id==='move')).toBe(false);
    expect(spatialToolbarRows({...state,collapsed:false,quiet:false}).find((row:any)=>row.id==='move')?.label).toBe('Re-seat');
    expect(rows.every((row:any)=>row.label.length<=MENU_LABEL_BUDGET_CHARACTERS)).toBe(true);
    const expanded={...state,collapsed:false,quiet:false};
    expect(spatialToolbarRows({...expanded,...molecular}).length).toBe(spatialToolbarRows(expanded).length);
  }
});
it('offers a useful first action without inactive scene navigation',()=>{
  const rows=spatialToolbarRows();
  // The wearer could not find the switch to Mol* on hardware, so it is a
  // top-level row. The lesson chooser gives up its place to it and stays one
  // press away under Menu.
  //
  // Resetting the view was not discoverable either. A stick push can put the
  // structure out of the room, and the way back was a controller button and a
  // spoken command, neither of them visible, so the seat is a row directly
  // under the primary action.
  //
  // Passthrough was a control on the companion page, which is a screen the
  // wearer is not wearing. It is a row now.
  expect(rows.map((r:any)=>r.action.kind)).toEqual(['tour-play','recenter-structure','passthrough','open-workbench','collapse']);
  expect(rows.map((r:any)=>r.label)).toEqual(['Tour','Reset','Room','Mol*','Menu']);
  // Named for the state once the caller knows the live one, not
  // for the press. Passthrough and plain VR are separate WebXR sessions and
  // crossing between them drops immersion for a moment, so a wearer deciding
  // whether to press it has to be able to read which one they are in first.
  // The action still carries the opposite of the state explicitly, so a
  // repeated command cannot flip it back.
  expect(spatialToolbarRows({passthrough:false}).find((r:any)=>r.action.kind==='passthrough'))
    .toMatchObject({label:'Room off',action:{kind:'passthrough',on:true}});
  expect(spatialToolbarRows({passthrough:true}).find((r:any)=>r.action.kind==='passthrough'))
    .toMatchObject({label:'Room on',action:{kind:'passthrough',on:false}});
  // It presses the same action the controller and the voice command run, so
  // the grip guard and the spoken confirmation cannot drift apart from it.
  expect(rows.find((r:any)=>r.label==='Reset')?.action).toEqual({kind:'recenter-structure'});
  // The expanded grid keeps the one it had: `Fit` already runs this exact seat
  // while a session is presenting.
  expect(spatialToolbarRows({collapsed:false}).some((r:any)=>r.action.kind==='recenter-structure')).toBe(false);
  // The collapsed menu is the demo default, so it must stay inside the size
  // the panel lays out at full scale rather than stepping down. Seven rows is
  // the working limit: the voice row joins these six whenever a controller
  // or a microphone is attached.
  expect(spatialToolbarRows({voice:{state:'idle'}}).length).toBeLessThanOrEqual(7);
  expect(rows.length).toBeLessThanOrEqual(SPATIAL_TOOLBAR_LAYOUT.comfortRows);
  // The budget this module trims against is the one the panel lays out to.
  expect(COMPACT_ROW_BUDGET).toBe(SPATIAL_TOOLBAR_LAYOUT.comfortRows);
  // Three lines, because both controllers now do the same things and a wearer
  // holding one of them has to be told the whole map once, including what
  // pressing down on the stick does.
  expect(ROOM_WELCOME_LINES.length).toBe(3);
  // The caption font is whatever fits the plate width, so the longest welcome
  // line sets how large the first thing a wearer reads can be.
  expect(ROOM_WELCOME_LINES.every((line:string)=>line.length<=80)).toBe(true);
  // It names every control that is not a button below it.
  const welcomeText=ROOM_WELCOME_LINES.join(' ').toLowerCase();
  for(const control of ['talk','menu','reset','stick','trigger','grip'])
    expect(welcomeText).toContain(control);
  // Both hands, never one: either controller alone must reach everything.
  for(const pair of ['a/x','b/y']) expect(welcomeText).toContain(pair);
  // One build serves every demo and the plate is drawn before a tour is
  // chosen, so the welcome cannot name a molecule: it once told a CRISPR
  // wearer to say "show tubulin".
  const welcome=ROOM_WELCOME_LINES.join(' ').toLowerCase();
  for(const name of ['tubulin','crispr','cas9','hemoglobin','nucleosome','spike','microtubule'])
    expect(welcome).not.toContain(name);
});
it('exposes available tour directions and full caption paging after starting',()=>{
  const rows=spatialToolbarRows({tour:{selectedId:'surface-safari',active:true,autoplay:true,canBack:false,canNext:true,bodyPageCount:3,bodyPageIndex:0}});
  expect(rows[0].label).toBe('Pause');
  expect(rows.some((r:any)=>r.action.kind==='tour-back')).toBe(false);
  expect(rows.some((r:any)=>r.action.kind==='tour-next')).toBe(true);
  expect(rows.find((r:any)=>r.action.kind==='tour-next')?.label).toBe('Next');
  expect(rows.find((r:any)=>r.action.kind==='tour-page')?.label).toBe('Pg 1/3');
});
it('keeps an active Done seat on the final chapter without dropping a quiet button',()=>{
  const rows=(tour:any)=>spatialToolbarRows({quiet:true,voice:{state:'idle'},tour});
  const last=rows(FINAL_CHAPTER_TOUR),mid=rows(MID_CHAPTER_TOUR);
  expect(last.map((r:any)=>r.label)).toEqual(['Talk','Play','Done','Menu']);
  expect(mid.map((r:any)=>r.label)).toEqual(['Talk','Play','Next','Menu']);
  expect(mid.length).toBe(last.length);
  const done=last.find((r:any)=>r.label==='Done');
  expect(done.state).toBeUndefined();
  expect(done.action).toEqual({kind:'tour-done'});
  const panel=createToolbarPanel({rows:last,head:HEAD});
  const button=panel.buttons.find((r:any)=>r.label==='Done');
  expect(button.targetable).toBe(true);
  expect(hitToolbarPanel(panel,{origin:[button.point[0],button.point[1],-0.3],direction:[0,0,-1]})?.action)
    .toEqual({kind:'tour-done'});
});
it('paints final Done as an active button with the same text alpha as Next',()=>{
  for(const quiet of [false,true]){
    const button=(tour:any,label:string)=>createToolbarPanel({head:HEAD,
      rows:spatialToolbarRows({quiet,voice:{state:'idle'},tour})}).buttons.find((r:any)=>r.label===label);
    const done=button(FINAL_CHAPTER_TOUR,'Done'),next=button(MID_CHAPTER_TOUR,'Next');
    expect(done.style).toBe('action');
    expect(done.style).toBe(next.style);
    expect(done.state).toBeUndefined();
    expect(done.accent).toBeUndefined();
    expect(toolbarTextProps(menuAlpha(quiet).labels))
      .toMatchObject({alpha:quiet?0.55:1,borderWidth:0,background:false});
    const navigating=button({...FINAL_CHAPTER_TOUR,navigating:true},'Done');
    expect(navigating.style).toBe('state');
    expect(navigating.targetable).toBe(false);
  }
});
it('keeps every compact tour state inside the full-size row budget',()=>{
  for(const {tour,labels} of COMPACT_TOUR_CASES)
    expect(spatialToolbarRows({tour,voice:{state:'idle'},collapsed:true}).map((r:any)=>r.label)).toEqual(labels);
  for(const state of compactTourVariants()){
    const rows=spatialToolbarRows(state);
    expect(rows.length).toBeLessThanOrEqual(SPATIAL_TOOLBAR_LAYOUT.comfortRows);
    expect(toolbarDensity(rows.length)).toBe(1);
    expect(SPATIAL_TOOLBAR_LAYOUT.fontMeters).toBeGreaterThanOrEqual(0.050);
  }
});
it('offers early Done under Menu without adding an expanded column',()=>{
  const rows=spatialToolbarRows({collapsed:false,voice:{state:'idle'},tour:MID_CHAPTER_TOUR});
  expect(rows.filter((r:any)=>r.action.kind==='tour-done')).toHaveLength(1);
  expect(rows.find((r:any)=>r.action.kind==='tour-done')?.state).toBeUndefined();
  expect(rows.some((r:any)=>r.action.kind==='tour-next')).toBe(true);
  expect(rows.length).toBeLessThanOrEqual(2*SPATIAL_TOOLBAR_LAYOUT.maxRows);
  expect(spatialToolbarRows({collapsed:false}).some((r:any)=>r.action.kind==='tour-menu')).toBe(true);
});
it('keeps molecular surfaces and deliberate manipulation available on demand',()=>{
  const compact=spatialToolbarRows(),expanded=spatialToolbarRows({collapsed:false,mode:'rotate'});
  expect(compact.some((r:any)=>r.action.kind==='appearance')).toBe(false);
  expect(expanded.some((r:any)=>r.action.kind==='open-workbench')).toBe(true);
  expect(expanded.some((r:any)=>r.action.preset==='molecular-surface')).toBe(true);
  expect(expanded.filter((r:any)=>r.action.kind==='nudge').every((r:any)=>r.action.mode==='rotate')).toBe(true);
});

it('drops the first-run welcome once the wearer has pressed anything',()=>{
  // The standing welcome copy stops matching the state once the wearer acts.
  // It is a hint, so it goes as soon as it has been acted on.
  expect(shouldShowRoomWelcome({voice:{state:'idle'}})).toBe(true);
  expect(shouldShowRoomWelcome({engaged:true})).toBe(false);
  expect(shouldShowRoomWelcome({voice:{state:'listening'}})).toBe(false);
  expect(shouldShowRoomWelcome({tour:{active:true}})).toBe(false);
});

/**
 * The rule that decides how much of the wearer's lens the menu takes.
 *
 * A row plate is as wide as its widest label, the panel is as wide as its
 * widest plate, and `toolbarSeatDegrees` then brings the whole panel inboard --
 * across the structure -- until its outboard corner is back inside the glass.
 * A label length is therefore a geometry decision, and this is where it is
 * pinned. Every state a wearer can reach is enumerated, including the ones only
 * a failing microphone or a mid-navigation tour produce: a label that appears
 * only while something is going wrong is exactly the one nobody looks at until
 * the headset is on.
 */
it('keeps every row label a wearer can reach inside the label budget',()=>{
  const voiceStates=[undefined,'idle','starting','listening','recording','sending','transcribing','playing','error'];
  const seen=new Set<string>();
  for(const collapsed of [true,false]) for(const quiet of [true,false])
  for(const state of voiceStates) for(const mode of ['move','rotate'])
  for(const paused of [true,false]) for(const passthrough of [undefined,true,false])
  for(const quality of [undefined,'fast','balanced','best'])
  for(const tour of [undefined,{active:true,autoplay:true,canBack:true,canNext:true,bodyPageIndex:0,bodyPageCount:9,selectedId:'a'},
    {active:true,navigating:true,canNext:true,bodyPageIndex:8,bodyPageCount:9,selectedId:'a'},
    {menuOpen:true,selectedId:'a',bodyPageIndex:0,bodyPageCount:2}]) {
    for(const row of spatialToolbarRows({collapsed,quiet,mode,paused,passthrough,quality,tour,
      voice:state===undefined?undefined:{state}}) as {label:string}[]) seen.add(row.label);
  }
  expect(seen.size).toBeGreaterThan(30);
  expect([...seen].filter(label=>[...label].length>MENU_LABEL_BUDGET_CHARACTERS)).toEqual([]);
});

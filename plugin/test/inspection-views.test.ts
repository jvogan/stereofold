import { describe, expect, it } from 'vitest';
import { InspectionViews, MAX_INSPECTION_VIEWS } from '../src/inspection-views.js';
import type { InspectionScene } from '../src/inspection-contract.js';
import { namedViewIntentSchema } from '../src/inspection-contract.js';

const hash = 'a'.repeat(64);
const scene = (extra: Partial<InspectionScene> = {}): InspectionScene => ({
  sourceSha256: hash, modelNumber: 1, assemblyId: '1', selectionKeys: ['residue-1'],
  camera: { mode: 'perspective', fov: 45, position: [0,0,10], target: [0,0,0], up: [0,1,0], radius: 5, radiusMax: 10, fog: 50, clipFar: true, minNear: 0.1, minFar: 1 },
  inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#ffffff', background: '#000000', highlightColor: '#ffff00', opacity: 1, labels: true, clipping: 0, fog: 50 },
    placement: { translation: [0,0,0], rotation: [0,0,0], scale: 1 } }, ...extra,
});
const source = (value = scene()) => ({ sourceSha256: value.sourceSha256, modelNumber: value.modelNumber, assemblyId: value.assemblyId });

describe('session named inspection views', () => {
  it('stores a private clone and lists only bounded semantic metadata', () => {
    const views = new InspectionViews(); const input = scene();
    const saved = views.save({ commandId: 'save-1', name: '  Active   site ', scene: input, inspectionRevision: 7 });
    input.selectionKeys.length = 0;
    expect(saved.name).toBe('Active site');
    expect(views.restore(saved.id, source()).supportedScene.selectionKeys).toEqual(['residue-1']);
    expect(views.list()).toEqual([expect.objectContaining({ id: saved.id, name: 'Active site', createdRevision: 7,
      viewRevision: 1, viewIntent: expect.objectContaining({ selectionCount: 1, orientation: 'not-captured' }) })]);
    expect(views.list()[0]).not.toHaveProperty('supportedScene');
    expect(JSON.stringify(views.list())).not.toContain('position');
  });

  it('deduplicates retries and rejects command reuse with different captured content', () => {
    const views = new InspectionViews();
    const first = views.save({ commandId: 'same-command', name: 'Site', scene: scene(), inspectionRevision: 2 });
    expect(views.save({ commandId: 'same-command', name: 'Site', scene: scene(), inspectionRevision: 2 }).id).toBe(first.id);
    expect(views.list()).toHaveLength(1);
    expect(() => views.save({ commandId: 'same-command', name: 'Other', scene: scene(), inspectionRevision: 2 })).toThrow(/commandId/);
  });

  it('requires explicit duplicate replacement and increments its revision', () => {
    const views = new InspectionViews();
    const first = views.save({ commandId: 'one', name: 'Site', scene: scene(), inspectionRevision: 2 });
    expect(() => views.save({ commandId: 'two', name: 'site', scene: scene(), inspectionRevision: 3 })).toThrow(/replaceViewId/);
    const replacement = views.save({ commandId: 'two', name: 'site', scene: scene({ selectionKeys: ['residue-2'] }), inspectionRevision: 3, replaceViewId: first.id });
    expect(replacement).toMatchObject({ id: first.id, createdRevision: 2, viewRevision: 2 });
    expect(views.list()).toHaveLength(1);
  });

  it('refuses silent eviction at capacity', () => {
    const views = new InspectionViews();
    for (let i=0;i<MAX_INSPECTION_VIEWS;i++) views.save({ commandId: `c${i}`, name: `View ${i}`, scene: scene(), inspectionRevision: i });
    expect(() => views.save({ commandId: 'overflow', name: 'Overflow', scene: scene(), inspectionRevision: 9 })).toThrow(/Delete one/);
    expect(views.list()).toHaveLength(MAX_INSPECTION_VIEWS);
  });

  it('protects source identity and stale deletion revisions', () => {
    const views = new InspectionViews();
    const saved = views.save({ commandId: 'one', name: 'Site', scene: scene(), inspectionRevision: 2 });
    const other = source(scene({ assemblyId: '2' }));
    expect(() => views.restore(saved.id, other)).toThrow(/different structure, model, or assembly/);
    expect(() => views.delete({ viewId: saved.id, source: source(), viewRevision: 0 })).toThrow(/changed/);
    expect(views.delete({ viewId: saved.id, source: source(), viewRevision: 1 })).toBe(true);
    expect(views.delete({ viewId: saved.id, source: source(), viewRevision: 1 })).toBe(false);
  });

  it('keeps repeated replace/delete churn bounded to the declared live entries',()=>{
    const views=new InspectionViews();
    for(let i=0;i<64;i++) {
      const prior=views.list()[0];
      const saved=views.save({commandId:`save-${i}`,name:'Rolling',scene:scene({selectionKeys:[`residue-${i}`]}),
        inspectionRevision:i, ...(prior?{replaceViewId:prior.id}:{})});
      expect(views.list()).toHaveLength(1);
      if(i%4===3) {
        expect(views.delete({viewId:saved.id,source:source(),viewRevision:saved.viewRevision})).toBe(true);
        expect(views.list()).toHaveLength(0);
      }
    }
    expect(views.list().length).toBeLessThanOrEqual(MAX_INSPECTION_VIEWS);
  });

  it('includes explicit replacement intent in command idempotency',()=>{
    const views=new InspectionViews();
    const first=views.save({commandId:'first',name:'Site',scene:scene(),inspectionRevision:1});
    views.save({commandId:'replace',name:'Site',scene:scene({selectionKeys:['two']}),inspectionRevision:2,replaceViewId:first.id});
    expect(()=>views.save({commandId:'replace',name:'Site',scene:scene({selectionKeys:['two']}),inspectionRevision:2})).toThrow(/commandId/);
  });

  it('lists entries from another source with their identity instead of silently dropping them',()=>{
    const views=new InspectionViews();
    const home=views.save({commandId:'home',name:'Site',scene:scene(),inspectionRevision:1});
    const away=views.save({commandId:'away',name:'Other assembly',scene:scene({sourceSha256:'b'.repeat(64),modelNumber:2,assemblyId:'2'}),inspectionRevision:1});
    // One listing policy: no source filter here. Panels and agents label the
    // foreign entry by this identity; restore still refuses it explicitly.
    const entries=views.list();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry=>entry.id===away.id)).toMatchObject({sourceSha256:'b'.repeat(64),modelNumber:2,assemblyId:'2'});
    expect(entries.find(entry=>entry.id===home.id)).toMatchObject({sourceSha256:hash,modelNumber:1,assemblyId:'1'});
    expect(()=>views.restore(away.id,source())).toThrow(/different structure, model, or assembly/);
  });

  it('keeps bounded object-relative orientation private and exposes only availability',()=>{
    const views=new InspectionViews();
    const intent=namedViewIntentSchema.parse({version:1,sourceSha256:hash,modelNumber:1,assemblyId:'1',
      targetOffsetRadii:[0.1,-0.2,0],direction:[0,0,-1],up:[0,1,0],distanceInRadii:3,verticalSpanRadii:1.5});
    const saved=views.save({commandId:'angle',name:'Angle',scene:scene(),inspectionRevision:1,namedViewIntent:intent});
    expect(saved.namedViewIntent).toEqual(intent);
    expect(views.list()[0].viewIntent.orientation).toBe('object-relative');
    expect(JSON.stringify(views.list())).not.toContain('targetOffsetRadii');
    expect(()=>namedViewIntentSchema.parse({...intent,direction:[0,0,-2]})).toThrow(/normalized/);
    expect(()=>namedViewIntentSchema.parse({...intent,up:[0,0,-1]})).toThrow(/orthogonal/);
  });
});

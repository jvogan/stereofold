import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {expect,it} from 'vitest';
import {createStereoStructureServer} from '../src/server.js';
import {PRIVATE_INSPECTION_META_KEY as KEY} from '../src/inspection-contract.js';
import {decodeInspectionCatalog} from '../src/inspection-catalog-codec.js';
import {DEMO_INDEX_PATH,readGrowthIndex} from '../src/molecular-growth.js';

it('grows through every real bundled extended-gallery batch and confirms its new renderer source',async()=>{
  // No growth/index/provenance mocks: exercise the same sourceId-only stages
  // as the headset, including verified bytes, compiled lessons and receipts.
  const demo=(await readGrowthIndex()).demos.find(entry=>entry.name==='binder-gallery-extended')!;
  const stages=demo.stages!,first=stages[0];
  if(first.coordinates.derivation?.kind!=='bundled-file')throw Error('Expected bundled first stage.');
  const directory=await mkdtemp(join(tmpdir(),'binder-extended-growth-'));
  const [a,b]=InMemoryTransport.createLinkedPair();
  const server=createStereoStructureServer(undefined,{sceneServiceFile:join(directory,'scene-service.json')});
  const client=new Client({name:'Real bundled gallery growth contract',version:'1'});
  await server.connect(b);await client.connect(a);
  const call=async(name:string,args:Record<string,unknown>):Promise<any>=>{
    const result=await client.callTool({name:`stereo_structure.${name}`,arguments:args});
    expect(result.isError,JSON.stringify(result.content)).not.toBe(true);return result;
  };
  try{
    const opened=await call('inspect_lesson',{filePath:resolve(dirname(DEMO_INDEX_PATH),first.coordinates.derivation.path),
      lessonPath:resolve(dirname(DEMO_INDEX_PATH),first.lesson)});
    const sessionId=opened.structuredContent.sessionId;
    const bind=(data:any)=>({sessionId,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
      baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision});
    const capture=async(data:any)=>{
      const catalog=data.catalog??await decodeInspectionCatalog(data.catalogWire);
      return {sourceSha256:catalog.source.sha256,modelNumber:catalog.modelNumbers[0],assemblyId:catalog.assemblyId,
        selectionKeys:[],camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],
          radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
        inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#58dcc9',background:'#ffffff',
          opacity:0,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},
          placement:{translation:[.5,.3,-2.8],rotation:[17,-35,12],scale:2.1}}};
    };
    let data=(await call('get_inspection',{sessionId}))._meta[KEY];
    let saved=(await call('sync_inspection',{...bind(data),scene:await capture(data)})).structuredContent;
    let panelId=(await call('attach_inspection',{...bind(saved),surface:'companion'})).structuredContent.panelId;
    for(const stage of stages.slice(1)){
      await call('poll_inspection',{...bind(saved),panelId,availability:'ready'});
      const growth=await call('grow_structure',{...bind(saved),panelId,stage:stage.id,device:'quest2'});
      expect(growth.structuredContent.grow).toMatchObject({refused:false,to:stage.id,demo:demo.name});
      expect(growth.structuredContent.sourceTransition.pdbId).toBeUndefined();
      expect(growth.structuredContent.operation.provenance).toMatchObject({
        sourceAddress:(stage.coordinates.derivation as {path:string}).path,sha256:stage.coordinates.sha256,
        derivation:{sourceId:stage.sourceId}});
      data=(await call('get_inspection',{sessionId}))._meta[KEY];
      expect(data.customTour.id).toBe(`lesson-${demo.name}-${stage.id}`);
      expect(data.customTour.presentation.coordinateFrame).toBe('binder-gallery-extended-aligned-v1');
      saved=(await call('sync_inspection',{...bind(data),scene:await capture(data)})).structuredContent;
      const attached=(await call('attach_inspection',{...bind(saved),surface:'companion',replacesPanelId:panelId})).structuredContent;
      expect(attached.panelId).toBe(panelId);panelId=attached.panelId;
      const state=(await call('get_inspection_state',{sessionId})).structuredContent;
      expect(state.sourceRenderReceipt).toMatchObject({status:'rendered',rendered:true,panelId,sourceToken:data.sourceToken});
    }
  }finally{await client.close();await server.close();await rm(directory,{recursive:true,force:true});}
},120_000);

import { describe, expect, it } from 'vitest';
import {
  createInspectorDisplayModeController,
  inspectorDisplayModeButtonState,
  waitForInspectorDisplayModeBox,
  type InspectorDisplayMode,
  type InspectorDisplayModeButtonState,
} from '../src/inspector-display-mode.js';

describe('inspector display mode', () => {
  it('hides the action when fullscreen is not advertised by the host', async () => {
    let requests=0;
    const host={
      getHostContext:()=>({displayMode:'inline',availableDisplayModes:['inline'] as const}),
      requestDisplayMode:async({mode}:{mode:InspectorDisplayMode})=>{requests++;return {mode};},
    };
    const rendered:InspectorDisplayModeButtonState[]=[];
    const controller=createInspectorDisplayModeController(host,state=>rendered.push(state));
    expect(inspectorDisplayModeButtonState(host.getHostContext(), 'inline').hidden).toBe(true);
    expect(controller.sync().hidden).toBe(true);
    await expect(controller.toggle()).resolves.toMatchObject({changed:false,mode:'inline'});
    expect(requests).toBe(0);
    expect(rendered.at(-1)?.hidden).toBe(true);
  });

  it('changes the host mode without changing the registered session or lesson state', async () => {
    let context:{displayMode:InspectorDisplayMode;availableDisplayModes:readonly InspectorDisplayMode[]}={displayMode:'inline',availableDisplayModes:['inline','fullscreen']};
    const session={panelId:'panel-1',sessionId:'session-1',lesson:{id:'lesson-1',step:2}};
    const before=structuredClone(session);
    const requests:string[]=[];
    const host={
      getHostContext:()=>context,
      requestDisplayMode:async({mode}:{mode:InspectorDisplayMode})=>{
        requests.push(mode);context={...context,displayMode:mode};return {mode};
      },
    };
    let last;
    const controller=createInspectorDisplayModeController(host,state=>{last=state;});
    controller.sync();
    await expect(controller.toggle()).resolves.toMatchObject({changed:true,mode:'fullscreen'});
    expect(requests).toEqual(['fullscreen']);
    expect(session).toEqual(before);
    expect(last).toMatchObject({mode:'fullscreen',label:'Back to chat',hidden:false});
    expect(controller.sync()).toMatchObject({mode:'fullscreen',label:'Back to chat'});
    context={...context,displayMode:'inline'};
    expect(controller.sync()).toMatchObject({mode:'inline',label:'Open in side panel'});
    expect(session).toEqual(before);
  });

  it('waits for the confirmed mode and its new box before sizing', async () => {
    let context={displayMode:'inline' as InspectorDisplayMode,containerDimensions:{width:600,height:480}};
    let frames=0;
    const settled=await waitForInspectorDisplayModeBox({
      expectedMode:'fullscreen',
      readContext:()=>context,
      readBox:value=>JSON.stringify(value?.containerDimensions),
      nextFrame:async()=>{
        frames++;
        if(frames===2)context={displayMode:'fullscreen',containerDimensions:{width:1200,height:800}};
      },
    });
    expect(frames).toBe(5);
    expect(settled).toEqual({displayMode:'fullscreen',containerDimensions:{width:1200,height:800}});
  });
});

export type InspectorDisplayMode = 'inline' | 'fullscreen' | 'pip';

export type InspectorHostContext = {
  displayMode?: unknown;
  availableDisplayModes?: readonly unknown[];
  containerDimensions?: unknown;
};

export type InspectorDisplayModeButtonState = {
  hidden: boolean;
  mode: InspectorDisplayMode;
  nextMode: InspectorDisplayMode;
  label: string;
  title: string;
  ariaPressed: string;
};

const isDisplayMode = (value:unknown):value is InspectorDisplayMode =>
  value === 'inline' || value === 'fullscreen' || value === 'pip';

/** MCP Apps capability check for the inspector's larger-view action. */
export function supportsInspectorFullscreen(context:InspectorHostContext|undefined):boolean {
  return Array.isArray(context?.availableDisplayModes) && context.availableDisplayModes.includes('fullscreen');
}

export function inspectorDisplayModeButtonState(context:InspectorHostContext|undefined, mode:InspectorDisplayMode):InspectorDisplayModeButtonState {
  const supported=supportsInspectorFullscreen(context);
  const fullscreen=mode==='fullscreen';
  return {
    hidden:!supported,
    mode,
    nextMode:fullscreen?'inline':'fullscreen',
    label:fullscreen?'Back to chat':'Open in side panel',
    title:fullscreen?'Return the inspector to the conversation':"Move the inspector to Codex's side panel",
    ariaPressed:String(fullscreen),
  };
}

type DisplayModeHost = {
  getHostContext?:()=>InspectorHostContext|undefined;
  requestDisplayMode:(params:{mode:InspectorDisplayMode})=>Promise<{mode:InspectorDisplayMode}>;
};

/**
 * Own only display state. The host owns the panel/session; toggling this
 * controller never detaches, hydrates, or recreates the inspector.
 */
export function createInspectorDisplayModeController(host:DisplayModeHost, render:(state:InspectorDisplayModeButtonState)=>void) {
  let mode:InspectorDisplayMode='inline';
  const sync=(context=host.getHostContext?.())=>{
    if(isDisplayMode(context?.displayMode)) mode=context.displayMode;
    const state=inspectorDisplayModeButtonState(context,mode);
    render(state);
    return state;
  };
  const toggle=async()=>{
    const context=host.getHostContext?.();
    sync(context);
    if(!supportsInspectorFullscreen(context)) return {changed:false as const,mode};
    const response=await host.requestDisplayMode({mode:mode==='fullscreen'?'inline':'fullscreen'});
    if(isDisplayMode(response.mode)) mode=response.mode;
    render(inspectorDisplayModeButtonState(host.getHostContext?.() ?? context,mode));
    return {changed:true as const,mode};
  };
  return {sync,toggle,get mode(){return mode;}};
}

/** Wait until the confirmed mode has a stable box before reporting its size. */
export async function waitForInspectorDisplayModeBox<T extends InspectorHostContext>(options:{
  expectedMode:InspectorDisplayMode;
  readContext:()=>T|undefined;
  readBox:(context:T|undefined)=>string;
  nextFrame:()=>Promise<void>;
  maxFrames?:number;
}):Promise<T|undefined> {
  let previous='';
  let stableFrames=0;
  let latest=options.readContext();
  for(let frame=0;frame<(options.maxFrames??40) && stableFrames<3;frame++) {
    await options.nextFrame();
    latest=options.readContext();
    const box=options.readBox(latest);
    if(latest?.displayMode===options.expectedMode) stableFrames=box===previous?stableFrames+1:0;
    else stableFrames=0;
    previous=box;
  }
  return latest;
}

/** Keep chapter prose inside the existing short-line voice contract. */
export function narrationLines(message:string):string[] {
  let rest=message.replace(/[\0\r\n]+/g,' ').replace(/\s+/g,' ').trim();
  const lines:string[]=[];
  while(rest) {
    let end=Math.min(180,rest.length);
    if(end<rest.length) {
      const boundary=rest.lastIndexOf(' ',end);
      if(boundary>0)end=boundary;
      if(/[\uD800-\uDBFF]/.test(rest[end-1]!))end--;
    }
    lines.push(rest.slice(0,end));rest=rest.slice(end).trimStart();
  }
  return lines;
}

/** One synthesis at a time. Superseded chapters never post another line. */
export function createPanelNarrator(options:{
  speak?:(line:string,speech?:any)=>Promise<void>;
  prepare?:(line:string,speech?:any)=>Promise<()=>Promise<void>>;
}) {
  let synthesis=Promise.resolve();
  return async(message:string,speech?:{stale?:()=>boolean})=>{
    for(const line of narrationLines(message)) {
      if(speech?.stale?.())return;
      const request=synthesis.then(async()=>{
        if(speech?.stale?.())return;
        if(options.prepare)return options.prepare(line,speech);
        await options.speak!(line,speech);
      });
      // Synthesis is bounded separately from playback. A new chapter can
      // prepare its interruption while the previous chapter is still audible.
      synthesis=request.then(()=>{},()=>{});
      const play=await request;
      if(speech?.stale?.())return;
      await play?.();
    }
  };
}

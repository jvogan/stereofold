/** Coordinate-free, paged sequence controls for the existing immersive toolbar. */
const group = i => JSON.stringify([i.modelNumber,i.assemblyId,i.copyId,i.entityId,i.labelChain,i.operatorIds]);
const describe = r => { const i=r.identity; return `${i.componentId} ${i.authorResidue ?? '?'}${i.insertionCode ?? ''}; author chain ${i.authorChain || '(blank)'}, label ${i.labelChain}:${i.labelSequenceId ?? 'nonpolymer'}; model ${i.modelNumber}, assembly ${i.assemblyId}, copy ${i.copyId ?? i.operatorIds?.join(',') ?? '?'}${r.coordinateState === 'resolved' ? '' : '; coordinates missing'}`; };
const short = s => s.length>8 ? s.slice(0,7)+'…' : s;
/**
 * How many residue rows one page of the browser carries.
 *
 * It was three, hard-coded, and a wearer looking for residue 141
 * of a hemoglobin chain was 47 presses of `Next` away from it
 * Three was never a measurement: the
 * plate lays out `COMPACT_ROW_BUDGET` rows — nine, pinned to the panel
 * geometry's `comfortRows` — and browsing spends four of them on Previous,
 * Next, Tools and Back and one on the Talk row that rides above every sequence
 * page. What is left is the page, and it is derived here rather than guessed.
 *
 * The budget is a parameter because the page that draws the plate is the only
 * thing that knows what its own density step is currently carrying; a caller
 * that states nothing gets the shipped nine.
 */
export const SEQUENCE_ROW_BUDGET = 9;
/** Previous, Next, Tools, Back: the four rows a browse page always spends. */
export const SEQUENCE_BROWSE_CHROME_ROWS = 4;
/** Previous, Next, Back: what a chain-tab page spends. */
export const SEQUENCE_CHAINS_CHROME_ROWS = 3;
/** The Talk row, which `spatialToolbarRows` puts above the browser on every page. */
export const SEQUENCE_RESERVED_ROWS = 1;
export function sequencePageSize(rowBudget = SEQUENCE_ROW_BUDGET, reservedRows = SEQUENCE_RESERVED_ROWS,
  chromeRows = SEQUENCE_BROWSE_CHROME_ROWS) {
  return Math.max(1, Math.floor(rowBudget) - chromeRows - reservedRows);
}

export function createSequenceNavigation(read, {rowBudget=SEQUENCE_ROW_BUDGET, reservedRows=SEQUENCE_RESERVED_ROWS}={}) {
  let binding, rowRef, keysRef, visibleRef, available=false, all=[], groups=[], chain, filtered=[], page=0, mode='closed', detail, anchor, query=null;
  let version=0, cache, digits='000000', digit=5, negative=false, numbering='author', chainPage=0;
  const pageSize=sequencePageSize(rowBudget,reservedRows);
  const chainPageSize=sequencePageSize(rowBudget,reservedRows,SEQUENCE_CHAINS_CHROME_ROWS);
  const pageCount=()=>Math.max(1,Math.ceil(filtered.length/pageSize));
  const number=r=>r.identity[numbering==='author'?'authorResidue':'labelSequenceId'];
  const chainLabel=g=>{ const r=all.find(x=>group(x.identity)===g); return r?`${r.identity.labelChain}${groups.length>1&&r.identity.copyId?`·${r.identity.copyId}`:''}`:'?'; };
  /**
   * The Find pad drew `Author #`, `Digit ←`, `Digit →`, `Value +`, `Value −`,
   * `Positive`, `Go to` and no digits anywhere. A `Value +` press on the Quest 2
   * changed one digit of a number nothing drew, so the wearer
   * could not tell that the press had registered, and `Go to` then jumped to
   * residue 1 — the value was there all along and invisible.
   *
   * The plate carries nine rows and the pad already spent all nine, so the
   * readout is not a tenth row: the numbering toggle now IS the readout. It
   * leads with `A` for author numbering or `S` for sequence position, carries
   * the minus sign when the value is negative, and shows all six digits so a
   * press that moves one of them is visible as a change. Eight characters at
   * its widest (`S-000141`), which is the label budget the geometry test pins.
   */
  const findLabel=()=>`${numbering==='author'?'A':'S'}${negative?'-':''}${digits}`;
  /** The signed number the pad is holding, in whichever numbering it is on. */
  const findValue=()=>Number(digits)*(negative?-1:1);
  const invalidate=()=>{ version++; cache=undefined; };
  function refilter() { filtered=all.filter(r=>group(r.identity)===chain && (query===null || r.identity[numbering==='author'?'authorResidue':'labelSequenceId']===query)); page=Math.min(page,pageCount()-1); }
  function sync() {
    const next=read();
    if(next.binding!==binding || next.rows!==rowRef || next.visible!==visibleRef || next.available!==available) {
      binding=next.binding; rowRef=next.rows; visibleRef=next.visible; available=next.available===true;
      const v=next.visible;
      all=available?(next.rows??[]).filter(r=>r.identity.modelNumber===next.modelNumber && r.identity.assemblyId===next.assemblyId
        && (!v?.entityIds || v.entityIds.includes(r.identity.entityId)) && (!v?.labelChains || v.labelChains.includes(r.identity.labelChain))
        && (!v?.operatorIds || r.identity.operatorIds?.some(id=>v.operatorIds.includes(id)))):[];
      groups=[...new Set(all.map(r=>group(r.identity)))]; chain=groups[0]; query=null; page=0; chainPage=0; detail=anchor=undefined; mode='closed'; refilter(); invalidate();
    }
    if(keysRef!==next.selectionKeys) {
      keysRef=next.selectionKeys;
      const picked=all.find(r=>r.key===keysRef?.[0]);
      if(picked) { chain=group(picked.identity); query=null; refilter(); page=Math.floor(filtered.indexOf(picked)/pageSize); }
      invalidate();
    }
  }
  function caption() {
    const r=all.find(r=>r.key===detail)??filtered[page*pageSize];
    if(mode==='find') return `Find ${numbering==='author'?'author residue':'sequence position'} ${negative?'-':''}${digits}; editing digit ${digit+1} of 6. Matches include distinct insertion codes; choose the intended identity.`;
    if(mode==='chains') return `Chain ${chainLabel(chain)} of ${groups.length}. Choose a chain tab. Page ${chainPage+1} of ${Math.max(1,Math.ceil(groups.length/chainPageSize))}.`;
    return `${anchor?'Range start set. Choose an end in the same chain and copy. ':''}${r?describe(r):available?'No matching residues.':'This scene has no residue sequence.'} Chain ${chainLabel(chain)}. Page ${page+1} of ${pageCount()}.`;
  }
  function snapshot() {
    sync(); if(cache) return cache;
    const action=(op,extra={})=>({kind:'sequence',op,binding,version,...extra});
    // One id per row, and the same id every time that row is drawn.
    //
    // The id used to be `sequence-<op>-<key>`, so Previous and Next — both
    // `page`, neither with a key — were BOTH `sequence-page-`. A driver step
    // that named that id pressed whichever came first, which is Previous, and
    // `menu:sequence-next` could not be written at all. The id is the row's own
    // name now; everything the browser draws still starts `sequence-` so one
    // prefix rule in the driver covers every sub-row.
    const row=(label,op,extra={},disabled=false,id=op)=>({id:`sequence-${id}${extra.key?`-${extra.key}`:''}`,
      label:short(label),action:action(op,extra),...(disabled?{state:true}:{})});
    let rows=[];
    if(mode==='browse') rows=[...filtered.slice(page*pageSize,page*pageSize+pageSize).map(r=>row(`${keysRef?.includes(r.key)?'✓':''}${r.identity.componentId} ${r.identity.authorResidue??'?'}${r.identity.insertionCode??''}`,'detail',{key:r.key})),
      row('Previous','page',{delta:-1},page===0,'previous'),row('Next','page',{delta:1},(page+1)*pageSize>=filtered.length,'next'),
      row('Tools','tools'),row('Back','close')];
    if(mode==='detail') { const r=all.find(r=>r.key===detail); rows=[row('Identity','identity'),row('Select','select'),row('Start','start',{},r?.identity.labelSequenceId==null),row('End','end',{},!anchor||r?.identity.labelSequenceId==null),row('Focus','focus',{},r?.coordinateState!=='resolved'),row('Back','browse')]; }
    if(mode==='tools') rows=[row('Chains','chains'),row('Find','find'),row('Filter','search'),row('All rows','all'),row('Selected','selected'),row('Clear','clear'),row('No range','cancel-range'),row('Back','browse')];
    if(mode==='chains') rows=[...groups.slice(chainPage*chainPageSize,chainPage*chainPageSize+chainPageSize)
      .map(g=>row(`${g===chain?'✓':''}${chainLabel(g)}`,'chain-tab',{chain:g},false,`chain-${groups.indexOf(g)}`)),
    row('Previous','chain-page',{delta:-1},chainPage===0,'previous'),
    row('Next','chain-page',{delta:1},(chainPage+1)*chainPageSize>=groups.length,'next'),row('Back','browse')];
    // The pad's rows are `sequence-find-*` so one driver step name
    // covers the editor and nothing else, and the first of them is the value.
    if(mode==='find') rows=[row(findLabel(),'numbering',{},false,'find-value'),
      row('Digit ←','digit',{delta:-1},false,'find-digit-left'),row('Digit →','digit',{delta:1},false,'find-digit-right'),
      row('Value +','value',{delta:1},false,'find-up'),row('Value −','value',{delta:-1},false,'find-down'),
      row(negative?'Negative':'Positive','sign',{},false,'find-sign'),
      row('Go to','goto',{},false,'goto'),row('Back','browse')];
    cache=Object.freeze({available,open:mode!=='closed',rows:Object.freeze(rows),caption:caption(),binding,version,
      page,pageCount:pageCount(),pageSize,chain:chainLabel(chain),chains:groups.length,
      // The pad's own reading, published whether or not the pad is
      // open. `headset-drive.ts` reads it, so a `Value +` press that moved one
      // digit and nothing else is an outcome the driver can verify instead of
      // a press that changed nothing the page publishes.
      find:Object.freeze({editing:mode==='find',numbering,negative,digits,digit,value:findValue(),label:findLabel()})});
    return cache;
  }
  function act(a) {
    sync();
    if(a.binding!==binding || a.version!==version) throw Error('The sequence changed. Choose again.');
    if(!available) throw Error('This scene has no residue sequence.');
    let selection, focus;
    const r=all.find(r=>r.key===detail);
    switch(a.op) {
      case 'open': mode='browse'; break;
      case 'close': mode='closed'; break;
      case 'browse': case 'tools': case 'find': mode=a.op; break;
      case 'chains': chainPage=Math.max(0,Math.min(Math.ceil(groups.length/chainPageSize)-1,groups.indexOf(chain)<0?0:Math.floor(groups.indexOf(chain)/chainPageSize))); mode='chains'; break;
      case 'chain-page': chainPage=Math.max(0,Math.min(Math.ceil(groups.length/chainPageSize)-1,chainPage+a.delta)); break;
      // A chain tab names the chain it switches to, so a wearer with
      // four chains stops pressing one cycling row until the right one comes up.
      case 'chain-tab': { if(!groups.includes(a.chain)) throw Error('That chain is no longer in this scene.');
        chain=a.chain; query=null; page=0; detail=anchor=undefined; refilter(); mode='browse'; break; }
      /**
       * "go to residue 141".
       *
       * Reaching residue 141 of a hemoglobin chain cost 47 presses of `Next` on
       *. This pages straight to it and leaves its neighbours on the
       * page, which is what a wearer reading a sequence wants and what the
       * `Filter` row cannot give: filtering to 141 shows 141 and nothing else.
       * The number is read in whichever numbering the editor is on, the same
       * one the caption names, and a chain that has no such position is
       * refused by name rather than paged to the nearest thing.
       */
      case 'goto': {
        const wanted=a.residue===undefined?Number(digits)*(negative?-1:1):Number(a.residue);
        if(!Number.isFinite(wanted)) throw Error('A residue number is needed to go to one.');
        if(a.numbering==='author'||a.numbering==='sequence') numbering=a.numbering;
        query=null; refilter();
        const index=filtered.findIndex(r=>number(r)===wanted);
        if(index<0) throw Error(`Chain ${chainLabel(chain)} has no ${numbering==='author'?'author residue':'sequence position'} ${wanted}. Choose another chain or number.`);
        page=Math.floor(index/pageSize); detail=undefined; mode='browse';
        /*
         * `Go to` paged the
         * browser and left the camera where it was, so the answer to "go to
         * residue 141" was a list scrolled to 141 while the molecule showed
         * whatever it had been showing. Framing it is the rest of the answer.
         *
         * Only a residue whose coordinates resolved can be framed, the same
         * reading the `Focus` row is gated on, and a position without them
         * still pages: the page turn is the outcome that was asked for and the
         * camera move is the part that cannot be delivered.
         */
        if(filtered[index]?.coordinateState==='resolved') focus=[filtered[index].key];
        break; }
      case 'detail': if(!filtered.some(r=>r.key===a.key)) throw Error('That residue is no longer on this sequence.'); detail=a.key; mode='detail'; break;
      case 'identity': break;
      case 'page': page=Math.max(0,Math.min(pageCount()-1,page+a.delta)); break;
      case 'chain': chain=groups[(groups.indexOf(chain)+1)%groups.length]; query=null; page=0; detail=anchor=undefined; refilter(); mode='browse'; break;
      case 'all': query=null; refilter(); mode='browse'; break;
      case 'selected': { const picked=all.find(r=>r.key===keysRef?.[0]); if(!picked) throw Error('Nothing in this sequence is selected.'); chain=group(picked.identity); query=null; refilter(); page=Math.floor(filtered.indexOf(picked)/pageSize); mode='browse'; break; }
      case 'clear': selection=[]; break;
      case 'cancel-range': anchor=undefined; break;
      case 'numbering': numbering=numbering==='author'?'sequence':'author'; query=null; break;
      case 'digit': digit=(digit+a.delta+6)%6; break;
      case 'value': digits=digits.slice(0,digit)+((Number(digits[digit])+a.delta+10)%10)+digits.slice(digit+1); break;
      case 'sign': negative=!negative; break;
      case 'search': query=Number(digits)*(negative?-1:1); page=0; refilter(); mode='browse'; break;
      case 'select': if(!r) throw Error('Choose a residue first.'); selection=[r.key]; break;
      case 'focus': if(!r || r.coordinateState!=='resolved') throw Error('Focus requires resolved coordinates.'); focus=[r.key]; break;
      case 'start': if(!r || r.identity.labelSequenceId==null) throw Error('Range needs a polymer sequence position.'); anchor=r.key; mode='browse'; break;
      case 'end': { const start=all.find(r=>r.key===anchor); if(!r || !start || group(start.identity)!==group(r.identity) || r.identity.labelSequenceId==null || start.identity.labelSequenceId==null) throw Error('Range endpoints must share one chain and assembly copy.');
        const lo=Math.min(start.identity.labelSequenceId,r.identity.labelSequenceId),hi=Math.max(start.identity.labelSequenceId,r.identity.labelSequenceId);
        selection=all.filter(x=>group(x.identity)===group(r.identity) && x.identity.labelSequenceId!=null && x.identity.labelSequenceId>=lo && x.identity.labelSequenceId<=hi).map(x=>x.key); anchor=undefined; mode='browse'; break; }
      default: throw Error('Unknown sequence action.');
    }
    invalidate(); return {selection,focus,caption:caption(),open:mode!=='closed'};
  }
  return {snapshot,act};
}

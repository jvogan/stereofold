import { describe, expect, it, vi } from 'vitest';
import { READINESS_CAPABILITIES, type Readiness, type ReadinessCapability, type ReadinessItem } from '../src/inspection-contract.js';
import { createReadinessStrip, readinessStripView, renderReadinessStrip } from '../src/inspection-readiness-strip.js';

const details:Record<ReadinessCapability,string>={
  structure:'saved scene; desktop ready',
  share:'1 paired client (1 headset)',
  agent:'listened 1 s ago; the headset is told an agent is attached',
  transcription:'apple recognizer resolved',
  replies:'Headset reply audio: ready',
  headset:'adb sees Quest',
};

function reading(missing?:ReadinessCapability):Readiness {
  const items=READINESS_CAPABILITIES.map(capability=>({
    capability,label:capability,state:capability===missing?'missing':'ok',detail:details[capability],nextAction:'Nothing to do.',
  })) as ReadinessItem[];
  if(missing==='transcription') {
    const item=items.find(item=>item.capability==='transcription')!;
    item.detail='headset voice is off on this host';
    item.nextAction='Restart Stereofold with the microphone turned on.';
  }
  if(missing==='replies')items.find(item=>item.capability==='replies')!.detail='spoken replies are turned off';
  return {ready:missing===undefined,blocking:missing?[missing]:[],items,checkedAt:'2026-09-12T12:00:00.000Z'};
}

describe('the inspector readiness mapping',()=>{
  const cases:Array<[ReadinessCapability,ReadinessStripViewExpectation]>=[
    ['structure',{row:'lesson',instruction:'Load the saved view.'}],
    ['share',{row:'headset',instruction:'Open the headset connection.'}],
    ['agent',{row:'assistant',instruction:'Connect an assistant only if you want to speak through the headset microphone.'}],
    ['transcription',{row:'microphone',instruction:'Restart Stereofold with the microphone turned on.'}],
    ['replies',{row:'assistant',instruction:'Turn on the headset reply route, then restart Stereofold.'}],
    ['headset',{row:'headset',instruction:'Reconnect the headset.'}],
  ];
  for(const [capability,wanted] of cases)it(`maps missing ${capability} to its user-facing row`,()=>{
    const view=readinessStripView(reading(capability));
    const row=view.rows.find(candidate=>candidate.id===wanted.row)!;
    expect(view.collapsed).toBe(false);
    expect(row.state).toBe('missing');
    expect(row.action?.instruction).toBe(wanted.instruction);
  });

  it('collapses a fully ready reading to one quiet line',()=>{
    expect(readinessStripView(reading())).toMatchObject({collapsed:true,summary:'Headset microphone session ready.'});
  });

  it('scopes a missing responder to the optional headset microphone route',()=>{
    const assistant=readinessStripView(reading('agent')).rows.find(row=>row.id==='assistant');
    expect(assistant).toMatchObject({label:'Headset microphone assistant',headline:'Headset mic: not ready',state:'missing'});
    expect(assistant?.detail).toBe('The headset microphone has no responding assistant yet. Host voice is separate and is not checked here. Controls and narration still work.');
    expect(assistant?.observed).toBe(details.agent);
    expect(assistant?.action?.instruction).toBe('Connect an assistant only if you want to speak through the headset microphone.');
  });

  it('does not infer host voice availability from headset microphone readiness',()=>{
    for(const missing of [undefined,'agent','replies'] as const) {
      const readiness=reading(missing);
      const before=structuredClone(readiness);
      const assistant=readinessStripView(readiness).rows.find(row=>row.id==='assistant');
      expect(assistant?.detail).toContain('Host voice is separate and is not checked here.');
      expect(readiness).toEqual(before);
    }
  });

  it('uses the same plain detail when no assistant reading is available',()=>{
    const readiness=reading();
    readiness.items=readiness.items.filter(item=>item.capability!=='agent');
    expect(readinessStripView(readiness).rows.find(row=>row.id==='assistant')?.detail)
      .toBe('The headset microphone has no responding assistant yet. Host voice is separate and is not checked here. Controls and narration still work.');
  });

  it('keeps configured recognition neutral and preserves its detailed consent reason', () => {
    const value = reading();
    const item = value.items.find(row => row.capability === 'transcription')!;
    item.state = 'not-checked';
    item.detail = 'Apple recognizer at /local/applespeech; consent not yet observed';
    const view = readinessStripView(value);
    expect(view.collapsed).toBe(false);
    expect(view.rows.find(row => row.id === 'microphone')).toMatchObject({ label: 'Headset push-to-talk recognizer', state: 'not-checked',
      detail: 'The recognizer is ready. No headset push-to-talk recording has been heard yet. Talk and host voice are separate; this check does not cover either.', observed: item.detail });
    item.state = 'ok';
    expect(readinessStripView(value).rows.find(row => row.id === 'microphone')?.label).toBe('Headset push-to-talk capture observed');
  });

  it('does not treat local recognizer failure or success as proof of the separate Talk route',()=>{
    for(const state of ['missing','not-checked','ok'] as const) {
      const readiness=reading();
      const item=readiness.items.find(row=>row.capability==='transcription')!;
      item.state=state;
      const row=readinessStripView(readiness).rows.find(row=>row.id==='microphone')!;
      expect(row.label).toContain('push-to-talk');
      expect(row.detail).toContain('Talk and host voice are separate; this check does not cover either.');
      expect(row.state).toBe(state);
    }
  });

  it('keeps an unchecked headset neutral and keeps the full strip open',()=>{
    const readiness=reading();
    const headset=readiness.items.find(item=>item.capability==='headset')!;
    headset.state='not-checked';
    headset.detail='Optional headset debugging has not been checked.';
    const view=readinessStripView(readiness);
    expect(view.collapsed).toBe(false);
    expect(view.rows.find(row=>row.id==='headset')).toEqual({
      id:'headset',label:'Headset check',headline:'Paired over Wi-Fi',state:'not-checked',detail:'Pairing is retained. Check the live page for connection status; debugging is optional.',
      observed:'Optional headset debugging has not been checked.',
      action:{instruction:'Nothing to do.'},
    });
  });

  it('reads an open share with nothing paired as a launch in progress',()=>{
    const readiness=reading('share');
    const share=readiness.items.find(item=>item.capability==='share')!;
    share.detail='share open until 2026-09-12T12:30:00.000Z; nothing has paired';
    const view=readinessStripView(readiness);
    expect(view.rows.find(row=>row.id==='headset')).toMatchObject({
      label:'Headset check',headline:'Waiting for the headset',state:'not-checked',observed:share.detail,
      action:{id:'connect-headset',label:'Connect headset'},
    });
    expect(view.tone).toBe('neutral');
    share.detail='no private Wi-Fi share is open';
    expect(readinessStripView(readiness)).toMatchObject({tone:'attention'});
    expect(readinessStripView(readiness).rows.find(row=>row.id==='headset')?.headline).toBe('No headset');
  });

  it('names a paired Vision Pro instead of the Quest cable in the headset row',()=>{
    const readiness=reading();
    const headset=readiness.items.find(item=>item.capability==='headset')!;
    headset.detail='Apple Vision Pro page is connected over Wi-Fi; USB device state is Quest-only';
    expect(readinessStripView(readiness).rows.find(row=>row.id==='headset')).toMatchObject({
      label:'Headset connected',headline:'Vision Pro connected',state:'ok',detail:'Apple Vision Pro page is connected over Wi-Fi.',
    });
    headset.detail='adb sees QUEST2';
    expect(readinessStripView(readiness).rows.find(row=>row.id==='headset')?.headline).toBe('Headset connected');
  });

  it('shows the Apple waiting detail even while the share row is missing',()=>{
    const readiness=reading('share');
    const headset=readiness.items.find(item=>item.capability==='headset')!;
    headset.state='not-checked';
    headset.detail='Waiting for the Apple Vision Pro page; USB device state is Quest-only';
    expect(readinessStripView(readiness).rows.find(row=>row.id==='headset')).toMatchObject({
      headline:'Waiting for the Apple Vision Pro page',state:'not-checked',detail:headset.detail,
    });
  });

  it('calls a retained Vision Pro pairing paired while its page is away',()=>{
    const readiness=reading('share');
    const headset=readiness.items.find(item=>item.capability==='headset')!;
    headset.state='not-checked';
    headset.detail='Apple Vision Pro is paired over Wi-Fi; waiting for its page to reconnect; USB device state is Quest-only';
    expect(readinessStripView(readiness).rows.find(row=>row.id==='headset')).toMatchObject({headline:'Vision Pro paired',state:'not-checked'});
  });

  it('names what needs attention in one line and keeps the host wording as a tooltip',()=>{
    const readiness=reading();
    for(const [capability,state,detail] of [
      ['headset','not-checked','Optional headset debugging has not been checked.'],
      ['transcription','missing','headset voice is off on this host: Whisper recognizer at /opt/homebrew/bin/whisper-cli; model unresolved'],
      ['agent','missing','listener polled, but no conversation request has been processed'],
    ] as const) {
      const item=readiness.items.find(candidate=>candidate.capability===capability)!;
      item.state=state;item.detail=detail;
    }
    const view=readinessStripView(readiness);
    expect(view.summary).toBe('Paired over Wi-Fi · Headset push-to-talk off · Headset mic: not ready');
    const microphone=view.rows.find(row=>row.id==='microphone')!;
    expect(microphone.detail).toBe('Headset push-to-talk is off on this Mac. Talk and host voice are separate; this check does not cover either.');
    expect(microphone.detail).not.toMatch(/\/opt|whisper|STEREOFOLD/);
    expect(microphone.observed).toContain('/opt/homebrew/bin/whisper-cli');
    expect(view.rows.find(row=>row.id==='headset')?.observed).toContain('Optional headset debugging');
  });

  it('uses short, plain labels and actions for the corrected rows',()=>{
    const structure=readinessStripView(reading('structure')).rows[0];
    expect(structure).toMatchObject({label:'Structure ready',detail:'The structure is not ready.',
      action:{id:'load-saved-view',label:'Load saved view',instruction:'Load the saved view.'}});
    const replies=readinessStripView(reading('replies')).rows.find(row=>row.id==='assistant');
    expect(replies?.detail).toBe('Headset spoken replies are off. Turn on the headset reply route to hear answers. Host voice is separate and is not checked here.');
    const recognizer=reading('transcription');
    recognizer.items.find(item=>item.capability==='transcription')!.detail='missing local recognizer';
    recognizer.items.find(item=>item.capability==='transcription')!.nextAction='Install a voice recognizer, then restart Stereofold.';
    expect(readinessStripView(recognizer).rows.find(row=>row.id==='microphone')?.action?.instruction)
      .toBe('Install a voice recognizer, then restart Stereofold.');
  });

  it('retains both prerequisite repair and opt-in instructions when voice is off', () => {
    const readiness = reading('transcription');
    const item = readiness.items.find(row => row.capability === 'transcription')!;
    item.detail += '; recognizer prerequisites missing: a whisper model';
    item.nextAction = 'Set STEREOFOLD_WHISPER_MODEL to a readable model file, then enable capture and restart the host.';
    const row = readinessStripView(readiness).rows.find(row => row.id === 'microphone')!;
    expect(row.detail).toBe('Headset push-to-talk is off, and its recognizer needs setup. Talk and host voice are separate; this check does not cover either.');
    expect(row.action?.instruction).toBe(item.nextAction);
  });
});

type ReadinessStripViewExpectation={row:'lesson'|'headset'|'microphone'|'assistant';instruction:string};

describe('the inspector readiness DOM',()=>{
  function harness(){
    const makeElement=(tag='div')=>{
      const listeners:Record<string,(event?:unknown)=>void>={};
      const element:any={tagName:tag.toUpperCase(),dataset:{},className:'',textContent:'',children:[],disabled:false,
        setAttribute:vi.fn(),
        append(...nodes:unknown[]){element.children.push(...nodes);},
        replaceChildren(...nodes:unknown[]){element.children=[...nodes];},
        addEventListener(name:string,listener:(event?:unknown)=>void){listeners[name]=listener;},
        click(event?:unknown){listeners.click?.(event);},
      };
      return element;
    };
    return {document:{createElement:makeElement} as unknown as Document,makeElement};
  }

  it('renders one summary line with the details closed behind it',async()=>{
    const {document}=harness();
    const reload=vi.fn();
    const strip=createReadinessStrip(document,{'load-saved-view':reload});
    expect(()=>strip.update(reading('structure'))).not.toThrow();
    expect(strip.element.dataset.state).toBe('attention');
    const [details]=(strip.element as any).children;
    expect(details.tagName).toBe('DETAILS');
    const [summary,list]=details.children;
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.children[0].textContent).toBe('Structure not ready');
    expect(summary.children[1].textContent).toBe('Details');
    // Actions stay with their rows behind Details; the line itself carries none.
    expect(summary.children).toHaveLength(2);
    const lesson=list.children[0];
    expect(lesson.dataset.readinessRow).toBe('lesson');
    expect(lesson.dataset.state).toBe('missing');
    lesson.children[2].click();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('marks rows by state so a not-checked row never wears a check mark',()=>{
    const {document,makeElement}=harness();
    const root=makeElement('section') as HTMLElement;
    const readiness=reading();
    readiness.items.find(item=>item.capability==='headset')!.state='not-checked';
    renderReadinessStrip(root,readiness,{},document);
    const list=(root as any).children[0].children[1];
    const states=list.children.map((row:any)=>row.dataset.state);
    expect(states).toEqual(['ok','not-checked','ok','ok']);
    // An instruction row carries a <small>, never a button in the bullet column.
    expect(list.children[1].children[2].tagName).toBe('SMALL');
  });

  it('renders only the quiet line when everything is ready',()=>{
    const {document,makeElement}=harness();
    const root=makeElement('section') as HTMLElement;
    renderReadinessStrip(root,reading(),{},document);
    expect(root.dataset.state).toBe('ready');
    expect((root as any).children).toHaveLength(1);
    expect((root as any).children[0].textContent).toBe('Headset microphone session ready.');
  });
});

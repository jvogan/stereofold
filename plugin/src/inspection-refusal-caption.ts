import { z } from 'zod';
import { INSPECTION_SIZE_GUIDE, INSPECTION_SIZE_GUIDE_CAPTION } from './inspection-limits.js';

/** Observe validation failures without changing the schema or its issues.
 * `when` also runs for aborted field parses, before a tool handler can run.
 * Keep issues per parsed object so concurrent requests cannot exchange errors. */
export function observeVoiceRefusal<T extends z.ZodType>(schema:T,
  report:(input:any, issues:z.core.$ZodRawIssue[])=>Promise<void>):T {
  const failures=new WeakMap<object,z.core.$ZodRawIssue[]>();
  return schema.refine(async input=>{
    const issues=failures.get(input as object)!;
    failures.delete(input as object);
    try { await report(input,issues); }
    catch { /* Caption delivery cannot replace the original validation error. */ }
    return true;
  },{when:({value,issues})=>{
    if(!value || typeof value!=='object' || !('utteranceId' in value)
      || !z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).safeParse(value.utteranceId).success || !issues.length) return false;
    failures.set(value,issues);
    return true;
  }}) as T;
}

/** Wearer wording for validation; never print schema JSON on the plate. */
export function voiceValidationSentence(name:string,input:any,issues:z.core.$ZodRawIssue[]):string {
  return issues.map(issue=>{
    if(issue.path?.at(-1)==='representation') {
      let value=input;
      for(const key of issue.path??[]) value=value?.[key];
      return `Cannot show representation “${String(value)}”. Choose cartoon, sticks, surface or spheres.`;
    }
    if(issue.message?.endsWith('Range must be ordered.')) {
      const range=input.residues?.[String(issue.path?.at(-1))];
      if(Array.isArray(range)) return `Cannot select residues ${range.join('–')}: the start must come before the end.`;
    }
    if(issue.code==='unrecognized_keys') return `Cannot ${name==='focus_selection'?'focus that region':'apply that request'} with ${issue.keys.join(', ')}. ${issue.keys.includes('camera')?'The headset controls its own viewpoint.':'Those settings are unsupported.'}`;
    if(issue.code==='custom') return issue.message;
    const field=(issue.path??[]).map(String).join(' ').replace(/([a-z])([A-Z])/gu,'$1 $2').toLowerCase();
    return `Cannot apply that request: ${field || 'the arguments'} ${issue.message?.toLowerCase() || 'has an invalid value'}.`;
  }).join(' ');
}

/** Describe a region already refused by the resolver, using its saved model. */
export function missingVoiceRegion(catalog:any,modelNumber:number,query:any,pdbId?:string):string {
  const structure=pdbId ?? 'This structure';
  const rows=catalog.rows.filter((row:any)=>row.identity.modelNumber===modelNumber);
  for(const field of ['authorChain','labelChain'] as const) {
    if(query[field]===undefined) continue;
    const chains=[...new Set<string>(rows.map((row:any)=>row.identity[field]).filter((v:any)=>typeof v==='string'))];
    if(!chains.includes(query[field])) return `${structure} has no chain ${query[field]}. Chains are ${chains.join(', ') || 'unavailable'}.`;
  }
  const chain=query.authorChain!==undefined?` in chain ${query.authorChain}`
    :query.labelChain!==undefined?` in chain ${query.labelChain}`:'';
  const range=query.authorResidueRange ?? query.labelSequenceRange;
  const region=range?`${query.labelSequenceRange?'sequence positions':'residues'} ${range.join('–')}`:'matching residues';
  return `${structure} has no ${region}${chain}${query.componentId?` for ${query.componentId}`:''} in the saved model.`;
}

/** These calls maintain page state or speech; the scene action reports its outcome. */
export function isInspectionBookkeepingTool(name:string):boolean {
  return ['poll_inspection','detach_inspection','complete_inspection','attach_inspection','sync_inspection',
    'acknowledge_experience_step','voice_acknowledgement','claim_voice_intent',
    'acknowledge_voice_intent','acknowledge_voice_playback'].includes(name);
}

/** Bookkeeping for an old source may lose a race with a verified journey.
 * Keep its rejection and diagnostic; the journey reports its final outcome. */
export function shouldCaptionInspectionRefusal(name:string, message:string, transitionPending:boolean, staleBinding:boolean, journeyOwned=false) {
  if(name==='poll_inspection' || name==='detach_inspection')return false;
  const bookkeeping=name==='complete_inspection' || name==='attach_inspection';
  const sourceConflict=message==='This action belongs to a different structure.';
  // These page-owned calls can finish after navigation moved their source.
  // The journey reports failures itself; an obsolete audio request is dropped.
  // Dispatch and post-synthesis validation use different refusal sentences.
  // Ownership and source currency, not those words, determine caption ownership.
  if(isInspectionBookkeepingTool(name) && (journeyOwned || staleBinding))return false;
  return !(bookkeeping && sourceConflict && (transitionPending || staleBinding));
}

/** Translate caller instructions only at display boundaries. The host error
 * retains its tool hints; the wearer keeps the reason and an actionable line. */
export function inspectionRefusalCaption(message:string):string {
  return message
    // The wearer keeps the measured size, which is why it was
    // refused; the two caps are for whoever is choosing the next structure.
    .replaceAll(INSPECTION_SIZE_GUIDE, INSPECTION_SIZE_GUIDE_CAPTION)
    .replace(/Read get_inspection_state and use its current saved revisions before (?:changing the inspection|managing a view)\./g,
      'This request needs the current saved view. Try again after the view finishes saving.')
    .replaceAll('Read get_inspection_state; cancellation will not be retargeted.', 'The cancellation still applies only to the original view.')
    .replaceAll('Read get_inspection_state and use one of lesson.parts.', 'Choose one of this lesson’s named parts.')
    .replaceAll('Read get_inspection_state with residues to see what this model has.', 'Choose a residue present in the current model.')
    .replaceAll('Read visibilityTargets or get_inspection_state with residues to see what it has.', 'Choose a part present in the current model.')
    .replaceAll('Open the inspector with open_inspector, or reconnect the headset with open_companion, then try again.', 'Open the view on the Mac, or reconnect the headset, then try again.')
    .replaceAll('If the headset shows no Stereofold page, reconnect it with open_companion.', 'If the headset shows no Stereofold page, reconnect the headset.')
    .replace(/Keep that panel open, or call open_inspector to draw it in this Mac's browser, then call open_companion again([;.])/g,
      'Keep that view open, or open it on the Mac, then share it to the headset again$1')
    .replaceAll('An earlier open_companion request is still finishing with different connection options. Call again when it is done.',
      'An earlier headset connection is still starting with different options. Try again when it is done.')
    .replaceAll('Call open_companion again to reconnect.', 'Reconnect the headset.')
    .replaceAll('Call open_companion again.', 'Reconnect the headset.')
    // A wearer cannot call a tool; what remains is the scene they should rejoin.
    .replace(/Call continue_session to (\w)/g, (_, first: string) => first.toUpperCase())
    .replaceAll('Read get_inspection_state and choose that exact panelId.', 'Choose the current desktop view.')
    // A wearer reads this once the headset is showing again.
    .replaceAll('Send it again when get_inspection_state reports wearer.state "page-open" or "in-vr".', 'Ask again now that the headset shows the view.')
    .replace(/Read get_inspection_state(?: and (?:ask|try) again)?\./g, 'Try again with the current view.')
    .replaceAll('Check get_inspection_state with this commandId for its rendered receipt.', 'Wait for the view to confirm that it rendered.')
    .replaceAll('Open a lesson with inspect_lesson first.', 'Open a lesson first.')
    .replaceAll('Call prepare_composite again on this runtime host.', 'Prepare the composite again on this host.')
    .replaceAll('Call prepare_composite again.', 'Prepare the composite again.')
    .replaceAll('Pass the referent listen_voice returned, or name a part from lesson.parts.', 'Point to the part again, or name a part from the lesson.')
    .replaceAll('use focus_selection with the captured referent or explicitly name a lesson part.', 'ask to focus on the selected residues or name a lesson part.')
    .replaceAll('open the coordinate file with stereo_structure.inspect_file.', 'open the coordinate file.')
    .replaceAll('Say the rest in a second say_to_headset call.', 'Send the rest as a second reply.')
    .replaceAll('Clear it with manage_companion action="recover-browser".', 'Ask the desktop app to recover the headset browser.')
    .replaceAll('Stop its sharing from that session with manage_companion action="close",', 'Stop sharing from that session,')
    .replaceAll('Call open_companion with connection="lan" first.', 'Share the current view over private Wi-Fi first.')
    .replace(/Load one with replace_inspection_source\([^)]*\)\./g, 'Open a staged lesson first.')
    .replace(/Open one with inspect_lesson, for example [^.]+\.json\./g, 'Open a staged lesson first.')
    .replaceAll('The panel may call manage_companion with action status, close or revoke;', 'The panel can check, close or revoke sharing;');
}

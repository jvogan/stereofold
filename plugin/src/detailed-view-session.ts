import { z } from 'zod';
import { returnedResidueSchema, returnedSelectionKeys } from './detailed-view-return.js';
import { sessionIdSchema } from './schemas.js';

/**
 * The full Mol* viewer as a place the assistant can reach.
 *
 * Until now the handoff was a one-way errand. The wearer pressed Mol*, their
 * tab left the companion page, and from that moment the host had nobody to
 * talk to: `say_to_headset` had no page, `update_inspection` had no panel, and
 * the only thing the Mac could do was ask for the wearer back. So the one place
 * with the whole control tree, measurement and components was also the one
 * place where the assistant went quiet.
 *
 * The page already holds everything it needs to stop being a dead end. It has
 * the same page key the companion holds, the same private `/tool` route, and
 * the loaded structure. What it lacked was a name. This module gives it one:
 * `surface: 'detailed'`, a third panel surface beside `desktop` and
 * `companion`, so the registry knows the wearer is there and every channel that
 * already rides a panel heartbeat reaches them.
 *
 * Three contracts live here.
 *
 * One: what the page reports about the wearer's own picking in Mol*. A person
 * clicks a residue over there and asks "what is this". The click is a Mol*
 * loci, and the host speaks canonical residue keys, so the page sends the same
 * residue descriptors the return leg already sends and the host maps them the
 * same way. One mapper, two callers, no second idea of what a residue is.
 *
 * Two: what `get_inspection_state` says about all that, so an agent can tell
 * "the wearer is in the full viewer looking at these residues" from "the wearer
 * is gone".
 *
 * Three: the browser half, as source, for the same reason the emphasis and
 * return halves are source. The detailed page is a generated document rather
 * than a module graph, and `detailed-view-session.test.ts` evaluates this exact
 * string and drives it with fake Mol* objects.
 */

/** The registry surface a detailed page attaches as. */
export const DETAILED_SURFACE = 'detailed';

/**
 * The two pages the person in the headset can be on.
 *
 * Voice capture, spoken replies and the caption mailbox are all about the
 * wearer, and the wearer can be on the companion page or in the full Mol*
 * viewer. A desktop panel is neither: its microphone is on a desk and its
 * screen is not in front of anybody's eyes.
 */
export function isWearerSurface(surface: string | undefined): boolean {
  return surface === 'companion' || surface === DETAILED_SURFACE;
}

/** The most residues one selection report carries. A whole chain fits. */
export const DETAILED_SELECTION_LIMIT = 4_000;

/** How many canonical keys the state summary prints. The rest are counted. */
export const DETAILED_SELECTION_KEYS_SHOWN = 32;

/**
 * How long a reported selection is treated as what the wearer is looking at.
 *
 * The page reports on change rather than on a clock, so an old report is a
 * selection nobody has touched, not a lost one. It is still marked stale past
 * this, because "explain this part" should not resolve to a pick from five
 * minutes ago that the wearer has since cleared in some way the page missed.
 */
export const DETAILED_SELECTION_STALE_MS = 120_000;

export const detailedSelectionSchema = z.object({
  sessionId: sessionIdSchema,
  panelId: z.string().uuid(),
  residues: z.array(returnedResidueSchema).max(DETAILED_SELECTION_LIMIT),
  /** True when the page hit its own cap and sent a prefix. */
  truncated: z.boolean().optional(),
}).strict();
export type DetailedSelectionInput = z.output<typeof detailedSelectionSchema>;

/** What the host keeps about the wearer's picking inside the full viewer. */
export type DetailedSelection = {
  panelId: string;
  keys: string[];
  unmatched: number;
  truncated: boolean;
  at: number;
};

type CatalogRow = { key: string; identity: { modelNumber: number; copyId: string; labelChain: string; labelSequenceId: number | null;
  authorResidue: number | null; insertionCode: string | null; componentId: string } };

/**
 * One reported Mol* selection, mapped onto the panel's own residue identities.
 *
 * `returnedSelectionKeys` is the return leg's mapper and it is used unchanged.
 * A selection the wearer makes on the way to pressing Return and a selection
 * they make to ask a question are the same gesture, and the host must not have
 * two readings of it.
 */
export function detailedSelectionFrom(catalog: { rows: CatalogRow[] }, modelNumber: number,
  input: Pick<DetailedSelectionInput, 'panelId' | 'residues' | 'truncated'>, at: number): DetailedSelection {
  const { keys, unmatched } = returnedSelectionKeys(catalog, modelNumber, input.residues);
  return { panelId: input.panelId, keys, unmatched, truncated: input.truncated === true, at };
}

/**
 * What `get_inspection_state` says about the full viewer.
 *
 * `present` is a live detailed panel on the current binding. The selection is
 * reported whether or not that panel is still there, because a wearer who has
 * just pressed Return is still asking about the thing they picked; `stale` is
 * how a reader tells the two apart.
 */
export function detailedViewSummary(options: {
  panels: ReadonlyArray<{ panelId: string; surface?: string; availability?: string; current?: boolean }>;
  selection?: DetailedSelection;
  now: number;
}) {
  const detailed = options.panels.filter(panel => panel.surface === DETAILED_SURFACE);
  const panel = detailed.find(entry => entry.current === true) ?? detailed[0];
  const selection = options.selection;
  if (!panel && !selection) return undefined;
  const ageMs = selection ? Math.max(0, options.now - selection.at) : undefined;
  return {
    present: Boolean(panel),
    ...(panel ? { panelId: panel.panelId, availability: panel.availability ?? 'unknown', current: panel.current === true } : {}),
    ...(selection ? {
      selection: {
        panelId: selection.panelId,
        selectedResidues: selection.keys.length,
        unmatched: selection.unmatched,
        truncated: selection.truncated,
        ageMs: ageMs ?? 0,
        stale: (ageMs ?? 0) >= DETAILED_SELECTION_STALE_MS || !panel || panel.panelId !== selection.panelId,
        selectionKeys: selection.keys.slice(0, DETAILED_SELECTION_KEYS_SHOWN),
      },
    } : {}),
  };
}

/**
 * The browser half of the detailed session, as source.
 *
 * Everything here is pure or takes its collaborators as arguments, so the test
 * drives it with fake Mol* objects and a fake transport rather than a browser.
 */
export const DETAILED_VIEW_SESSION_SOURCE = String.raw`(() => {
  /**
   * The changes the full viewer can honestly draw.
   *
   * Appearance, selection and emphasis are pictures of the saved scene, and
   * this page draws the saved scene. Placement, camera, motion, focus, tour and
   * render quality are the headset panel's: they move a molecule seated in a
   * room, run a lesson, or spend a frame budget that belongs to a device this
   * page is not. A command for one of those is refused with a sentence the
   * wearer can act on, never drawn badly and reported as rendered.
   */
  var DRAWN = {appearance: true, selection: true, emphasis: true};
  function renders(kind) { return DRAWN[kind] === true; }
  function refusal(kind) {
    if (kind === 'placement' || kind === 'focus' || kind === 'motion') return 'The full viewer does not move the molecule.';
    if (kind === 'camera') return 'The full viewer keeps its own camera.';
    if (kind === 'tour') return 'A lesson plays in the headset, not here.';
    if (kind === 'render-quality') return 'Render quality belongs to the headset panel.';
    return 'The full viewer cannot draw that change.';
  }
  /**
   * inspection-contract.ts expectedInspection, for the kinds above.
   *
   * It has to agree exactly, because the host compares the scene this page
   * reports against its own expectation field by field. normalizeAppearance is
   * a spread over the saved appearance plus a range check the host has already
   * run on the patch, so the spread below reproduces it, key order included.
   */
  function nextScene(scene, change) {
    if (!scene || !change || !renders(change.kind)) return null;
    var next = JSON.parse(JSON.stringify(scene));
    if (change.kind === 'appearance') {
      next.inspection.appearance = Object.assign({}, scene.inspection.appearance, change.patch);
      if (next.inspection.lessonFigure && Object.prototype.hasOwnProperty.call(change.patch, 'representation'))
        next.inspection.lessonFigure.representationOverride = change.patch.representation;
    }
    else if (change.kind === 'selection') next.selectionKeys = (change.patch.selectionKeys || []).slice();
    else if (change.kind === 'emphasis') next.inspection.emphasis = JSON.parse(JSON.stringify(change.patch));
    return next;
  }
  /**
   * A plugin facade that remembers every object the painters create.
   *
   * A repaint has to remove the page's own picture and leave the wearer's work
   * alone. The components and representations somebody built over here by hand
   * are theirs; the ones this page drew for them are a picture of saved state
   * and are replaced wholesale. Recording the refs on the way out is the only
   * way to tell one from the other, and it costs the painters nothing: they
   * reach for exactly these two builder calls.
   */
  function recordingPlugin(plugin, refs) {
    var builders = plugin.builders, structure = builders.structure;
    return {
      build: function () { return plugin.build(); },
      canvas3d: plugin.canvas3d,
      managers: plugin.managers,
      builders: {
        data: builders.data,
        structure: {
          representation: {
            addRepresentation: async function (target, params) {
              var made = await structure.representation.addRepresentation(target, params);
              if (made && made.ref) refs.push(made.ref);
              return made;
            },
          },
          tryCreateComponentFromSelection: async function (target, params, key, tags) {
            var made = await structure.tryCreateComponentFromSelection(target, params, key, tags);
            if (made && made.ref) refs.push(made.ref);
            return made;
          },
          tryCreateComponentStatic: function (target, kind) { return structure.tryCreateComponentStatic(target, kind); },
        },
      },
    };
  }
  /** Remove the page's own picture, children before parents, and never throw. */
  async function clearPainted(plugin, refs) {
    if (!refs.length) return 0;
    var removed = refs.length;
    try {
      var build = plugin.build();
      for (var index = refs.length - 1; index >= 0; index -= 1) build.delete(refs[index]);
      await build.commit();
    } catch (error) { removed = 0; }
    refs.length = 0;
    return removed;
  }
  /**
   * One residue descriptor per line, so a repeated report is recognized.
   *
   * Mol* fires its selection event for a highlight change too, and the page
   * would otherwise post the same pick to the Mac several times a second.
   */
  function selectionSignature(residues) {
    return (residues || []).map(function (residue) {
      return [residue.assemblyId, (residue.operatorIds || []).join('+'), residue.labelChain, residue.componentId,
        residue.insertionCode, residue.labelSequenceId, residue.authorResidue].join('|');
    }).join(';');
  }
  /** Retain failed reports for retry, and expose both collection and transport failures. */
  function createSelectionReporter(options) {
    var signature, lastPanel, busy = false, seq = 0, entries = [];
    function failed(phase, error) {
      var name = String(error && error.name || 'Error').slice(0, 200);
      var message = String(error && error.message || error).replace(/https?:\/\/[^\s]+/g, '[url]').slice(0, 200);
      entries.push({seq: ++seq, at: Date.now(), kind: 'page-error',
        detail: {phase: 'selection-' + phase, name: name, message: message}});
      if (entries.length > 24) entries.shift();
      options.warn('Selection not sent (' + phase + '): ' + name + ': ' + message);
      options.status('Selection not sent. ' + name + ': ' + message);
    }
    return {
      diagnostics: function () { return entries.length ? {entries: entries.slice()} : undefined; },
      acknowledge: function (ack) { if (typeof ack !== 'number') return; entries = entries.filter(function (entry) { return entry.seq > ack; }); },
      reset: function () { signature = undefined; lastPanel = undefined; },
      report: async function () {
        var panel = options.panel();
        if (!panel || busy) return;
        busy = true;
        var phase = 'collect';
        try {
          var gathered = options.collect();
          var next = selectionSignature(gathered.residues) + ':' + (gathered.truncated === true);
          if (signature === next && lastPanel === panel) return;
          phase = 'report';
          await options.post('report_detailed_selection', {panelId: panel, residues: gathered.residues,
            truncated: gathered.truncated === true});
          signature = next; lastPanel = panel;
          options.status('Selection sent: ' + gathered.residues.length + ' residues.');
          if (options.sent) options.sent(gathered.residues.length);
        } catch (error) { signature = undefined; failed(phase, error); }
        finally { busy = false; }
      },
    };
  }
  /** A caption clip as something an audio element can play, or an empty string. */
  function captionAudioUrl(caption) {
    var audio = caption && caption.audio;
    if (!audio || typeof audio.base64 !== 'string' || audio.base64.length < 4) return '';
    var mime = typeof audio.mimeType === 'string' && audio.mimeType ? audio.mimeType : 'audio/wav';
    return 'data:' + mime + ';base64,' + audio.base64;
  }
  /**
   * One reply as the ordered segments this page plays.
   *
   * A long answer arrives as several clips on one caption. They are played one
   * at a time, the caption line showing whichever is sounding, so the wearer
   * hears the whole answer instead of its first sentence. A caption from a Mac
   * that predates segments reads back as the single segment it always was.
   */
  function captionSegments(caption) {
    var listed = caption && Array.isArray(caption.segments) ? caption.segments : [];
    var out = [];
    for (var index = 0; index < listed.length && out.length < 32; index++) {
      var entry = listed[index];
      var line = entry && typeof entry.text === 'string' ? entry.text.trim() : '';
      if (!line) continue;
      out.push({text: line, url: captionAudioUrl(entry),
        seconds: entry && entry.seconds > 0 ? entry.seconds : 0});
    }
    if (out.length) return out;
    var whole = caption && typeof caption.text === 'string' ? caption.text.trim() : '';
    if (!whole) return [];
    return [{text: whole, url: captionAudioUrl(caption), seconds: 0}];
  }
  /**
   * "say return when done", answered by the page itself.
   *
   * The handoff line the wearer hears on the way out names one word, so that
   * word has to work without an agent in the room. It can: the final
   * push_to_talk_audio call answers with the transcript the Mac just made, so
   * a hold-to-talk press on this page is a whole spoken round trip with no new
   * route, no second microphone and nothing kept.
   *
   * Only the going-home phrases are matched here. Everything else is left
   * alone and reaches the assistant through the same queue it always did, so
   * this cannot swallow a question about the structure.
   *
   * Deliberately narrow. The bare word "back" is in, because on this page it
   * can only mean the way home — there is no tour here for it to step. Anything
   * with more in it than leaving ("go back to the cartoon view") misses,
   * because a phrase is matched whole rather than searched.
   */
  var RETURN_PHRASES = ['return', 'returns', 'return now', 'return to the headset', 'return to headset',
    'return to vr', 'go back', 'go back now', 'back', 'take me back', 'bring me back', 'back to the headset',
    'back to headset', 'back to headset view', 'back to vr', 'go back to vr', 'go back to the headset',
    'done', 'im done', 'i am done', 'all done', 'that is all', 'thats all', 'finished', 'im finished',
    'take me home', 'go home'];
  function isReturnRequest(text) {
    if (typeof text !== 'string') return false;
    // Apostrophes close rather than split, so "I'm done" is one word short of
    // "im done" instead of the three-word "i m done" a plain strip would make.
    var normalized = text.normalize('NFKC').toLowerCase().replace(/['‘’ʼ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 60) return false;
    // The same cosmetic openers the headset grammar drops, and only at the
    // front, so nothing becomes a command by hiding a meaningful word.
    normalized = normalized.replace(/^(?:(?:ok|okay|hey|please|now|can you|could you|lets|let us|just|stereofold|jarvis)\s+)+/, '');
    normalized = normalized.replace(/(?:\s+(?:please|now|thanks|thank you))+$/, '');
    return RETURN_PHRASES.indexOf(normalized) !== -1;
  }
  /** Resolve against the actual available return controls, without navigating yet. */
  function resolveReturnRequest(text, options) {
    if (!isReturnRequest(text)) return;
    var home = options.returnButton, back = options.back;
    var target = home && !home.hidden && !home.disabled ? home
      : back && !back.hidden && !back.disabled ? back : undefined;
    if (!target) return;
    return function () {
      if (options.say) options.say('Going back to the headset.');
      target.click();
    };
  }
  /** The first recording type this browser admits, or an empty string. */
  function pickRecordingMime(Recorder, candidates) {
    if (!Recorder) return '';
    for (var candidate of candidates) {
      try { if (typeof Recorder.isTypeSupported !== 'function' || Recorder.isTypeSupported(candidate)) return candidate; }
      catch (error) { /* A recorder that refuses the question is asked the next one. */ }
    }
    return '';
  }
  /**
   * Hold to talk, on the page that used to have no microphone at all.
   *
   * The same route the headset page uses: one-second chunks of the browser's
   * own recording, posted to push_to_talk_audio on the bearer this page already
   * holds, transcribed on the Mac and never sent anywhere else. The recorder
   * and the media request are arguments so a test can drive a whole utterance
   * without a browser.
   */
  function createTalk(options) {
    var post = options.post, uuid = options.uuid, toBase64 = options.toBase64;
    var Recorder = options.Recorder, getMedia = options.getMedia;
    var mime = '', stream, recorder, utteranceId = '', seq = 0, stopping = false, starting = false;
    var releasePending = false, finalQueued = false, writes = Promise.resolve();
    var say = options.say || function () {};
    var maxMs = options.maxMs || 20000, timer;
    var onTranscript = options.onTranscript;
    var resolveTranscript = options.resolveTranscript;
    /** One conversion/upload/finalize sequence for the recording now open. */
    function enqueue(work) {
      var run = writes.then(work, work);
      writes = run.catch(function () {});
      return run;
    }
    async function send(base64, final) {
      if (!utteranceId) return;
      if (seq > (options.maxSeq || 4095)) return;
      // Claim the number before transport yields. A failed or delayed POST can
      // never leave its number available to a later chunk or final marker.
      var assigned = seq;
      seq += 1;
      var answer = await post('push_to_talk_audio', {utteranceId: utteranceId, seq: assigned, mime: mime,
        ...(base64 ? {data: base64} : {}), final: final});
      // The closing call is the one that carries the
      // words back. The Mac transcribes on this machine and hands the record
      // to whoever asked; the page reads it only to hear "return".
      if (!final) return;
      var record = answer && answer.structuredContent && answer.structuredContent.transcript;
      var text = record && typeof record.text === 'string' ? record.text : '';
      if (!text) return;
      if (record.pageDecision) {
        // Resolve without effects; execute only after the host accepts local ownership.
        var action;
        try { action = resolveTranscript && resolveTranscript(text); } catch (error) {}
        var decisionArgs = {utteranceId: record.utteranceId, seq: assigned,
          mime: mime, final: true, pageDecision: {token: record.pageDecision, handled: typeof action === 'function'}};
        var decision = await post('push_to_talk_audio', decisionArgs).catch(function () {
          return post('push_to_talk_audio', decisionArgs);
        });
        if (decision && decision.structuredContent && decision.structuredContent.handled && action) action();
      } else if (onTranscript) {
        try { onTranscript(text); } catch (error) { /* Legacy host. */ }
      }
    }
    function finalize(opened) {
      if (finalQueued) return writes;
      finalQueued = true;
      return enqueue(async function () {
        try { await send('', true); } catch (error) { say('The Mac did not take that recording.'); }
        finally {
          if (recorder === opened) recorder = undefined;
          stopping = false;
          utteranceId = '';
        }
      });
    }
    function stopRecorder(announce) {
      if (!recorder || stopping) return false;
      stopping = true;
      if (timer) clearTimeout(timer);
      var opened = recorder;
      try { recorder.stop(); } catch (error) { void finalize(opened); }
      if (announce) say('Thinking about that.');
      return true;
    }
    return {
      /** True while an utterance is open. */
      get recording() { return Boolean(recorder) || starting; },
      async start() {
        if (recorder || starting) return false;
        mime = pickRecordingMime(Recorder, options.mimeTypes || []);
        if (!mime) { say('This browser cannot record. Use the headset menu.'); return false; }
        starting = true; releasePending = false; stopping = false;
        try { stream = stream || await getMedia(); }
        catch (error) {
          starting = false; releasePending = false;
          say('The microphone is not allowed here.'); return false;
        }
        utteranceId = uuid(); seq = 0; stopping = false;
        finalQueued = false; writes = Promise.resolve();
        var opened = recorder = new Recorder(stream, {mimeType: mime});
        recorder.ondataavailable = async function (event) {
          if (finalQueued) return;
          return enqueue(async function () { try {
            var blob = event && event.data;
            if (!blob || !blob.size) return;
            await send(await toBase64(blob), false);
          } catch (error) { /* One lost chunk is not a lost utterance. */ } });
        };
        recorder.onstop = function () { return finalize(opened); };
        recorder.start(options.timesliceMs || 1000);
        starting = false;
        timer = setTimeout(function () { stopRecorder(false); }, maxMs);
        say('Listening.');
        if (releasePending) stopRecorder(true);
        return true;
      },
      stop() {
        // A release can beat microphone permission. Remember it, then close
        // immediately after the recorder exists instead of waiting for timeout.
        if (starting && !recorder) {
          if (releasePending) return false;
          releasePending = true;
          return true;
        }
        return stopRecorder(true);
      },
    };
  }
  /**
   * One heartbeat, as a decision rather than a side effect.
   *
   * The page posts poll_inspection and this says what came back: the refreshed
   * binding, a caption to show, a change to draw, or a change to refuse. The
   * loop around it does the drawing and the posting, so the decision itself is
   * testable without a viewer.
   */
  function readBeat(answer, currentScene) {
    var state = (answer && answer.structuredContent) || {};
    var priv = (answer && answer.private) || {};
    var binding = state.serverEpoch ? {serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
      baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision} : undefined;
    var delivery = priv.delivery;
    var shown = priv.scene || currentScene;
    // The stock full viewer currently draws the base and emphasis, but does
    // not paint authored figure layers. Preserve that scene and refuse a
    // global figure-style command rather than save an override it never drew.
    var figureStyle = Boolean(delivery && delivery.change.kind === 'appearance'
      && Object.prototype.hasOwnProperty.call(delivery.change.patch || {}, 'representation')
      && shown && shown.inspection && shown.inspection.lessonFigure);
    return {
      attached: state.attached !== false,
      binding: binding,
      caption: priv.headsetCaption,
      follow: priv.scene,
      delivery: delivery,
      draws: Boolean(delivery && !figureStyle && renders(delivery.change.kind)),
      refusal: figureStyle ? 'Change the lesson figure style in the linked headset or inspector.'
        : delivery && !renders(delivery.change.kind) ? refusal(delivery.change.kind) : '',
    };
  }
  return {renders: renders, refusal: refusal, nextScene: nextScene, recordingPlugin: recordingPlugin,
    clearPainted: clearPainted, createSelectionReporter: createSelectionReporter, selectionSignature: selectionSignature, captionAudioUrl: captionAudioUrl,
    captionSegments: captionSegments,
    pickRecordingMime: pickRecordingMime, createTalk: createTalk, readBeat: readBeat,
    isReturnRequest: isReturnRequest, resolveReturnRequest: resolveReturnRequest};
})()`;

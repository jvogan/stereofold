/**
 * Presentation-only choices. Molecular actions remain in the viewer.
 *
 * Labels are host-neutral. One build serves Claude Code, Codex and Claude
 * Science, so the voice row names the wearer's guide, never the product
 * behind it. And they are short, to `MENU_LABEL_BUDGET_CHARACTERS`, because a
 * row's width is the only thing that decides how much of the wearer's lens the
 * menu takes.
 */

/**
 * The longest a MENU ROW label may be, in characters, at the shipped seat.
 *
 * Menu rows only. Caption readout rows (the plate title, the page row, the
 * body) are not subject to this budget: `createToolbarPanel` wraps them
 * inside the caption glass at the width the eye leaves, so a long tier row
 * (`Protofilament 1/5`) or a refusal row (`Wall · Quest 2 limit`) wraps to
 * a second line instead of clipping, and the plate width never changes.
 * `growth-caption.mjs` owns that rule; this budget must never trim it.
 *
 * This is a geometry number written as a content one. A row plate is as wide as
 * its widest label, the panel is as wide as its widest plate, and
 * `toolbarSeatDegrees` in `spatial-toolbar-geometry.mjs` then seats the panel
 * wherever its outboard corner still clears the lens -- so every extra
 * character pulls the whole menu INBOARD, across the structure. The type cannot
 * pay for it: Meta's 14 dp minimum body size at 500 dp per metre is a 0.028 m
 * cap, 1.7 degrees at the panel's 0.95 m range, and distance scales the panel
 * and its type together, so a character costs the same angle wherever the panel
 * is put.
 *
 * The raw column plate can carry ten glyph-widths after its fixed row pad:
 * floor((2 * (0.36 * 0.48 - 0.030)) / (0.050 * 0.54)) = 10. The effective
 * semantic label budget is nine so `Move menu` names its target explicitly.
 * It draws on two short lines, preserving the narrow column and type size.
 */
export const MENU_LABEL_BUDGET_CHARACTERS = 9;

/**
 * How many rows the compact panel lays out at full size.
 *
 * This is `SPATIAL_TOOLBAR_LAYOUT.comfortRows` in `spatial-toolbar-geometry.mjs`,
 * repeated rather than imported so this module stays import-free and runs under
 * Node on its own. A test pins the two together. One row past it and the panel
 * steps down a density, which shrinks every label at once, mid-lesson.
 */
export const COMPACT_ROW_BUDGET = 9;

/**
 * The render budget, in the order the row cycles it.
 *
 * A molecular surface can look coarse in the headset, and the wearer needs a
 * way to force more detail without leaving the session. `balanced` is the
 * default and the most a Quest 2 holds at 72 Hz; `best` trades frame rate for
 * detail; `fast` is the cheapest tier.
 */
export const RENDER_QUALITY_LEVELS = Object.freeze(['fast', 'balanced', 'best']);
/** Coordinate representations, in the order a wearer cycles them. */
export const MOLECULAR_REPRESENTATIONS = Object.freeze(['ball-and-stick', 'cartoon', 'spacefill', 'molecular-surface']);
const MOLECULAR_REPRESENTATION_LABELS = Object.freeze({
  'ball-and-stick': 'Atoms', cartoon: 'Ribbons', spacefill: 'Spacefill', 'molecular-surface': 'Surface',
});

/** Skip representations unavailable for the current source. */
export function nextMolecularRepresentation(current, supported = MOLECULAR_REPRESENTATIONS) {
  const choices = MOLECULAR_REPRESENTATIONS.filter(value => supported?.includes(value));
  if (!choices.length) return undefined;
  const index = choices.indexOf(current);
  return choices[(index + 1) % choices.length];
}
/**
 * The plate carries `MENU_LABEL_BUDGET_CHARACTERS`, which is why the level is a
 * number rather than a word: `Quality: Balanced` is seventeen and `Quality: mid`
 * twelve, and every character past eight drags the whole menu across the
 * structure. The spoken confirmation and the desktop select say the level in
 * full; this is the same three counted off in a row's width.
 */
const RENDER_QUALITY_LABELS = Object.freeze({ fast: 'Detail 1', balanced: 'Detail 2', best: 'Detail 3' });

/** Stable automation identity for a row whose wearer-facing label can change. */
export function spatialToolbarRowId(action = {}) {
  switch (action.kind) {
    case 'voice-toggle': return 'talk';
    case 'open-workbench': return 'molstar';
    case 'tour-menu': case 'tour-choice': return 'tours';
    case 'recenter-structure': case 'reset': return 'reset';
    case 'passthrough': return 'room';
    case 'tour-play': return 'tour';
    case 'tour-back': return 'back';
    case 'tour-next': return 'next';
    case 'tour-done': return 'done';
    case 'tour-page': return 'page';
    case 'readout-page': return 'description-page';
    case 'collapse': return 'menu';
    case 'mode': return 'mode';
    case 'room-placement': return action.target === 'overhead' ? 'above' : 'reach';
    case 'toggle-motion': return 'motion';
    case 'fit': return 'fit';
    case 'render-quality': return 'quality';
    case 'scale': return action.direction < 0 ? 'scale-down' : 'scale-up';
    case 'nudge': return `${action.axis}-${action.direction < 0 ? 'down' : 'up'}`;
    case 'appearance': return `appearance-${action.preset}`;
    case 'appearance-cycle': return 'appearance';
    case 'recenter-menu': return 'move';
    default: return String(action.kind ?? 'unknown');
  }
}

/**
 * The level one tap on the quality row selects next; wraps best back to fast.
 * A level this module does not know resolves to the default rather than to the
 * cheapest tier: a wearer pressing an unreadable row should not land on `fast`.
 */
export function nextRenderQuality(level) {
  const index = RENDER_QUALITY_LEVELS.indexOf(level);
  return index < 0 ? 'balanced' : RENDER_QUALITY_LEVELS[(index + 1) % RENDER_QUALITY_LEVELS.length];
}

export function spatialToolbarRows({ tour, voice, collapsed = true, mode = 'move', paused = true, passthrough, passthroughSupported, quality, sequence, connection, appearance, representations, history, lessonFigure,
  quiet = false, readout } = {}) {
  // The voice row is the microphone's state light. The floating talk orb that
  // used to carry that state was deleted — a wearer's words
  // were "orb is distracting and in the way" — so this row and the status line
  // above the grid are the only places a wearer can see whether the microphone
  // is open, working or finished. `Talk` is the only one of these that is an
  // instruction; the rest report.
  const reported = typeof voice?.state === 'string' ? voice.state : 'idle';
  // A lesson reading itself out is not an answer to anybody. Treating it as a
  // microphone state makes the row say `Answering…` for the length of a tour
  // chapter, with nothing to answer and nobody having asked. Worse, `playing`
  // also recesses the row, so the light says the microphone is busy while it is
  // in fact free.
  //
  // Narration is therefore not a microphone state at all. The row reads `Talk`
  // and stays pressable through a chapter, and that press interrupts the
  // narration -- which is exactly what reaching for the microphone mid-
  // sentence means. `voice.kind` comes from `voiceInteraction.playbackKind()`;
  // a caller that does not report one is a reply, as before.
  const narrating = reported === 'playing' && voice?.kind === 'narration';
  const voiceState = narrating ? 'idle' : reported;
  // Each of these is the same state light in eight characters or fewer. The
  // trailing ellipsis marks the two states that are still working; `No voice`
  // and `Talk` are settled.
  const voiceLabel = connection?.line ? 'No link' : ['listening', 'starting', 'recording'].includes(voiceState) ? 'Mic on…'
    : ['sending', 'transcribing'].includes(voiceState) ? 'Hearing…'
    : voiceState === 'playing' ? 'Reply…'
    : voiceState === 'error' ? 'No voice' : 'Talk';
  const voiceBusy = Boolean(connection?.line) || ['sending', 'transcribing', 'playing', 'error'].includes(voiceState);
  // Two routes open the full Mol* viewer. This row's press, `open-workbench`
  // with no target, loads the viewer in this same Quest Browser tab and ends
  // the immersive session (viewer.mjs, `openDetailedViewOnHost()` with
  // `preferHere` true). The spoken "open it on the Mac" dispatches the same
  // kind with `target: 'mac'`, which opens the viewer on the Mac monitor and
  // leaves the session running. The row is named for what it opens.
  // A row that only reports state gets `state: true`. The geometry draws it
  // as a recessed chip and the hit test refuses it, so a wearer never presses
  // a label that was never a button. A row with `accent: true` is a primary
  // action and gets the brighter plate.
  const voiceControls = voice ? [[voiceLabel, { kind: 'voice-toggle' }, voiceBusy, true]] : [];
  if (connection?.recovery) voiceControls.push(['Re-pair', { kind: 'reconnect' }, false, true]);
  // The wearer, in the headset, on the 11:08 pass: "where is the seamless
  // switch to Mol*??". It was there, buried eight rows down inside the
  // expanded grid, so nobody who had not been told found it. It is a top-level
  // row now, named for what it opens rather than for where it opens.
  if (sequence?.open) return [
    ...voiceControls.map(([label,action,state,accent]) => ({id:'talk',label,action,...(state?{state:true}:{}),...(accent?{accent:true}:{})})),
    ...sequence.rows,
  ];
  const sequenceRow = sequence?.available ? [['Sequence', {kind:'sequence',op:'open',binding:sequence.binding,version:sequence.version}]] : [];
  const workbenchRow = ['Mol*', { kind: 'open-workbench' }];
  // The lesson chooser leaves the collapsed set to keep it to five rows. It
  // stays one press away under Menu, and comes back to the top level while
  // the chooser is open, because that is the row that cycles the choices.
  // `Tours` opens the chooser; while it is open the same row advances to the
  // next lesson, so it is named for that instead. `Next one` rather than `Next`
  // because the chapter row beside it is already `Next`.
  const chooserRow = [tour?.menuOpen ? 'Next one' : 'Tours', { kind: tour?.menuOpen ? 'tour-choice' : 'tour-menu' }];
  // Pushing a stick moves the structure and it can be pushed out of the room.
  // The only ways back used to be an unlabelled controller button and a spoken
  // command, neither of which a wearer can discover. It is a row now, directly
  // under the primary action, so there is always something visible to press.
  // `kind` is
  // the same `recenter-structure` the button and the voice command dispatch,
  // guard and confirmation included -- there is one seat, not three.
  //
  // Compact only. The expanded grid's `Fit` already runs this exact seat while
  // a session is presenting, and a grid carrying `Fit`, `Reset` and
  // `Reset view` teaches the wearer nothing.
  const resetRow = ['Reset', { kind: 'recenter-structure' }];
  // Passthrough used to live only on the companion page under More options,
  // which is a 2D control a wearer cannot reach once the headset is on. This
  // row is the way to it from inside the session. Without a live `passthrough`
  // value the label names the feature; pass one and the row names the state
  // instead. The action carries no target either way, so the press is a toggle;
  // the spoken phrases carry an explicit `on`.
  //
  // The label reads the state, not the press. A wearer deciding whether to
  // press has to be able to see which one they are already in; "Hide room"
  // says what the press does and nothing about where they are. The press is
  // still the opposite of the state, and the action still carries it
  // explicitly.
  //
  // The press costs no session either way: in the passthrough session both
  // directions are the frame's clear, so the row toggles the room in place and
  // the label flips on the next refresh.
  //
  // The wording is the state in the wearer's own terms rather than the feature
  // name and a value: `Passthrough: off` is sixteen characters against the
  // eight-character budget this file's header derives, and every character over
  // it drags the whole menu across the structure.
  const passthroughRow = passthrough === false && passthroughSupported === false
    ? ['No room', { kind: 'passthrough', on: true }, true]
    : passthrough === false && passthroughSupported === null
      ? ['Room?', { kind: 'passthrough', on: true }, true]
    : typeof passthrough === 'boolean'
    ? [passthrough ? 'Room on' : 'Room off', { kind: 'passthrough', on: !passthrough }]
    : ['Room', { kind: 'passthrough' }];
  // One row, under Menu rather than in the compact set, because a render
  // budget is a setting and the compact rows are the ones a
  // lost wearer presses. The label reads the level the renderer is on and the
  // press carries the next one explicitly, so a tap cycles while a repeated
  // spoken or agent command stays idempotent. A viewer with no render-budget
  // lever passes no level and gets no row: an unwired setting is worse than
  // none.
  const qualityRow = RENDER_QUALITY_LEVELS.includes(quality)
    ? [[RENDER_QUALITY_LABELS[quality], { kind: 'render-quality', level: nextRenderQuality(quality) }]] : [];
  // The label shows the current style. The viewer resolves the next style at
  // dispatch time, so two quick taps do not carry the same stale target.
  // Density sources cannot switch to coordinate representations.
  const representation = lessonFigure?.representationOverride ?? appearance?.representation;
  const authoredFigure = Boolean(lessonFigure && !lessonFigure.representationOverride);
  const supportedRepresentations = representations ?? appearance?.representations ?? MOLECULAR_REPRESENTATIONS;
  const nextRepresentation = nextMolecularRepresentation(representation, supportedRepresentations);
  const appearanceRows = typeof representation === 'string' ? [[
    authoredFigure ? 'Figure' : representation === 'isosurface' ? 'Density' : MOLECULAR_REPRESENTATION_LABELS[representation] ?? 'Style',
    { kind: 'appearance-cycle' },
    representation === 'isosurface' || !nextRepresentation || nextRepresentation === representation,
  ]] : [];
  const historyRows = history ? [
    ['Undo', { kind: 'undo' }, !(typeof history.canUndo === 'boolean' ? history.canUndo : history.undoCount > 0)],
    ['Redo', { kind: 'redo' }, !(typeof history.canRedo === 'boolean' ? history.canRedo : history.redoCount > 0)],
  ] : [];
  // The final dwell keeps the Next-sized seat, now an actionable Done.
  const chapterAdvance = tour?.canNext
    ? ['Next', { kind: 'tour-next' }, Boolean(tour?.navigating)]
    : ['Done', { kind: 'tour-done' }, Boolean(tour?.navigating)];
  // Early Done lives under Menu, in the chooser's seat during a chapter.
  // Finishing restores the chooser. Appending another row would overflow the
  // compact budget and push the expanded grid into a third column.
  const expandedChooser = tour?.active && tour.canNext
    ? ['Done', { kind: 'tour-done' }, Boolean(tour.navigating)] : chooserRow;
  const tourPaged = tour?.bodyPageCount > 1 && tour?.selectedId && tour?.captionCard !== 'hidden';
  const chapterCard = tour?.active === true && tour?.selectedId && tour?.captionCard !== 'hidden' && tour?.menuOpen !== true;
  const tourControls = [
    [tour?.navigating ? 'Loading…' : tour?.autoplay ? 'Pause' : tour?.active ? 'Play' : 'Tour', { kind: 'tour-play', ...(tour?.menuOpen ? { chooser: true } : {}) }, Boolean(tour?.navigating), true],
    ...(collapsed ? [resetRow] : []),
    ...(collapsed ? (tour?.menuOpen ? [chooserRow] : []) : [expandedChooser]),
    ...(tour?.active ? [
      ...(tour.canBack ? [['Back', { kind: 'tour-back' }]] : []),
      chapterAdvance,
    ] : []),
    // `Pg 1/6`, not `Caption 1/6` and no longer `Page 1/50`: `Page` plus a
    // two-digit count is nine characters against the eight-character budget
    // above, and the width test never varied the page count so nothing caught
    // it. `Pg` is the standard abbreviation, the row sits directly under the
    // caption glass it pages, and `Pg 99/99` is exactly eight characters, so
    // the row holds any page count the lessons reach.
    // A selected lesson may still be the plain-entry structure. The readout
    // uses the same `captionCard` flag: hidden means no caption glass, title,
    // scene counter or page pill, even when the lesson is selected or active.
    ...(tourPaged ? [
      [`Pg ${tour.bodyPageIndex + 1}/${tour.bodyPageCount}`, { kind: 'tour-page' }],
    ] : []),
    // The same row, for the resting plate's source description.
    //
    // A 1CRN description ran off its row as `…molecules in…` and
    // the expanded menu's twenty-nine rows held nothing that could reach the
    // rest of the sentence. A
    // description that fits its row still gets no row here, so an ordinary
    // structure's menu is the length it always was.
    //
    // Only ever one page row. When a lesson caption is paging, that is what
    // the wearer is reading and the row stays its. A chapter card never draws
    // the description at all, so while one stands there is nothing for the row
    // to page. The description waits for the plate to come back to rest.
    //
    // A card the glass draws in pages (`readoutPage`) gets the same row, and
    // it counts the card's own pages: those are what the wearer is reading.
    ...(!tourPaged && readout?.cardPageCount > 1 ? [
      [`Pg ${(readout.cardPageIndex ?? 0) + 1}/${readout.cardPageCount}`, { kind: 'readout-page' }],
    ] : !tourPaged && !chapterCard && readout?.descriptionPageCount > 1 ? [
      [`Pg ${(readout.descriptionPageIndex ?? 0) + 1}/${readout.descriptionPageCount}`, { kind: 'readout-page' }],
    ] : []),
  ];
  // A tour under way adds Back, Next and a caption page to the compact panel,
  // and that is the state that crosses the row budget. One row has to yield and
  // it is `Mol*`: it hands the structure to a screen the wearer is not
  // wearing, so it is the only row here that can wait, and it returns the moment
  // the tour navigation collapses. `Passthrough` and `Reset view` stay, because
  // both are how a wearer who has lost the room or the molecule gets back.
  // Recovery adds Re-pair. In the fullest tour column, the disabled No link
  // chip yields to it; the caption still reports the connection failure.
  const mainVoiceControls = collapsed && connection?.line && connection?.recovery
    && voiceControls.length + tourControls.length + 3 > COMPACT_ROW_BUDGET
    ? voiceControls.filter(([, action]) => action.kind !== 'voice-toggle') : voiceControls;
  const compactWithoutWorkbench = mainVoiceControls.length + tourControls.length
    + 2 /* the passthrough row and Menu */;
  const compactAppearance = compactWithoutWorkbench < COMPACT_ROW_BUDGET - 1 ? appearanceRows : [];
  // The expanded grid keeps the same eight-character budget. Its own density
  // shrinks the type, not the angle: two columns of it are the widest thing the
  // panel ever draws, so its labels decide how far the whole grid reaches
  // across the structure. `Slide` is the wearer's word from the room welcome --
  // "Stick slides" -- and it keeps the mode row clear of the `Move` below,
  // which re-seats the menu rather than the molecule.
  const controls = collapsed ? [passthroughRow,
    ...compactAppearance,
    ...(compactWithoutWorkbench + compactAppearance.length < COMPACT_ROW_BUDGET - 1 ? [workbenchRow] : []),
    ['Menu', { kind: 'collapse', value: false }, false, true]] : [
    ['Close', { kind: 'collapse', value: true }, false, true], ...appearanceRows, ...historyRows,
    ...(typeof passthrough === 'boolean' ? [passthroughRow] : []),
    workbenchRow, [mode === 'move' ? 'Rotate' : 'Slide', { kind: 'mode' }],
    ['Above us', { kind: 'room-placement', target: 'overhead' }], ['In reach', { kind: 'room-placement', target: 'front' }],
    [paused ? 'Spin' : 'Stop', { kind: 'toggle-motion', paused: !paused }], ['Fit', { kind: 'fit' }], ['Reset', { kind: 'reset' }],
    ...qualityRow, ...sequenceRow,
    ['Scale −', { kind: 'scale', direction: -1 }], ['Scale +', { kind: 'scale', direction: 1 }],
    ['X −', { kind: 'nudge', axis: 'x', direction: -1 }], ['X +', { kind: 'nudge', axis: 'x', direction: 1 }],
    ['Y −', { kind: 'nudge', axis: 'y', direction: -1 }], ['Y +', { kind: 'nudge', axis: 'y', direction: 1 }],
    ['Z −', { kind: 'nudge', axis: 'z', direction: -1 }], ['Z +', { kind: 'nudge', axis: 'z', direction: 1 }],
    ...(!appearanceRows.length ? [
      ['Cartoon', { kind: 'appearance', preset: 'cartoon' }], ['Surface', { kind: 'appearance', preset: 'molecular-surface' }],
      ['Atoms', { kind: 'appearance', preset: 'ball-and-stick' }],
    ] : []),
    ['Chain', { kind: 'appearance', preset: 'chain-id' }], ['Element', { kind: 'appearance', preset: 'element-symbol' }],
    ['Opaque −', { kind: 'appearance', preset: 'opacity-down' }], ['Opaque +', { kind: 'appearance', preset: 'opacity-up' }],
  ];
  // The quiet menu, for a chapter that is on the wearer's face.
  //
  // Dimming the plates is not enough: nine rows make a teal column down the
  // left of the lens, the brightest and busiest thing in a lesson whose subject
  // is a molecule. Keying the quiet set off `autoplay` also misses a lesson
  // stepped chapter by chapter, where autoplay stays false throughout. A lesson
  // chapter on screen is the state that matters, pressed or played.
  //
  // The core rows stay, because the wearer reaches for them mid-chapter:
  // the primary tour control, the way forward, and the way back to the full
  // menu. `Talk` stays too when there is a microphone, because a held A or X is
  // the wearer's other route and this row is its only state light. Nothing is
  // removed that cannot be reached again in one press, and any press at all
  // brings the whole menu back — `spatial-toolbar.mjs` owns that timer.
  const quietVoice = voiceControls.map(([label, ...rest]) => [{ 'Mic on…': 'Mic on', 'Hearing…': 'Hear…', 'No voice': 'No mic', 'No link': 'Link?' }[label] ?? label, ...rest]);
  const quietRows = [...quietVoice,
    [tour?.navigating ? 'Wait' : tour?.autoplay ? 'Pause' : 'Play', { kind: 'tour-play', ...(tour?.menuOpen ? { chooser: true } : {}) }, Boolean(tour?.navigating), true],
    ...(tour ? [chapterAdvance] : []),
    ['Menu', { kind: 'collapse', value: false }, false, true]];
  return (quiet ? quietRows : [...mainVoiceControls, ...tourControls, ...controls, ...(!collapsed ? [['Re-seat', { kind: 'recenter-menu' }]] : [])])
    .map(([label, sourceAction, state, accent]) => {
      const action = sourceAction.kind === 'nudge' ? { ...sourceAction, mode } : sourceAction;
      return { id: spatialToolbarRowId(action), label, action,
        ...(action.kind === 'recenter-menu' ? { labelLines: ['Re-seat'] } : {}),
      // A row cannot be both. `Voice busy…` and `Preparing…` are the primary
      // action's own waiting state; while they wait they are status, not a
      // control, so the accent is dropped with the plate.
        ...(state ? { state: true } : accent ? { accent: true } : {}) };
    });
}

/**
 * Resolve one toolbar row without naming a row index. `query` is either an
 * exact label or a subset of the row's action fields; the first row matching
 * every given field wins. Returns -1 when the row is not currently present,
 * so a caller fails loudly instead of hitting a neighbouring control. Rows
 * appear and disappear with tour state, so a pinned index is always stale.
 */
export function spatialToolbarRowIndex(rows, query) {
  if (!Array.isArray(rows) || query === null || query === undefined) return -1;
  if (typeof query === 'string') return rows.findIndex(row => row?.label === query);
  if (typeof query !== 'object') return -1;
  const fields = Object.entries(query);
  if (!fields.length) return -1;
  return rows.findIndex(row => row?.action && fields.every(([key, value]) => row.action[key] === value));
}

/**
 * Whether the room welcome still belongs on the caption plate.
 *
 * It is a first-run hint, not a permanent caption. It stays up until the
 * wearer does something, then goes for the rest of the session, because a
 * wearer who has pressed a control no longer needs to be told there is one.
 * `engaged` is any claimed menu press; a voice state that has left `idle` is
 * a held A or X, or a press on the Talk row; and a chosen, running or open
 * tour has captions of its own to show instead.
 */
export function shouldShowRoomWelcome({ engaged = false, voice, tour } = {}) {
  if (engaged) return false;
  if (typeof voice?.state === 'string' && voice.state !== 'idle') return false;
  return !(tour?.selectedId || tour?.active || tour?.menuOpen);
}

/**
 * The first thing a wearer reads, on the caption plate above the controls.
 *
 * As few lines as the map allows, because the plate is as tall as the copy it
 * carries and this one hangs over the control grid from the moment the wearer
 * arrives. Six lines of it took the panel from -28 to +30 degrees of elevation,
 * which is most of a Quest 2 field of view spent on text nobody reads twice.
 *
 * What the lines have to carry is every control that cannot be seen: the rows
 * below explain themselves, and the controller does not. One build serves every
 * demo, and the loaded entry's title does not reach this model, so naming a
 * structure here once told a CRISPR wearer to say `show tubulin`.
 *
 * The caption font is whatever fits the plate width, so a shorter line buys
 * larger type.
 *
 * Three lines, because the map is the same on both hands and a wearer holding
 * one controller has to be told the whole of it once, stick click included.
 */
/**
 * What a reset view does to the menu, beyond showing it.
 *
 * A reset has to bring the menu back with it. Forcing `collapse: false` — the
 * expanded two-column grid — on the way lands that grid over the structure the
 * reset has just re-seated, and runs it off the edge of the left eye. A reset
 * is a wearer saying they are lost, not asking for every control at once.
 *
 * So the form the wearer chose is kept: a compact menu stays compact, an
 * expanded one stays expanded, and only a menu that was hidden altogether comes
 * back compact, because that is the form a wearer who is already lost can read.
 * Showing it is the caller's `setMenuHidden(false)`; this is the rest.
 *
 * @param {{hidden?:boolean, collapsed?:boolean}} menu the menu's state now
 * @returns {Array<{kind:string, value?:boolean}>} toolbar actions, in order
 */
export function menuResetActions({ hidden = false, collapsed = true } = {}) {
  return [...(hidden && !collapsed ? [{ kind: 'collapse', value: true }] : []), { kind: 'recenter-menu' }];
}

export const ROOM_WELCOME_LINES = Object.freeze([
  'Hold A/X: talk. Tap B/Y: menu. Hold B/Y or click stick: reset.',
  'Aim + grip: move menu. Push/pull: farther/closer. Grip + stick: molecule size.',
  'Point at a row and pull the trigger to choose.',
]);

// @ts-ignore Shared numerical placement guardrails used by the renderer.
import { clampPlacementScale } from '../../lab/browser-roundtrip/placement-limits.mjs';
/** Execute only the server's typed voice vocabulary against the current viewer. */
export async function executeInspectionVoiceAction(command: string, hooks: {
  tour: () => any;
  experience: () => any;
  player?: () => any;
  workspace: () => any;
  navigate: (id: string, step: number) => Promise<void>;
  /** One tier up or down the staged lesson, in the same session. */
  grow?: (stage: string) => Promise<string>;
  save: () => Promise<void>;
}): Promise<string> {
  const tour = hooks.tour(), experience = hooks.experience(), workspace = hooks.workspace();
  const player = hooks.player?.() ?? (experience?.getState().active ? experience : tour?.getState().active ? tour : experience ?? tour);
  let message: string;
  switch (command) {
    case 'tour-next':
      if (!player?.getState().canNext) throw Error('There is no next scene. Start a lesson first.');
      await player.next(); message = 'The next scene is ready.'; break;
    case 'tour-back':
      if (!player?.getState().canBack) throw Error('There is no previous scene.');
      await player.back(); message = 'The previous scene is ready.'; break;
    case 'tour-play':
      if (!player) throw Error('Choose a lesson first.');
      if (!player.getState().active) await player.start();
      if (!player.getState().active) throw Error('The lesson did not start.');
      if (!player.getState().autoplay) await player.togglePlay();
      if (!player.getState().autoplay) throw Error('The lesson did not begin playing.');
      message = 'The lesson is playing.'; break;
    case 'tour-pause':
      if (!player?.getState().active) throw Error('There is no active lesson to pause.');
      player.pause(); message = 'Paused. Take your time to look around.'; break;
    // The wearer's answer to a failed chapter highlight.
    // Re-applies the current chapter's emphasis once; a key that still will
    // not paint comes back as the retry-failure line, not as an error, so
    // the chapter keeps moving.
    case 'retry': {
      if (!player?.getState().active) throw Error('There is no active lesson to retry.');
      if (typeof player.retryEmphasis !== 'function') throw Error('This lesson cannot retry its highlight.');
      message = await player.retryEmphasis(); break;
    }
    // The host already queued the restoring command, because the
    // history it reads belongs to the shared scene rather than to this tab.
    // The page renders that command on its next heartbeat like any other, so
    // the only thing left here is the line the wearer hears. A caller that
    // reaches this case has ignored `handled` in the tool's answer, and the
    // honest thing to say then is that the change is on its way.
    case 'undo':
      message = 'Undone.'; break;
    case 'scale-larger': case 'scale-smaller': {
      const prior = workspace.snapshot().inspection.placement.scale;
      const requested = prior * (command === 'scale-larger' ? 1.2 : 1 / 1.2);
      const scale = workspace.viewer.inspection.clampWearerScale?.(requested) ?? clampPlacementScale(requested);
      if (scale === prior) throw Error('The structure is already at its size limit.');
      await workspace.runTour(() => workspace.viewer.inspection.place({ scale }));
      message = command === 'scale-larger' ? 'The structure is larger.' : 'The structure is smaller.'; break;
    }
    case 'move-overhead':
      if (!workspace.snapshot().xrPresenting || !workspace.viewer.xr?.placeInRoom) throw Error('Enter VR before placing the structure overhead.');
      await workspace.viewer.xr.placeInRoom('overhead'); message = 'The structure is above you.'; break;
    case 'show-molecule':
      await workspace.runTour(() => workspace.viewer.inspection.fit()); message = 'The structure is back in view.'; break;
    case 'show-cas9':
      await hooks.navigate('cas9-ternary-complex', 0); message = 'The Cas9 complex is ready.'; break;
    case 'show-telomerase':
      await hooks.navigate('telomerase-holoenzyme', 0); message = 'The telomerase structure is ready.'; break;
    case 'show-tubulin': case 'assemble-filament': case 'assemble-microtubule': case 'add-eb-protein': case 'add-eb3-protein': {
      if (!experience) throw Error('Molecular experiences are unavailable.');
      const stage = { 'show-tubulin': 'tubulin-dimer', 'assemble-filament': 'protofilament-slice',
        'assemble-microtubule': 'microtubule-lattice', 'add-eb-protein': 'eb3-decorated-lattice', 'add-eb3-protein': 'eb3-decorated-lattice' }[command];
      await experience.goToStage(stage, 'tubulin-eb3-lattice');
      message = command.startsWith('add-') ? 'The deposited EB3-bound lattice is ready.' : 'The requested assembly stage is ready.'; break;
    }
    // Growing an authored lesson is not an experience stage. It
    // replaces the coordinates and the lesson together in the session the
    // wearer is already in, so "grow it" never leaves VR. A tier the headset
    // cannot hold comes back as the refusal line, not as an error: the wearer
    // hears why and keeps the structure they were looking at.
    case 'grow-structure': case 'shrink-structure': case 'grow-wall': case 'grow-tip': {
      if (!hooks.grow) throw Error('This viewer cannot grow a staged lesson.');
      const stage = { 'grow-structure': 'next', 'shrink-structure': 'back', 'grow-wall': 'wall', 'grow-tip': 'tip' }[command];
      message = await hooks.grow(stage); break;
    }
    case 'add-eb1-protein': throw Error('This deposited structure contains EB3. An EB1 structure is not available in this journey.');
    default: throw Error('That voice action is not supported.');
  }
  await hooks.save();
  return message;
}

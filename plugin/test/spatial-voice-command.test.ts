import { describe, expect, it } from 'vitest';
// @ts-ignore Browser-only pure command grammar shared with the immersive toolbar.
import { voiceCommandFromTranscript, voiceExperienceAction } from '../../lab/browser-roundtrip/voice-command.mjs';

describe('immersive voice grammar', () => {
  it('maps only named utterances to bounded experience, placement, and tour actions', () => {
    expect(voiceCommandFromTranscript('Show the molecule.')).toMatchObject({ command: 'show-molecule' });
    expect(voiceExperienceAction('assemble-filament')).toEqual({ kind: 'goToStage', stage: 'protofilament' });
    expect(voiceExperienceAction('add-eb-protein')).toEqual({ kind: 'goToStage', stage: 'decorated' });
    expect(voiceExperienceAction('move-overhead')).toEqual({ kind: 'placement', value: 'overhead' });
    expect(voiceExperienceAction('tour-pause')).toEqual({ kind: 'tour', action: 'pause' });
  });

  it('names the experiences the way whisper writes them down', () => {
    // Spellings come from real transcripts, not from guesses. Whisper splits
    // the digit off "Cas9" and writes "EB" as two letters, so the obvious
    // spellings are ones a wearer could never produce.
    expect(voiceCommandFromTranscript('Show CRISPR Cas9.')).toMatchObject({ command: 'show-cas9' });
    expect(voiceCommandFromTranscript('Add an E-B protein.')).toMatchObject({ command: 'add-eb-protein' });
    expect(voiceCommandFromTranscript('Take me on the tour.')).toMatchObject({ command: 'tour-play' });
    expect(voiceCommandFromTranscript('Keep going.')).toMatchObject({ command: 'tour-next' });
    expect(voiceCommandFromTranscript('Scale it up.')).toMatchObject({ command: 'scale-larger' });
  });

  it('refuses unknown or oversized utterances rather than guessing a scene edit', () => {
    expect(voiceCommandFromTranscript('make a scientifically interesting molecule')).toBeUndefined();
    expect(voiceCommandFromTranscript('x'.repeat(241))).toBeUndefined();
  });

  // The render budget has to be reachable by voice. "Better" and "best" are
  // one request, and the way back down is asked for as frame rate rather than
  // as quality.
  it('reads a render budget out of how good or how smooth the wearer asks for', () => {
    for (const said of ['Better quality.', 'Best quality.', 'Higher quality.', 'Improve the quality.',
      'Make it look better.', 'Sharper.']) expect(voiceCommandFromTranscript(said)).toMatchObject({ command: 'quality-best' });
    for (const said of ['Balanced quality.', 'Normal quality.', 'Default quality.'])
      expect(voiceCommandFromTranscript(said)).toMatchObject({ command: 'quality-balanced' });
    for (const said of ['Smoother.', 'Faster.', 'Lower quality.', 'Fast quality.'])
      expect(voiceCommandFromTranscript(said)).toMatchObject({ command: 'quality-fast' });
    // The render budget is the panel's, not the ExperiencePlayer's: no quality
    // phrase may reach the scene-changing route the 2D page owns.
    for (const command of ['quality-best', 'quality-balanced', 'quality-fast'])
      expect(voiceExperienceAction(command)).toBeUndefined();
  });

  // Rotation phrases the immersive runner answers, kept in the shared table
  // that the capability map in SKILL.md is checked against.
  it('names the turntable spin the wearer asks for', () => {
    for (const said of ['Spin it.', 'Spin.', 'Rotate it.', 'Rotate.', 'Do a rotation.', 'A rotation.',
      'Spin the molecule.', 'Rotate the structure.', 'Start spinning.', 'Keep spinning.'])
      expect(voiceCommandFromTranscript(said), said).toMatchObject({ command: 'motion-spin' });
    for (const said of ['Stop spinning.', 'Stop rotating.', 'Stop the rotation.', 'Stop the spin.',
      'Stop moving.', 'Hold still.', 'Freeze.'])
      expect(voiceCommandFromTranscript(said), said).toMatchObject({ command: 'motion-stop' });
    // Bare "stop" stays the tour's. Only the immersive runner can see whether
    // the structure is turning, and it claims the word only while it is.
    expect(voiceCommandFromTranscript('Stop.')).toMatchObject({ command: 'tour-pause' });
    // The spin belongs to the panel that draws, never to the coordinate source.
    for (const command of ['motion-spin', 'motion-stop'])
      expect(voiceExperienceAction(command)).toBeUndefined();
  });
});

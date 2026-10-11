import { describe, expect, it } from 'vitest';
import {
  PANEL_MAX_HEIGHT_PX,
  PANEL_MIN_HEIGHT_PX,
  desiredPanelHeight,
  panelFixedHeight,
} from '../src/panel-size.js';

describe('desiredPanelHeight', () => {
  it('lifts the ~700 px inline Codex card to the 600 px floor', () => {
    // 0.7 x 700 is 490. Card mode spends about 110 px on the header, the
    // scene heading and the readiness line whatever the card's height, so 490
    // leaves the stage under 380 px and 600 leaves it about 490 px.
    expect(desiredPanelHeight({ width: 700 })).toBe(PANEL_MIN_HEIGHT_PX);
    expect(desiredPanelHeight({ width: 700 })).toBe(600);
  });

  it('follows the aspect once the card is wide enough to clear the floor', () => {
    // The floor stops mattering above 858 px, where 0.7 x width passes 600.
    expect(desiredPanelHeight({ width: 857 })).toBe(600);
    expect(desiredPanelHeight({ width: 900 })).toBe(630);
    expect(desiredPanelHeight({ width: 1000 })).toBe(700);
  });

  it('caps the wide Codex card at the top of the host clamp band', () => {
    // The live desktop mount measured ~1450 CSS px wide. 0.7 x 1450 is 1015,
    // and Codex clamps anything above 720 to 720, so 720 is what to ask for.
    expect(desiredPanelHeight({ width: 1450 })).toBe(PANEL_MAX_HEIGHT_PX);
    expect(desiredPanelHeight({ width: 1450 })).toBe(720);
  });

  it('floors the narrow side card so the stage survives the toolbar', () => {
    // 0.7 x 440 is 308 px, which after two toolbar rows leaves no stage.
    expect(desiredPanelHeight({ width: 440 })).toBe(PANEL_MIN_HEIGHT_PX);
    expect(desiredPanelHeight({ width: 440 })).toBe(600);
  });

  it('stays inside the host clamp band it has to survive', () => {
    // Codex clamps to 200-720. A request outside that band is silently
    // rewritten, so the band this module returns has to sit within it.
    expect(PANEL_MIN_HEIGHT_PX).toBeGreaterThanOrEqual(200);
    expect(PANEL_MAX_HEIGHT_PX).toBe(720);
    for (const width of [0, 320, 440, 700, 857, 1024, 1450, 4000]) {
      expect(desiredPanelHeight({ width })).toBeGreaterThanOrEqual(PANEL_MIN_HEIGHT_PX);
      expect(desiredPanelHeight({ width })).toBeLessThanOrEqual(PANEL_MAX_HEIGHT_PX);
    }
  });

  it('returns a fixed container height unchanged, over both the floor and the cap', () => {
    expect(desiredPanelHeight({ width: 1450, fixedHeight: 470 })).toBe(470);
    expect(desiredPanelHeight({ width: 800, fixedHeight: 900 })).toBe(900);
    // A container smaller than the floor still wins: the floor is a request,
    // a fixed height is what the container already is.
    expect(desiredPanelHeight({ width: 440, fixedHeight: 300 })).toBe(300);
  });

  it('depends on the width alone when the host states no fixed height', () => {
    // This is the property that stops the thrash: applying a returned height
    // cannot change the input that produced it.
    for (const width of [440, 620, 800, 1024, 1450]) {
      expect(desiredPanelHeight({ width })).toBe(desiredPanelHeight({ width, fixedHeight: undefined }));
    }
    // Non-finite and non-positive inputs must not produce a NaN or zero card.
    expect(desiredPanelHeight({ width: Number.NaN })).toBe(600);
    expect(desiredPanelHeight({ width: 900, fixedHeight: Number.NaN })).toBe(630);
    expect(desiredPanelHeight({ width: 900, fixedHeight: 0 })).toBe(630);
  });

  it('asks for the content height when the panel holds no structure', () => {
    // A compatibility notice under a compact header measures about 200 px.
    // The stage floor does not apply, the cap does, and a fixed container
    // height still wins.
    expect(desiredPanelHeight({ width: 737, contentHeight: 212.4 })).toBe(213);
    expect(desiredPanelHeight({ width: 737, contentHeight: 1200 })).toBe(PANEL_MAX_HEIGHT_PX);
    expect(desiredPanelHeight({ width: 737, contentHeight: 212, fixedHeight: 640 })).toBe(640);
    expect(desiredPanelHeight({ width: 737, contentHeight: Number.NaN })).toBe(PANEL_MIN_HEIGHT_PX);
  });

  it('never reads maxHeight, which in Codex is the card\'s current height', () => {
    // `containerDimensions` is built as {maxHeight: clientHeight, maxWidth:
    // clientWidth} and republished from a ResizeObserver, so capping to it
    // would pin the card to whatever height it already had. Only a fixed
    // `height` is read.
    expect(panelFixedHeight({ maxHeight: 470, maxWidth: 1450 })).toBeUndefined();
    expect(panelFixedHeight({ maxHeight: 620, maxWidth: 568 })).toBeUndefined();
    expect(panelFixedHeight({ height: 640, width: 800 })).toBe(640);
    expect(panelFixedHeight({ width: 800 })).toBeUndefined();
    expect(panelFixedHeight(undefined)).toBeUndefined();
    expect(panelFixedHeight(null)).toBeUndefined();
    expect(panelFixedHeight('620')).toBeUndefined();
    // A card that arrives short must still be able to ask to grow.
    expect(desiredPanelHeight({ width: 1450, fixedHeight: panelFixedHeight({ maxHeight: 470 }) })).toBe(720);
  });
});

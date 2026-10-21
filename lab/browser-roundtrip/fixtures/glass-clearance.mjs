import { measureEntryStandoff } from '../entry-standoff.mjs';

// Independent rectangular projection witness, one drawn plate at a time.
// The gap between a caption and its menu is not glass.
export function measureGlassClearance(options) {
  const readings = (options.menuPoints.plates ?? [options.menuPoints])
    .map(menuPoints => measureEntryStandoff({ ...options, menuPoints }));
  if (readings.some(reading => !reading)) return undefined;
  const eyes = readings[0].eyes.map(({ eye }) => {
    const plates = readings.map(reading => reading.eyes.find(value => value.eye === eye));
    return plates.map(plate => ({ ...plate, clearance: Math.max(plate.clearance,
      Math.abs(plate.subjectY - plate.menuY) - plate.subjectHalfHeight - plate.menuHalfHeight) }))
      .reduce((worst, plate) => plate.clearance < worst.clearance ? plate : worst);
  });
  return { ...readings[0], eyes, clearanceLeft: eyes.find(eye => eye.eye === 'left')?.clearance,
    clearanceRight: eyes.find(eye => eye.eye === 'right')?.clearance };
}

import { describe, expect, it } from 'vitest';
import { permitsLiveOrangeAction } from '../scripts/live-browser-contract.js';
describe('opt-in Live acceptance fixed action scope', () => {
  it.each(['Color selected residues orange', ' The protein is ready. Color the selected residues orange.', 'Colour the selected residues orange!'])('accepts only its complete expected synthetic command: %s', text => {
    expect(permitsLiveOrangeAction(text)).toBe(true);
  });
  it.each(['Color selected residues', 'Do not color selected residues orange', 'Color selected residues orange and delete the file', 'Color selected residues red', 'Color all residues orange'])('refuses partial, negative or unrelated commands: %s', text => {
    expect(permitsLiveOrangeAction(text)).toBe(false);
  });
});

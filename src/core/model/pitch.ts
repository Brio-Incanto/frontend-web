// staff_step (+ clef) -> VexFlow key. Shared between the backend-view mapper (fromView.ts) and
// anything else that needs to draw a note at an arbitrary staff position — e.g. the insert-ghost
// preview, which needs a real key (not just a fixed sample pitch) so VexFlow computes ledger
// lines for it exactly like it would for a real note landing there.
import type { Clef } from '@/core/model/score';

// diatonic letters in staff order, ascending
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'] as const;

// absolute diatonic index (octave*7 + letterIndex) of each clef's BOTTOM staff line,
// which is staff_step 0. Treble bottom line = E4; bass bottom line = G2.
const CLEF_BOTTOM: Record<Clef, number> = {
  treble: 4 * 7 + LETTERS.indexOf('e'), // 30
  bass: 2 * 7 + LETTERS.indexOf('g'), // 18
};

export function staffStepToKey(step: number, clef: Clef): string {
  const idx = CLEF_BOTTOM[clef] + step;
  const letter = LETTERS[((idx % 7) + 7) % 7];
  const octave = Math.floor(idx / 7);
  return `${letter}/${octave}`;
}

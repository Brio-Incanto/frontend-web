// Shared between VexflowRenderer.tsx (real score) and noteGlyph.ts (toolbar icon + insert-ghost)
// so the whole-note correction can never drift between the two rendering paths.
import { Renderer, Stave, StaveNote, Voice, Formatter, Stem } from 'vexflow';

// VexFlow silently adds a fixed offset to a note's rendered x beyond what
// `staff.getNoteStartX() + <formatter x>` predicts (constant ~12px, independent of
// clef/stretch/measure). A real note in the document is the best calibration source when one
// exists; this probe (one throwaway note, rendered off-DOM, measured once and cached) is the
// always-available fallback so an empty document still gets a correct ghost/insert position.
let cachedNotePadding: number | null = null;
export function getNotePaddingPx(): number {
  if (cachedNotePadding !== null) return cachedNotePadding;
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.left = '-9999px';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(300, 300);
  const ctx = renderer.getContext();
  const staff = new Stave(0, 0, 200).setContext(ctx);
  const note = new StaveNote({ keys: ['b/4'], duration: 'q' });
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables([note]);
  new Formatter().joinVoices([voice]).format([voice], 100);
  note.setStave(staff);
  voice.draw(ctx, staff);
  cachedNotePadding = note.getNoteHeadBeginX() - staff.getNoteStartX();
  host.remove();
  return cachedNotePadding;
}

// VexFlow's open whole-notehead glyph reads visibly larger than every other (filled) notehead at
// the SAME font scale — an intrinsic glyph-metrics quirk of the notation font, not a spacing bug.
export const WHOLE_NOTE_GLYPH_SCALE = 0.86;

// Real engraving gives every single note the SAME ledger-line length regardless of duration.
// VexFlow's own default (the specific duration's glyph width) doesn't — a whole notehead's glyph
// is measurably wider than a filled quarter notehead's. Measured once from a reference quarter
// note and reused for every duration; a displaced (2nd-interval) chord note still correctly gets
// the wider two-notehead `doubleWidth` ledger, untouched.
let cachedLedgerWidth: number | null = null;
function getLedgerGlyphWidthPx(): number {
  if (cachedLedgerWidth !== null) return cachedLedgerWidth;
  const note = new StaveNote({ keys: ['b/4'], duration: 'q' });
  cachedLedgerWidth = note.getGlyphProps().getWidth();
  return cachedLedgerWidth;
}

// Shadows `drawLedgerLines` on THIS note instance (not the shared prototype) with a copy of
// VexFlow's own implementation, substituting the fixed reference width above wherever the
// original read `glyphProps.getWidth()`. Deliberately NOT done by overriding
// `glyphProps.getWidth()` itself: that same method (called WITH a scale argument) also drives
// `getTieLeftX()`/`getTieRightX()`'s real tie-curve endpoints — patching it broadly would silently
// distort every tie on a non-quarter-duration note too. Shadowing the whole method keeps the
// blast radius to exactly what changed: ledger-line length.
export function fixLedgerLineWidth(sn: StaveNote): void {
  const fixedWidth = getLedgerGlyphWidthPx();
  sn.drawLedgerLines = function (this: StaveNote) {
    if (this.isRest()) return;
    const stave = this.checkStave();
    const ctx = this.checkContext();
    const strokePx = this.render_options.stroke_px;
    const width = fixedWidth + strokePx * 2;
    const doubleWidth = 2 * (fixedWidth + strokePx) - Stem.WIDTH / 2;
    const {
      highest_line,
      lowest_line,
      highest_displaced_line,
      highest_non_displaced_line,
      lowest_displaced_line,
      lowest_non_displaced_line,
      displaced_x,
      non_displaced_x,
    } = this.getNoteHeadBounds();
    if (highest_line < 6 && lowest_line > 0) return;
    const min_x = Math.min(displaced_x ?? 0, non_displaced_x ?? 0);
    const drawLedgerLine = (y: number, normal: boolean, displaced: boolean) => {
      let x;
      if (displaced && normal) x = min_x - strokePx;
      else if (normal) x = (non_displaced_x ?? 0) - strokePx;
      else x = (displaced_x ?? 0) - strokePx;
      const ledgerWidth = normal && displaced ? doubleWidth : width;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + ledgerWidth, y);
      ctx.stroke();
    };
    const style = { ...stave.getDefaultLedgerLineStyle(), ...this.getLedgerLineStyle() };
    this.applyStyle(ctx, style);
    for (let line = 6; line <= highest_line; ++line) {
      const normal = non_displaced_x !== undefined && line <= highest_non_displaced_line;
      const displaced = highest_displaced_line !== undefined && line <= highest_displaced_line;
      drawLedgerLine(stave.getYForNote(line), normal, displaced);
    }
    for (let line = 0; line >= lowest_line; --line) {
      const normal = non_displaced_x !== undefined && line >= lowest_non_displaced_line;
      const displaced = lowest_displaced_line !== undefined && line >= lowest_displaced_line;
      drawLedgerLine(stave.getYForNote(line), normal, displaced);
    }
    this.restoreStyle(ctx, style);
  };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Applied via a post-render DOM transform on JUST the `.vf-notehead` glyph, not VexFlow's
// `glyph_font_scale` option: `drawLedgerLines()` always measures ledger width at the GLOBAL
// default scale regardless of a note's own override, so that route leaves ledger lines
// full-width, protruding past a shrunk notehead. Scaling the glyph path directly leaves ledger
// lines, stems, dots and VexFlow's own spacing math untouched.
//
// Two separate steps, not one combined scale-around-an-anchor: scaling around an anchor only
// moves the ink by `(1 - scale)` of the anchor's distance from the ink's own center, so anchoring
// directly on the ledger leaves a residual gap (`originalGap * scale`), not zero. Scaling in place
// around the glyph's own ink center (which doesn't move it) and then translating by the exact
// measured gap afterward is the only way to guarantee zero residual for any scale factor:
// 1. Scale around the notehead's own ink-bbox center (`cx, cy`).
// 2. Translate to the ledger's own rendered x position, read directly from its DOM box (VexFlow's
//    public API doesn't expose the reference this resolves from) — no-op for a whole note with no
//    ledger to align against.
//
// Returns the notehead's VISUAL (post-shrink) box, or null if there was nothing to shrink —
// callers needing the glyph's real painted extent must use this, not a fresh `getBBox()` (which
// excludes the element's OWN transform, so it would keep reporting the pre-shrink box).
export function shrinkWholeNotehead(staveNoteGroup: SVGElement | null | undefined): Box | null {
  if (!staveNoteGroup) return null;
  const notehead = staveNoteGroup.querySelector<SVGGraphicsElement>('.vf-notehead');
  if (!notehead) return null;
  const box = notehead.getBBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ledger = [...staveNoteGroup.children].find((el): el is SVGPathElement => {
    if (el.tagName !== 'path' || notehead.contains(el)) return false;
    const d = el.getAttribute('d') ?? '';
    const m = d.match(/^M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)/);
    return !!m && Math.abs(parseFloat(m[2]) - parseFloat(m[4])) < 0.01 && Math.abs(parseFloat(m[1]) - parseFloat(m[3])) > 5;
  });
  const targetCx = ledger ? ledger.getBBox().x + ledger.getBBox().width / 2 : cx;
  const dx = targetCx - cx;
  notehead.setAttribute(
    'transform',
    `translate(${dx} 0) translate(${cx} ${cy}) scale(${WHOLE_NOTE_GLYPH_SCALE}) translate(${-cx} ${-cy})`,
  );
  const width = box.width * WHOLE_NOTE_GLYPH_SCALE;
  const height = box.height * WHOLE_NOTE_GLYPH_SCALE;
  return { x: targetCx - width / 2, y: cy - height / 2, width, height };
}

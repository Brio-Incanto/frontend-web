// Shared VexFlow note-glyph rendering, used by both the toolbar duration icons and the
// insert-ghost preview — one real rendering path so neither can drift from actual score
// engraving, and one shared anchor convention (the notehead's own center) so a glyph always
// projects to the same point regardless of its size (a whole note vs. a flagged 16th).
import { Renderer, Stave, StaveNote, Voice, Formatter } from 'vexflow';
import type { Clef } from '@/core/model/score';
import { staffStepToKey } from '@/core/model/pitch';
import { shrinkWholeNotehead, fixLedgerLineWidth, type Box } from '@/rendering/vexflow/engravingScale';

export type DurationTool = 'w' | 'h' | 'q' | '8' | '16';
export const DURATION_TOOLS: readonly DurationTool[] = ['w', 'h', 'q', '8', '16'];

export function isDurationTool(id: string): id is DurationTool {
  return (DURATION_TOOLS as readonly string[]).includes(id);
}

/**
 * Renders one stem-up note into `host`, returning both its `<svg>` and the `StaveNote` itself
 * (the note is the source of truth for where VexFlow actually anchored it — see
 * `getGhostGlyphMarkup`). Defaults to key 'a/4' (safely mid-staff, no ledger lines) for the
 * toolbar icons; pass `staffStep` for the insert-ghost, so ledger lines render exactly as they
 * would for a real note landing there. VexFlow's own standard sizes, except the whole-note glyph
 * correction (see `engravingScale.ts`) — kept in sync with the real renderer so the ghost/icon
 * never drifts from actual score engraving.
 */
function renderDurationNote(
  duration: DurationTool,
  host: HTMLDivElement,
  opts?: { staffStep?: number; clef?: Clef; ledgerColor?: string },
): { svg: SVGSVGElement; note: StaveNote; noteheadBox: Box | null } {
  host.innerHTML = '';
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(200, 200); // generous scratch canvas — real geometry comes from measurement, not this
  const ctx = renderer.getContext();
  const clef = opts?.clef ?? 'treble';
  const key = opts?.staffStep !== undefined ? staffStepToKey(opts.staffStep, clef) : 'a/4';
  const staff = new Stave(0, 0, 40).setContext(ctx);
  // auto_stem so the ghost preview shows the SAME direction the real inserted note will get
  // (VexflowRenderer.tsx uses the same option) — a fixed "always up" ghost would mislead whenever
  // the real note lands with a down stem.
  const note = new StaveNote({ keys: [key], duration, clef, auto_stem: true });
  note.setStyle({ fillStyle: 'currentColor', strokeStyle: 'currentColor' });
  note.setLedgerLineStyle({ strokeStyle: opts?.ledgerColor ?? 'currentColor', fillStyle: opts?.ledgerColor ?? 'currentColor' });
  fixLedgerLineWidth(note);
  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
  voice.addTickables([note]);
  new Formatter().joinVoices([voice]).format([voice], 30);
  note.setStave(staff);
  voice.draw(ctx, staff); // note (+ ledger lines) only — `staff` is never `.draw()`n, no staff lines
  const g = note.getSVGElement();
  // for the whole note, `shrinkWholeNotehead` both mutates the DOM AND returns the box that
  // actually matches what's painted — a fresh `.getBBox()` on the notehead itself would report
  // its PRE-shrink extent forever (see engravingScale.ts), silently breaking any caller that
  // needs the glyph's real footprint (the toolbar icon's centering math).
  const noteheadBox =
    duration === 'w' ? shrinkWholeNotehead(g) : (g?.querySelector<SVGGraphicsElement>('.vf-notehead')?.getBBox() ?? null);
  return { svg: host.querySelector('svg')!, note, noteheadBox };
}

/** Renders one stem-up note into `host` — see `renderDurationNote`. */
export function renderDurationSvg(
  duration: DurationTool,
  host: HTMLDivElement,
  opts?: { staffStep?: number; clef?: Clef; ledgerColor?: string },
): { svg: SVGSVGElement; noteheadBox: Box | null } {
  const { svg, noteheadBox } = renderDurationNote(duration, host, opts);
  return { svg, noteheadBox };
}

let scratchHost: HTMLDivElement | null = null;
function getScratchHost(): HTMLDivElement {
  if (scratchHost) return scratchHost;
  scratchHost = document.createElement('div');
  scratchHost.style.position = 'absolute';
  // `visibility:hidden` (not `display:none`) is required so VexFlow's SVG can still be laid out
  // for `getBBox()` measurement — but a hidden element still occupies normal-flow space, and with
  // no `top`/`left` it sits at its static position (right after #root), inflating the page's real
  // scrollable height. Pin it off-screen so it can't affect document layout/scroll at all.
  scratchHost.style.top = '0';
  scratchHost.style.left = '-9999px';
  scratchHost.style.visibility = 'hidden';
  scratchHost.style.pointerEvents = 'none';
  document.body.appendChild(scratchHost);
  return scratchHost;
}

interface SharedGlyphBox {
  halfW: number; // furthest any duration's content reaches left/right of ITS OWN notehead center
  above: number; // furthest any reaches above its notehead's bottom edge
  below: number; // furthest any reaches below it
}
let sharedGlyphBox: SharedGlyphBox | null = null;

// Measured ONCE across all 5 durations (not guessed per-icon): every duration icon then shares
// this one box, anchored to ITS OWN notehead center each time — so a note lands at the same
// relative spot in its slot no matter the duration, instead of hand-picked padding constants
// that happen to fit one glyph and not another.
export function getSharedGlyphBox(): SharedGlyphBox {
  if (sharedGlyphBox) return sharedGlyphBox;
  const scratch = getScratchHost();
  let halfW = 0;
  let above = 0;
  let below = 0;
  for (const duration of DURATION_TOOLS) {
    const { svg, noteheadBox: box } = renderDurationSvg(duration, scratch);
    const noteheadBox = box ?? svg.getBBox();
    const contentBox = svg.getBBox();
    const cx = noteheadBox.x + noteheadBox.width / 2;
    const noteheadBottom = noteheadBox.y + noteheadBox.height;
    halfW = Math.max(halfW, cx - contentBox.x, contentBox.x + contentBox.width - cx);
    above = Math.max(above, noteheadBottom - contentBox.y);
    below = Math.max(below, contentBox.y + contentBox.height - noteheadBottom);
  }
  sharedGlyphBox = { halfW, above, below };
  return sharedGlyphBox;
}

const ghostMarkupCache = new Map<string, string>();

/**
 * SVG markup (a `<g>`, as a string) for one duration's full note glyph AT a given staff position
 * — including ledger lines, if `staffStep` puts it off the staff — with its anchor translated to
 * local (0, 0). Wrap it in `<g transform="translate(x,y)">` and the notehead's LEFT edge lands
 * exactly at (x, y) for any duration/position, since they all share this one convention.
 *
 * The anchor X is `getNoteHeadBeginX()` — the notehead's LEFT edge, not its center — because
 * that's what the renderer's own cross-staff position sharing (`VexflowRenderer.tsx`'s
 * `realBeatX`) aligns to: `sn.setXShift(...)` moves every note at a shared onset to the SAME
 * `getNoteHeadBeginX()` regardless of duration/width (the shift target never references glyph
 * width), so begin-X is the one x reference guaranteed consistent between notes of different
 * widths at the same beat (e.g. a filled notehead vs. a whole note, ~5px wider). Anchoring the
 * ghost by center instead would silently reintroduce a per-duration offset — `ghost.x` (read from
 * `zone.segments`, itself begin-X) would land the ghost's CENTER where a real note's BEGIN
 * belongs, off by half the ghost's own notehead width.
 *
 * The anchor Y is the note's own `getYs()[0]` — the same value VexFlow itself used to place both
 * the notehead AND its ledger lines — NOT a measured bbox center of the rendered notehead glyph.
 * Those two are not always the same point: a notehead glyph's rendered ink isn't necessarily
 * centered in its own bounding box (font-metric quirk), so anchoring by measured bbox center
 * silently reintroduces that offset as a rigid shift of the WHOLE group (ledger lines included)
 * when this markup gets repositioned — the notehead ends up in the right place but its ledger
 * lines don't, since they were drawn relative to the stave's line positions, not the notehead's
 * bbox. Anchoring by the note's own target position keeps notehead and ledgers mutually
 * consistent by construction, exactly like a real note.
 */
export function getGhostGlyphMarkup(duration: DurationTool, staffStep: number, clef: Clef): string {
  const key = `${duration}:${staffStep}:${clef}`;
  const cached = ghostMarkupCache.get(key);
  if (cached) return cached;
  const { svg, note } = renderDurationNote(duration, getScratchHost(), { staffStep, clef });
  const anchorX = note.getNoteHeadBeginX();
  const anchorY = note.getYs()[0];
  const noteGroup = svg.querySelector('.vf-stavenote');
  const markup = `<g transform="translate(${-anchorX} ${-anchorY})">${noteGroup?.outerHTML ?? ''}</g>`;
  ghostMarkupCache.set(key, markup);
  return markup;
}

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/app/store';
import { usePlayback } from '@/core/playback/PlaybackController';
import { locate, voiceNoteIds, staffNoteIds, measureNoteIds, chordNoteIds } from '@/core/model/query';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import { isDurationTool, getGhostGlyphMarkup } from '@/rendering/vexflow/noteGlyph';
import type { ScoreLayout, NoteBox, StaffZone, StemHandle } from '@/rendering/ScoreRenderer';

// Piecewise-linear interpolation over the layout's real (beat, x) breakpoints — spacing is
// Gourlay (duration-weighted), not linear, so a straight-line shortcut would drift.
function interp(points: { beat: number; x: number }[], key: 'beat' | 'x', at: number): number {
  const other = key === 'beat' ? 'x' : 'beat';
  if (!points.length) return 0;
  if (at <= points[0][key]) return points[0][other];
  for (let i = 0; i < points.length - 1; i++) {
    if (at >= points[i][key] && at <= points[i + 1][key]) {
      const span = points[i + 1][key] - points[i][key] || 1;
      const t = (at - points[i][key]) / span;
      return points[i][other] + t * (points[i + 1][other] - points[i][other]);
    }
  }
  return points[points.length - 1][other];
}

function beatToX(layout: ScoreLayout, beat: number): number {
  return interp(
    layout.timeMap.map((e) => ({ beat: e.timeBeats, x: e.x })),
    'beat',
    beat,
  );
}

// The two real breakpoints bracketing `beat` — used to clamp the insert-ghost away from both
// edges of its segment (see `GHOST_MIN_CLEARANCE_PX`).
function bracketSegment(
  points: { beat: number; x: number }[],
  beat: number,
): [{ beat: number; x: number }, { beat: number; x: number }] | null {
  for (let i = 0; i < points.length - 1; i++) {
    if (beat >= points[i].beat && beat <= points[i + 1].beat) return [points[i], points[i + 1]];
  }
  return null;
}

interface Band {
  x: number;
  y: number;
  w: number;
  h: number;
}

function intersects(b: NoteBox, band: Band): boolean {
  return !(b.x + b.w < band.x || b.x > band.x + band.w || b.y + b.h < band.y || b.y > band.y + band.h);
}

// duration tools -> (note denominator value, length in beats at beat_value 4)
const DURATION_TOOLS: Record<string, { value: number; beats: number }> = {
  w: { value: 1, beats: 4 },
  h: { value: 2, beats: 2 },
  q: { value: 4, beats: 1 },
  '8': { value: 8, beats: 0.5 },
  '16': { value: 16, beats: 0.25 },
};

// TEMPORARY hardcoded pitch ceiling per clef (staff_step units) — the real bound depends on
// clef/ottava/instrument range, which the client can't know until pitch is implemented on the
// backend. TODO(pitch-range): resolve from the backend instead of hardcoding here.
const STAFF_STEP_RANGE: Record<'treble' | 'bass', { min: number; max: number }> = {
  treble: { min: -11, max: 19 },
  bass: { min: -11, max: 19 },
};

// stem-drag length bounds — unbounded dragging let a stem stretch hundreds of px off-screen.
const MIN_STEM_LENGTH = 20;
const MAX_STEM_LENGTH = 90;
// keeps a dragged stem's free tip inside the canvas edges; a bit more than the dot's radius (5)
// so the whole grab dot stays visible.
const STEM_CANVAS_MARGIN = 8;
// how far past `baseY` the stem's hit-line starts, clearing the notehead's own click priority.
const STEM_GRAB_INSET_PX = 18;
// half-width of the stem's geometric interaction column (`stemAtPoint`), shared by hover and
// click/drag. Deliberately narrower than a chord's notehead-to-stem offset (~5px median) so
// clicking a notehead still selects just that note, not the whole chord.
const STEM_INTERACT_X_TOLERANCE = 4;
// VexFlow's `Tables.STEM_HEIGHT` (not exported, mirrored here): `setStemLength(height)` actually
// renders `chordSpan + height`, not `height` alone — see `chordSpan`'s own doc comment below.
const VEXFLOW_STEM_HEIGHT = 35;

// Clearance kept between the insert-ghost and both edges of its onset segment, purely visual
// (never the beat value actually sent on click) — otherwise a finer duration previewed inside a
// coarser gap visually crowds the neighboring note or barline. Only has room to act on segments
// wider than 2x this value; a real fix for narrow segments needs wider base spacing
// (durationSpacePx/SPACE_UNIT in VexflowRenderer.tsx) or a smaller ghost glyph.
const GHOST_MIN_CLEARANCE_PX = 10;

// The stem's own interactive hit range [yMin, yMax] at a fixed x — shared by the hit-line's
// render and `computeHover`'s geometric check, so both always agree on "on the stem."
function stemHitRange(h: StemHandle): { x: number; yMin: number; yMax: number } {
  const dir = h.tipY >= h.baseY ? 1 : -1;
  const inset = Math.min(STEM_GRAB_INSET_PX, Math.abs(h.tipY - h.baseY));
  const hasSpan = h.hitY1 != null && h.hitY2 != null;
  const hitStartY = hasSpan ? (h.hitY1 as number) : h.baseY + dir * inset;
  const hitEndY = hasSpan ? (h.hitY2 as number) : h.tipY;
  return { x: h.x, yMin: Math.min(hitStartY, hitEndY), yMax: Math.max(hitStartY, hitEndY) };
}

export function Overlay({
  layout,
  onHoverNote,
}: {
  layout: ScoreLayout;
  /** ids to lightly tint in the render SVG — a single note on note-hover, all of a measure's on
   *  barline-hover, or empty to clear. */
  onHoverNote: (noteIds: string[]) => void;
}) {
  const doc = useEditor((s) => s.document);
  const mode = useEditor((s) => s.canvasMode);
  const tool = useEditor((s) => s.tool);
  const currentVoice = useEditor((s) => s.currentVoice);
  const currentStaffId = useEditor((s) => s.currentStaff);
  const select = useEditor((s) => s.select);
  const selectMany = useEditor((s) => s.selectMany);
  const dispatch = useEditor((s) => s.dispatch);
  const voiceColors = useEditor((s) => s.voiceColors);
  const selectedIds = useEditor((s) => s.selectedIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const locked = useEditor((s) => s.locked);
  const setStemOverride = useEditor((s) => s.setStemOverride);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const { timeBeats, playing } = usePlayback();

  const currentVoiceId = doc.voices[currentVoice]?.id;
  const currentVoiceColor = currentVoiceId
    ? resolveVoiceColor(currentVoiceId, currentVoice, voiceColors)
    : undefined;

  const durationTool = DURATION_TOOLS[tool];
  // same 2-staff convention as the renderer: staffOrder[0] is treble, everything else bass.
  // TODO(N staves): once a 3rd+ staff is real, clef needs to come from the document.
  const clefOf = (staffId: string): 'treble' | 'bass' =>
    doc.staffOrder.indexOf(staffId) === 0 ? 'treble' : 'bass';

  const svgRef = useRef<SVGSVGElement>(null);
  const start = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const bandRef = useRef<Band | null>(null);
  const [band, setBand] = useState<Band | null>(null);
  // delay before hover tint triggers, so passing OVER notes while moving doesn't flicker;
  // clearing is NOT delayed (leaving should never leave a stale highlight).
  const hoverTimeoutRef = useRef<number | null>(null);
  const HOVER_DELAY_MS = 150;
  const debouncedHoverNote = (ids: string[]) => {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (ids.length === 0) {
      onHoverNote([]);
      return;
    }
    hoverTimeoutRef.current = window.setTimeout(() => {
      hoverTimeoutRef.current = null;
      onHoverNote(ids);
    }, HOVER_DELAY_MS);
  };
  // used by the stem handle only: its own hover affordance is instant CSS, so the note tint
  // must be instant too, or the two visibly light up in two stages.
  const instantHoverNote = (ids: string[]) => {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    onHoverNote(ids);
  };
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current !== null) window.clearTimeout(hoverTimeoutRef.current);
    };
  }, []);
  // insert-preview: a translucent notehead at the snapped (beat, staff_step) a click would land
  // on — cheap, client-only.
  const [ghost, setGhost] = useState<{ x: number; y: number; staffStep: number; staffId: string } | null>(
    null,
  );
  // last raw pointer position, kept so the ghost can be recomputed (not left stale) whenever the
  // document changes without the mouse moving, e.g. undo/redo.
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // Active stem-handle drag. See `Editor Overlay Interaction` (vault) for why this shape won out
  // over the earlier attempts (hard clamp, freeze, rubber-band, fixed-direction). `baseY` is the
  // notehead-side end, frozen at grab; direction is recomputed live in `onMove` from the current
  // tip vs `baseY`, so dragging the tip through the notehead flips it. `startY`/`moved`
  // distinguish a real drag from a stationary click (a click alone just selects); two clicks on
  // the same note within `DOUBLE_CLICK_MS` flip/reset instead (`lastStemClickRef`). Native
  // `dblclick` isn't used — `setPointerCapture` (needed so the drag survives leaving the thin
  // stem) breaks the browser's own double-click detection after a prior drag.
  const stemDragRef = useRef<{
    noteId: string;
    /** which physical staff this stem is drawn on — a cross-staff chord has TWO stems (same
     *  `noteId`, different staves). */
    staffId: string;
    baseY: number;
    startY: number;
    /** the tip's y at grab time — the drag moves it by the pointer's DELTA from `startY`, so
     *  grabbing mid-stem doesn't snap the tip to the cursor on the first frame. */
    tipY: number;
    /** the chord's own notehead-to-notehead span, read from what VexFlow is CURRENTLY rendering
     *  (`|tipY - baseY| - VEXFLOW_STEM_HEIGHT`), not from `layout.noteBoxes` (those are padded
     *  for click hit-testing and overestimate the span). 0 for a single note. */
    chordSpan: number;
    /** per-stem length cap from the handle — a cross-staff stem needs a larger cap to clear the
     *  inter-staff gap. */
    maxLength: number;
    moved: boolean;
  } | null>(null);
  const lastStemClickRef = useRef<{ noteId: string; time: number } | null>(null);
  const DOUBLE_CLICK_MS = 400;
  // Same manual-timing pattern as the stem's double-click, for the same reason (no
  // setPointerCapture here either, but kept consistent): a fast second click on the same note
  // escalates single-note selection to the whole chord.
  const lastNoteClickRef = useRef<{ id: string; time: number } | null>(null);
  // Suppresses the ONE native `click` that follows a stem-handle release. `click` is a legacy
  // MouseEvent that `setPointerCapture` does NOT redirect, so a drag ending over a different
  // element's hit-rect (easy for a cross-staff stem) fires THAT element's click right after,
  // silently collapsing the selection just made. Set on stem pointerup, consumed by the very
  // next `onClick` anywhere.
  const suppressNextClickRef = useRef(false);
  // One `setStemOverride` per animation frame, not per raw pointermove — every override fully
  // rebuilds the VexFlow SVG, and a mouse fires far more move events than the browser paints.
  const stemDragFrameRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (stemDragFrameRef.current !== null) cancelAnimationFrame(stemDragFrameRef.current);
    };
  }, []);

  // WebKit/Safari's `getScreenCTM()` ignores an ancestor CSS `transform: scale()` (confirmed via
  // direct inspection; Chromium is correct) — deriving scale from `getBoundingClientRect()`
  // instead is immune to this regardless of engine.
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width / layout.width;
    const scaleY = rect.height / layout.height;
    return {
      x: (e.clientX - rect.left) / scaleX,
      y: (e.clientY - rect.top) / scaleY,
    };
  };

  // Picks the target staff zone under a point and snaps it to (beat, staff_step) — shared by the
  // actual insert (click) and the hover ghost, so the preview always matches where a click lands.
  // Edit is bound to the CURRENT staff only (never inferred from geometry) — that's what lets you
  // write off-staff with ledger lines instead of a click snapping to the nearest staff; a
  // cross-staff chord is built by switching the staff chip and clicking the same beat again.
  const resolveInsertTarget = (x: number, y: number) => {
    if (!durationTool || !currentStaffId) return null;
    const candidates = layout.staffZones.filter((z) => x >= z.x0 && x <= z.x1);
    if (!candidates.length) return null;
    // x alone can match zones from multiple systems (page mode stacks them) — disambiguate by
    // vertical proximity to each zone's middle line.
    const middle = (zz: StaffZone) => zz.bottomLineY - 4 * zz.stepPx;
    const nearest = candidates.reduce((best, z) =>
      Math.abs(y - middle(z)) < Math.abs(y - middle(best)) ? z : best,
    );
    if (nearest.staffId !== currentStaffId) return null;
    const zone = nearest;

    // beats are quarter-note units throughout; only `snapped` converts to whole notes for the
    // backend's numerator/32 position fraction.
    const measureBeats = (zone.beats * 4) / zone.beatValue;
    const gridBeats = durationTool.beats;
    const rawBeat = interp(zone.segments, 'x', x);
    const snappedBeat = Math.min(
      Math.max(Math.round(rawBeat / gridBeats) * gridBeats, 0),
      Math.max(measureBeats - gridBeats, 0),
    );
    // off-staff positions get ledger lines; clamp to the temporary pitch ceiling.
    const range = STAFF_STEP_RANGE[clefOf(zone.staffId)];
    const rawStep = Math.round((zone.bottomLineY - y) / zone.stepPx);
    const staffStep = Math.min(Math.max(rawStep, range.min), range.max);
    // Clamp away from both segment edges, but only strictly BETWEEN two onsets — a snap landing
    // exactly ON an onset must render exactly there, unclamped.
    let snappedX = interp(zone.segments, 'beat', snappedBeat);
    const seg = bracketSegment(zone.segments, snappedBeat);
    if (seg && snappedBeat > seg[0].beat && snappedBeat < seg[1].beat) {
      const lo = seg[0].x + GHOST_MIN_CLEARANCE_PX;
      const hi = seg[1].x - GHOST_MIN_CLEARANCE_PX;
      // a segment narrower than 2x the clearance can't satisfy both edges — fall back to its
      // midpoint.
      snappedX = lo <= hi ? Math.min(Math.max(snappedX, lo), hi) : (seg[0].x + seg[1].x) / 2;
    }
    const snappedY = zone.bottomLineY - staffStep * zone.stepPx;

    return { zone, snapped: snappedBeat / 4, staffStep, snappedX, snappedY };
  };

  const insertAt = (x: number, y: number) => {
    const voiceId = doc.voices[currentVoice]?.id;
    if (!voiceId) return;
    const target = resolveInsertTarget(x, y);
    if (!target || !durationTool) return;
    const { zone, snapped, staffStep } = target;

    void dispatch({
      type: 'insertNote',
      measureId: zone.measureId,
      staffId: zone.staffId,
      voiceId,
      position: { numerator: Math.round(snapped * 32), denominator: 32 },
      writtenValue: { value: durationTool.value, dots: 0 },
      staffStep,
      accidental: 'none',
    });
  };

  // double-click -> whole voice in the measure (across every staff it touches, since voice is
  // the real axis); Alt-click -> whole staff in the measure (every voice, notes on this staff).
  const groupFromNote = (noteId: string, kind: 'voice' | 'staff', additive: boolean) => {
    const loc = locate(doc, noteId);
    if (!loc) return;
    const ids =
      kind === 'voice'
        ? voiceNoteIds(doc, loc.measureId, loc.voiceId)
        : staffNoteIds(doc, loc.measureId, loc.staffId);
    selectMany(ids, additive);
  };

  // The stem whose narrow interaction column + y-range contains (x, y), or null — the single
  // source of truth for both hover and click/drag stem priority (see the vault note for why this
  // is geometric rather than native onPointerEnter/onClick on the hit-line).
  const stemAtPoint = (x: number, y: number): StemHandle | null => {
    for (const h of layout.stemHandles) {
      const r = stemHitRange(h);
      if (Math.abs(x - r.x) <= STEM_INTERACT_X_TOLERANCE && y >= r.yMin && y <= r.yMax) return h;
    }
    return null;
  };

  // Decides the hover-preview target (whole-chord ghost vs. single-note tint) geometrically on
  // every move, not via native per-element events — see `stemAtPoint`.
  const computeHover = (e: { clientX: number; clientY: number }) => {
    const { x, y } = toSvg(e);
    const h = stemAtPoint(x, y);
    if (h) {
      instantHoverNote(chordNoteIds(doc, h.noteId));
      return;
    }
    const box = layout.noteBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    debouncedHoverNote(box ? [box.id] : []);
  };

  const onDownBg = (e: React.PointerEvent) => {
    const { x, y } = toSvg(e);
    start.current = { x, y, additive: e.shiftKey };
    if (!durationTool) {
      setBand({ x, y, w: 0, h: 0 }); // marquee only in select mode
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* capture optional */
      }
    }
  };

  // Stem grab, handled geometrically at the svg root via `stemAtPoint` (see its own comment) —
  // returns without effect when not on a stem, so note clicks and the marquee are untouched.
  const onDownStem = (e: React.PointerEvent) => {
    if (durationTool) return;
    const p = toSvg(e);
    const h = stemAtPoint(p.x, p.y);
    if (!h) return;
    // the shared stem selects the WHOLE chord, at carrier granularity (so a single-note carrier
    // still gets stem context — `carrierSelectedIds`).
    selectMany(chordNoteIds(doc, h.noteId), e.shiftKey, [h.noteId]);
    const chordSpan = Math.max(0, Math.abs(h.tipY - h.baseY) - VEXFLOW_STEM_HEIGHT);
    stemDragRef.current = {
      noteId: h.noteId,
      staffId: h.staffId,
      baseY: h.baseY,
      startY: p.y,
      tipY: h.tipY,
      chordSpan,
      maxLength: h.maxLength ?? MAX_STEM_LENGTH,
      moved: false,
    };
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* capture optional */
    }
  };

  const onMove = (e: React.PointerEvent) => {
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (stemDragRef.current) {
      const { y } = toSvg(e);
      const drag = stemDragRef.current;
      if (Math.abs(y - drag.startY) > 3) drag.moved = true;
      if (drag.moved) {
        if (stemDragFrameRef.current !== null) cancelAnimationFrame(stemDragFrameRef.current);
        stemDragFrameRef.current = requestAnimationFrame(() => {
          stemDragFrameRef.current = null;
          // One pipeline for a single note and a chord (see the vault note for the earlier,
          // rejected per-kind/per-direction variants). Tip follows the pointer's delta from the
          // grab point (not absolute y, so grabbing mid-stem doesn't yank it), then its position
          // is clamped to the canvas.
          const rawTip = drag.tipY + (y - drag.startY);
          const tip = Math.min(Math.max(rawTip, STEM_CANVAS_MARGIN), layout.height - STEM_CANVAS_MARGIN);
          // direction = which side of baseY the tip is on, live — dragging through it flips.
          const direction: 1 | -1 = tip < drag.baseY ? 1 : -1;
          // length floors at the chord's own physical minimum (span + protrusion) so it's never
          // shorter than VexFlow can render, and never longer than the per-stem cap.
          const minLength = drag.chordSpan + MIN_STEM_LENGTH;
          const maxLength = Math.max(drag.maxLength, minLength);
          const length = Math.min(Math.max(Math.abs(tip - drag.baseY), minLength), maxLength);
          // setStemOverride expects VexFlow's `height` (= total - chordSpan), not the total.
          setStemOverride(drag.noteId, { direction, length: length - drag.chordSpan });
        });
      }
      return;
    }
    if (durationTool) {
      const { x, y } = toSvg(e);
      const target = resolveInsertTarget(x, y);
      setGhost(
        target
          ? { x: target.snappedX, y: target.snappedY, staffStep: target.staffStep, staffId: target.zone.staffId }
          : null,
      );
      return;
    }
    computeHover(e);
    if (!start.current) return;
    const { x, y } = toSvg(e);
    const s = start.current;
    const b: Band = { x: Math.min(s.x, x), y: Math.min(s.y, y), w: Math.abs(x - s.x), h: Math.abs(y - s.y) };
    bandRef.current = b;
    setBand(b);
  };

  const onUp = () => {
    if (stemDragRef.current) {
      // cancel a pending rAF so a stale, one-frame-behind position can't land after release.
      if (stemDragFrameRef.current !== null) {
        cancelAnimationFrame(stemDragFrameRef.current);
        stemDragFrameRef.current = null;
      }
      suppressNextClickRef.current = true;
      const { noteId, moved } = stemDragRef.current;
      if (!moved) {
        const now = Date.now();
        const last = lastStemClickRef.current;
        if (last && last.noteId === noteId && now - last.time < DOUBLE_CLICK_MS) {
          // first double-click on a custom-dragged length resets to natural (same direction);
          // the next one flips — so double-click always eventually flips.
          const override = stemOverrides[noteId];
          const hasCustomLength = override != null && override.length !== null;
          const h = layout.stemHandles.find((sh) => sh.noteId === noteId);
          const currentDirection = h?.direction ?? 1;
          const nextDirection = (hasCustomLength ? currentDirection : currentDirection * -1) as 1 | -1;
          setStemOverride(noteId, { direction: nextDirection, length: null });
          lastStemClickRef.current = null;
        } else {
          lastStemClickRef.current = { noteId, time: now };
        }
      }
      stemDragRef.current = null;
      return;
    }
    const s = start.current;
    const b = bandRef.current;
    start.current = null;
    bandRef.current = null;
    setBand(null);
    if (!s) return;
    if (durationTool) {
      insertAt(s.x, s.y); // a click on the staff inserts a note of the current value
      return;
    }
    if (b && (b.w > 3 || b.h > 3)) {
      // marquee select is carrier-granularity: touching any one note selects the whole chord.
      const hitCarrierIds = [...new Set(layout.noteBoxes.filter((box) => intersects(box, b)).map((box) => box.carrierId))];
      const ids = hitCarrierIds.flatMap((cid) => chordNoteIds(doc, cid));
      selectMany(ids, s.additive, hitCarrierIds);
    } else if (!s.additive) {
      select(null); // a plain click on empty space clears
    }
  };

  // recompute the ghost from the last known pointer position whenever anything that affects its
  // target changes (not just on the next pointermove) — covers undo/redo and tool/staff switches.
  useEffect(() => {
    if (!durationTool) {
      setGhost(null);
      return;
    }
    const p = lastPointerRef.current;
    if (!p || !svgRef.current) return;
    const { x, y } = toSvg(p);
    const target = resolveInsertTarget(x, y);
    setGhost(
      target
        ? { x: target.snappedX, y: target.snappedY, staffStep: target.staffStep, staffId: target.zone.staffId }
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, tool, currentStaffId]);

  const cursorX = beatToX(layout, timeBeats);

  return (
    <svg
      ref={svgRef}
      className={'overlay' + (durationTool ? ' inserting' : '')}
      width={layout.width}
      height={layout.height}
      // stem grab is geometric, at the root (`onDownStem`) — runs before note rects' own onClick;
      // returns without effect off-stem, so bg marquee and note clicks are untouched.
      onPointerDown={onDownStem}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        lastPointerRef.current = null;
        setGhost(null);
        debouncedHoverNote([]);
      }}
    >
      <rect
        className="bg"
        x={0}
        y={0}
        width={layout.width}
        height={layout.height}
        style={{ cursor: durationTool ? 'copy' : 'default' }}
        onPointerDown={onDownBg}
      />
      {/* Stem handles paint BEFORE (under) the note hit-rects, so a notehead's own click always
          wins within its bounds; the stem stays grabbable along the rest of its length. */}
      {!durationTool &&
        !locked &&
        // rendered for every stemmed note, always — the hit-line/visual/dot are invisible by
        // default, revealed by CSS `:hover` on the hit-line itself.
        layout.stemHandles.map((h) => {
            // hit-line start is inset a small flat amount past `baseY`, just enough to keep a
            // grab next to the notehead resolving as "drag the stem" — the rest of the stem
            // (including any gap to a further chord note) stays covered.
            const { yMin: hitStartY, yMax: hitEndY } = stemHitRange(h);
            const hasSpan = h.hitY1 != null && h.hitY2 != null;
            // the VISUAL line always spans the full stem regardless of the hit-line's inset, so
            // hover/selected state reads as one continuous highlighted object.
            const visualStartY = hasSpan ? (h.hitY1 as number) : h.baseY;
            const visualEndY = hasSpan ? (h.hitY2 as number) : h.tipY;
            // colored by the note's own voice, same resolution the notehead itself uses.
            const loc = locate(doc, h.noteId);
            const voiceIndex = loc ? doc.voices.findIndex((v) => v.id === loc.voiceId) : -1;
            const voiceColor =
              loc && voiceIndex >= 0 ? resolveVoiceColor(loc.voiceId, voiceIndex, voiceColors) : undefined;
            const chordIds = chordNoteIds(doc, h.noteId);
            return (
              // the whole stem (minus the notehead-adjacent inset) is the grab target, not just
              // the tip — VexFlow's own rendered stem is ~1.5px, too thin to reliably click.
              <g
                key={`${h.noteId}:${h.staffId}`}
                // `.selected`: every note of the carrier selected, AND (a real chord OR picked at
                // carrier granularity via this stem/a chord double-click — `carrierSelectedIds`).
                className={
                  'stem-handle-group' +
                  (chordIds.every((id) => selectedIds.includes(id)) &&
                  (chordIds.length > 1 || carrierSelectedIds.includes(h.noteId))
                    ? ' selected'
                    : '')
                }
                style={voiceColor ? ({ '--voice-color': voiceColor } as React.CSSProperties) : undefined}
              >
                <line
                  className="stem-handle-hit"
                  x1={h.x}
                  y1={hitStartY}
                  x2={h.x}
                  y2={hitEndY}
                  // No onPointerDown/onPointerEnter — both click/drag (`onDownStem`) and hover
                  // (`computeHover`) are handled geometrically at the root; this line stays only
                  // for its CSS `:hover` highlight where it IS the topmost element.
                />
                <line className="stem-handle-visual" x1={h.x} y1={visualStartY} x2={h.x} y2={visualEndY} />
                {/* the visible, grabbable point — a dot at the free tip, never the connected end. */}
                <circle className="stem-handle-dot" cx={h.x} cy={h.tipY} r={5} />
              </g>
            );
          })}
      {layout.noteBoxes.map((b) => (
        <rect
          key={b.id}
          className="hit"
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={3}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            if (durationTool) {
              const p = toSvg(e);
              insertAt(p.x, p.y);
              return;
            }
            if (e.altKey) {
              // `b.id`, not `b.carrierId` — a cross-staff chord's carrier can't resolve a staff alone.
              groupFromNote(b.id, 'staff', e.shiftKey);
              return;
            }
            // plain click selects the one note under the cursor; a fast second click on the
            // SAME note escalates to the whole chord (carrier granularity).
            const now = Date.now();
            const last = lastNoteClickRef.current;
            if (last && last.id === b.id && now - last.time < DOUBLE_CLICK_MS) {
              selectMany(chordNoteIds(doc, b.carrierId), e.shiftKey, [b.carrierId]);
              lastNoteClickRef.current = null;
            } else {
              select(b.id, e.shiftKey);
              lastNoteClickRef.current = { id: b.id, time: now };
            }
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            // plain double-click is handled manually above; native dblclick is only used for the
            // Alt-modified whole-voice select.
            if (!durationTool && e.altKey) groupFromNote(b.id, 'voice', e.shiftKey);
          }}
          // hover preview isn't wired here — see `computeHover`, which decides note-vs-stem
          // geometrically (these boxes are padded/tiled for forgiving click precision).
        />
      ))}
      {layout.barlines.map((bl) => (
        <rect
          key={bl.measureId}
          className="barline-hit"
          x={bl.x - 5}
          y={bl.y0}
          width={10}
          height={bl.y1 - bl.y0}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            if (!durationTool) selectMany(measureNoteIds(doc, bl.measureId), e.shiftKey);
          }}
          // hover-tint on barline removed for now — read as glitchy in practice; click-to-select
          // is untouched.
        />
      ))}
      {band && <rect className="band" x={band.x} y={band.y} width={band.w} height={band.h} />}
      {durationTool && ghost && isDurationTool(tool) && (
        <g
          className="insert-ghost"
          transform={`translate(${ghost.x} ${ghost.y})`}
          style={{ color: currentVoiceColor }}
          dangerouslySetInnerHTML={{
            __html: getGhostGlyphMarkup(tool, ghost.staffStep, clefOf(ghost.staffId)),
          }}
        />
      )}
      {mode === 'line' && (playing || timeBeats > 0) && (
        <line className="cursor" x1={cursorX} y1={layout.systemTop} x2={cursorX} y2={layout.systemBottom} />
      )}
    </svg>
  );
}

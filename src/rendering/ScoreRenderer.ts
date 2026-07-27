// Rendering-agnostic layout the interaction layers depend on. Any engraver
// (VexFlow now, custom SMuFL later) produces a ScoreLayout; the overlay, hit
// testing, playback cursor and practice highlighting all read from it — so the
// renderer can be swapped without touching interaction.

export interface TimeMapEntry {
  timeBeats: number;
  x: number;
}

export interface NoteBox {
  /** The individually-selectable note id (one key of a chord, or a rest/single-note's own id) —
   *  what a plain click selects. */
  id: string;
  /** The whole carrier this note belongs to — what a fast double-click (or the shared stem)
   *  selects (see `chordNoteIds` in core/model/query.ts). Equal to `id` for a rest. A carrier's
   *  boxes may share a `carrierId` across TWO DIFFERENT staves (a cross-staff chord) — grouping
   *  by `carrierId` alone is only safe when also disambiguated by `staffId` below. */
  carrierId: string;
  /** The physical staff this note is actually drawn on — for a cross-staff chord, its several
   *  `NoteBox`es (same `carrierId`) don't all share this. */
  staffId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A measure's terminating barline — a click target for measure selection. */
export interface BarlineBox {
  measureId: string;
  x: number;
  y0: number;
  y1: number;
}

/** A measure's own bounding box (system-local, unscaled layout units — same space as everything
 *  else in `ScoreLayout`) — used to pick and preserve a "scroll anchor" measure across line/page
 *  mode switches (EditorView.tsx): the measure closest to the top-left of the current viewport
 *  before the switch is re-located and scrolled back into that same relative position after. */
export interface MeasureBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A clickable staff area for a measure — lets a click map to (position, staff step)
 *  for note insertion. Geometry is deterministic from the drawn staffs. */
export interface StaffZone {
  measureId: string;
  staffId: string;
  /** note-area x-range (after clef / time-sig). */
  x0: number;
  x1: number;
  /** y of staff_step 0 (the staff's bottom line). */
  bottomLineY: number;
  /** vertical pixels per staff_step (half a line gap). */
  stepPx: number;
  /** the measure's beat count (num_beats), for x -> beat. */
  beats: number;
  /** the measure's beat unit (beat_value: 4 = quarter), for beat -> whole-note position. */
  beatValue: number;
  /** onset (quarter-note beats, from measure start) -> the x notes there are ACTUALLY drawn
   *  at, sorted ascending, always including 0 and the measure's end. Spacing is Gourlay
   *  (duration-weighted), not linear — interpolate piecewise between these, never straight
   *  across x0..x1, or a snapped/preview position drifts from where a click would really land. */
  segments: { beat: number; x: number }[];
}

/** A note's stem tip — the MuseScore-style drag handle to change stem direction/length.
 *  Absent for notes without a stem (rests, whole notes). */
export interface StemHandle {
  noteId: string;
  /** The physical staff this stem is drawn on — a cross-staff chord's two halves each have their
   *  OWN independent stem/handle sharing the same `noteId` (carrier id), so this is what tells
   *  them apart (React keys, per-staff box lookups). */
  staffId: string;
  x: number;
  /** the stem's notehead-side end (fixed reference point drag deltas are measured against). */
  baseY: number;
  /** the stem's free end — where the handle is drawn, and what dragging moves. */
  tipY: number;
  /** `1` = up, `-1` = down (matches VexFlow's `Stem.UP`/`Stem.DOWN`). */
  direction: 1 | -1;
  /** per-stem upper bound (px) on the dragged length, measured from `baseY`. Absent = use the
   *  editor's global default. A cross-staff stem sets this: its `baseY` (the top note) and its far
   *  note sit a whole inter-staff gap apart, so the length that merely CONNECTS them already
   *  exceeds a single note's default cap — without a larger bound, dragging clamps the stem shorter
   *  than the connection and it retracts flush to the far note (can't protrude, can't be edited). */
  maxLength?: number;
  /** explicit full grabbable span [hitY1, hitY2] of the stem, when the hit-line can't be derived
   *  from [baseY..tipY] alone. Set for a cross-staff stem, whose `baseY` sits INSIDE the drawn
   *  line (not at an end) after a direction flip; absent for a normal note, where baseY/tipY ARE
   *  the two ends. When present, Overlay draws the hit/visual line across this span instead. */
  hitY1?: number;
  hitY2?: number;
}

export interface ScoreLayout {
  /** the mode this layout was actually computed for — lets a consumer (EditorView.tsx's mode-
   *  switch scroll-anchor restore) tell a freshly-arrived layout apart from a stale one still
   *  reflecting the PREVIOUS mode (the `mode` prop and the `layout` state it eventually produces
   *  update in two separate render passes, not atomically). */
  mode: 'line' | 'page';
  width: number;
  height: number;
  /** musical time (in quarter beats) -> x, sorted ascending. */
  timeMap: TimeMapEntry[];
  totalBeats: number;
  /** vertical span for the playback cursor. */
  systemTop: number;
  systemBottom: number;
  /** clickable / selectable boxes, one per note. */
  noteBoxes: NoteBox[];
  /** clickable barline targets, one per measure. */
  barlines: BarlineBox[];
  /** one bounding box per measure — see `MeasureBox`. */
  measures: MeasureBox[];
  /** clickable staff areas, for insertion (one per measure per staff). */
  staffZones: StaffZone[];
  /** stem drag handles, one per stemmed note. */
  stemHandles: StemHandle[];
}

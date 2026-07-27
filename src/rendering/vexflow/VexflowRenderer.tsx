import { useEffect, useRef } from 'react';
import {
  Renderer,
  Stave,
  StaveNote,
  Voice,
  Formatter,
  StaveConnector,
  Accidental,
  Dot,
  StaveTie,
  Stem,
} from 'vexflow';
import type { Accidental as AccidentalValue, Clef, DurationValue, Item, Measure, ScoreDocument } from '@/core/model/score';
import type { ScoreLayout, TimeMapEntry, NoteBox, BarlineBox, StaffZone, StemHandle, MeasureBox } from '@/rendering/ScoreRenderer';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import { staffStepToKey } from '@/core/model/pitch';
import { shrinkWholeNotehead, getNotePaddingPx, fixLedgerLineWidth } from '@/rendering/vexflow/engravingScale';

const BEATS: Record<string, number> = { w: 4, h: 2, q: 1, '8': 0.5, '16': 0.25, '32': 0.125 };

function noteBeats(n: { duration: DurationValue; dots: number }): number {
  let b = BEATS[n.duration] ?? 1;
  if (n.dots) b *= 2 - Math.pow(0.5, n.dots);
  return b;
}

// The document model is voice-major and staff-blind (staff lives per-note on `Item.notes` — see
// core/model/score.ts); VexFlow draws per PHYSICAL STAFF, so this is the one place that derives a
// staff-major view, locally, at draw time. Splitting a chord `Item` by its notes' own `staffId`
// is also what turns a cross-staff chord into two drawn halves (same carrier id) on two staves.
interface RenderNote {
  /** The carrier id — the chord/rest as a WHOLE (delete-carrier, stem handle, group-select all
   *  key off this). Individual-note selection uses `noteIds` instead — see that field. */
  id: string;
  kind: 'note' | 'rest';
  /** VexFlow keys, e.g. ['c/4', 'e/4'] for a chord — only this staff's share of the chord. */
  keys: string[];
  duration: DurationValue;
  dots: number;
  /** One entry per key (accidental to draw), null = none. */
  accidentals: AccidentalValue[];
  /** Raw staff_step per key (0 = staff bottom line) — for vertical extent / ledger spacing. */
  staffSteps: number[];
  /** One entry per key — the backend's individual note_id, parallel to `keys`/`staffSteps`. */
  noteIds: string[];
  tieToNext?: boolean;
}

/** Split one voice-timeline item into its per-staff drawable halves — one entry per staff it
 *  touches (almost always one; two for a cross-staff chord). A rest lives on exactly one staff. */
function splitItemByStaff(item: Item, clefOf: (staffId: string) => Clef): Map<string, RenderNote> {
  const out = new Map<string, RenderNote>();
  if (item.kind === 'rest') {
    if (item.staffId !== undefined) {
      out.set(item.staffId, {
        id: item.id,
        kind: 'rest',
        keys: [],
        duration: item.duration,
        dots: item.dots,
        accidentals: [],
        staffSteps: [],
        noteIds: [],
        tieToNext: item.tieToNext,
      });
    }
    return out;
  }
  const byStaff = new Map<string, typeof item.notes>();
  for (const n of item.notes) {
    const arr = byStaff.get(n.staffId);
    if (arr) arr.push(n);
    else byStaff.set(n.staffId, [n]);
  }
  for (const [staffId, notes] of byStaff) {
    out.set(staffId, {
      id: item.id,
      kind: 'note',
      keys: notes.map((n) => staffStepToKey(n.staffStep, clefOf(staffId))),
      duration: item.duration,
      dots: item.dots,
      accidentals: notes.map((n) => n.accidental),
      staffSteps: notes.map((n) => n.staffStep),
      noteIds: notes.map((n) => n.noteId),
      tieToNext: item.tieToNext,
    });
  }
  return out;
}

const MARGIN_L = 24;
const MARGIN_T = 40;
const STAFF_H = 40; // staff height (5 lines); stepPx = STAFF_H / 8 (half a line gap per staff_step)
const STAFF_CLEARANCE = 34; // min gap between a treble's bottom and a bass's top, beyond ledgers
const SYSTEM_GAP = 76; // min gap between systems, beyond ledger extents (roomy — leaves headroom for measure numbers)
const MIN_MEASURE_W = 40; // degenerate-case floor for a measure's natural note-area width
const PAGE_CONTENT_W = 700; // A4-ish usable width for page mode — the per-system justification target;
// fallback only for when `pageContentWidth` isn't measured yet (Props.pageContentWidth overrides
// this per render — reflow-zoom, see EditorView.tsx)
const MEASURE_RIGHT_PAD = 26; // breathing room between the last note and the barline
const HEAD_HALF = 11; // half a notehead's height (px) — note-hitbox padding + extent margin
const DASH_W = 16; // empty-measure dash width
const DASH_THICK = 4; // empty-measure dash thickness
const STEM_WIDTH = 1.5; // matches VexFlow's own Stem.WIDTH — the custom cross-staff connector must look identical to a native stem
// durations that carry a FLAG (unbeamed 8th/16th/32nd) — a cross-staff chord's merged stem has
// no free end for a flag to attach to (both ends are real noteheads, on the two different
// staves), which needs a real engraving decision this pass doesn't make. Excluded from the
// single-stem merge below; these fall back to each half's own independent native stem.
const FLAG_DURATIONS = new Set<DurationValue>(['8', '16', '32']);
// how far the merged cross-staff stem protrudes PAST the far notehead when no user override sets
// an explicit length — matches ordinary engraving (a stem always sticks out beyond its outermost
// notehead, never stops flush at it). No ambiguous "which staff is closer to the middle line"
// signal exists across two different staves, so direction defaults to DOWN (foot at the upper
// staff's note, same as any stem-down chord's foot sits at its highest note) — fully overridable
// by drag/double-click, exactly like any other note's stem (see the merge pass below).
const DEFAULT_STEM_PROTRUSION = 35;
const CROSS_STAFF_DEFAULT_DIRECTION: 1 | -1 = -1;

// Gourlay/Ross-style engraving spacing: duration → width grows sub-linearly (each duration
// doubling adds a fixed increment, not a doubled gap) — matches MuseScore/Finale/Sibelius/LilyPond.
// These three constants are the only visual dials; tune by eyeballing rendered output.
const MIN_DURATION_BEATS = 0.125; // 32nd note — smallest supported duration, the calibration anchor
const SPACE_UNIT = 10; // px given to the shortest duration
const SPACE_STRETCH = 7; // px added per doubling of duration (log2 slope)
const NOTE_HEAD_MIN_GAP = 12; // collision floor: min px between consecutive onsets regardless of duration
const ACCIDENTAL_PAD = 10; // extra px before a note carrying an accidental
const DOT_PAD = 4; // extra px per augmentation dot after a note

function durationSpacePx(beats: number): number {
  const doublings = Math.log2(Math.max(beats, MIN_DURATION_BEATS) / MIN_DURATION_BEATS);
  return SPACE_UNIT + SPACE_STRETCH * doublings;
}

function buildStaveNote(
  n: RenderNote,
  clef: string,
  inkColor: string,
  stemOverride?: { direction: 1 | -1; length: number | null },
): StaveNote {
  const keys = n.keys.length ? n.keys : ['b/4'];
  const sn = new StaveNote({
    keys,
    duration: n.kind === 'rest' ? `${n.duration}r` : n.duration,
    clef,
    // manual override wins; otherwise MuseScore-style automatic direction (VexFlow's own
    // `calculateOptimalStemDirection`: up if the note sits below the middle line, down if at/above
    // it) — replaces the old implicit "always up" (no direction option = VexFlow's default).
    ...(n.kind === 'note' ? (stemOverride ? { stem_direction: stemOverride.direction } : { auto_stem: true }) : {}),
  });
  // manual direction/length override — `setStemDirection` (not just setting the field) re-propagates
  // the resulting extension onto the actual `Stem` object, which is what draw() actually reads.
  // `length === null` = "flip/pin the DIRECTION but keep VexFlow's NATURAL length" — essential for
  // chords, whose natural stem is longer than a single note's default 35px: forcing 35 there would
  // draw a stem too short to reach past the chord's own notes. So only `setStemLength` when a real
  // (dragged) custom length is present; a null length leaves the natural length intact.
  if (stemOverride && n.kind === 'note') {
    if (stemOverride.length !== null) sn.setStemLength(stemOverride.length);
    sn.setStemDirection(stemOverride.direction);
  }
  // VexFlow's ledger-line default (#444, a cool grey) doesn't match either the notation's
  // black noteheads or the app's warm ink token — force them to the same ink so a note sitting
  // on ledger lines reads as one consistent color instead of the lines looking washed out.
  sn.setLedgerLineStyle({ strokeStyle: inkColor, fillStyle: inkColor });
  fixLedgerLineWidth(sn);
  n.keys.forEach((_, i) => {
    const acc = n.accidentals[i];
    if (acc && acc !== 'n') sn.addModifier(new Accidental(acc), i);
  });
  if (n.dots > 0) Dot.buildAndAttach([sn], { all: true });
  return sn;
}

interface Drawn {
  staffId: string;
  voiceIndex: number;
  notes: RenderNote[];
  sns: StaveNote[];
  /** cumulative onset (in quarter-note beats) of each note, parallel to `notes`/`sns`. */
  onsets: number[];
  /** null for a fully untouched staff (no voice at all) — see `isEmpty`. */
  voice: Voice | null;
  /** nothing user-entered (no voice, or a single whole-measure rest) — draw a dash instead. */
  isEmpty: boolean;
}

interface Built {
  measure: Measure;
  drawn: Drawn[];
  /** natural (unstretched) note-area width, from the merged cross-voice onset timeline. */
  naturalWidth: number;
  /** onset beat -> cumulative px offset from the measure's note-start, pre-justification. */
  segmentX: Map<number, number>;
  /** carrier ids whose notes split across MORE THAN ONE staff (a cross-staff chord) AND carry no
   *  flag — these get a single connecting stem drawn across both staves in the draw pass, instead
   *  of each half's own independent native stem (see `FLAG_DURATIONS`). */
  crossStaffCarrierIds: Set<string>;
}

interface Props {
  document: ScoreDocument;
  selectedIds: string[];
  /** carrier ids selected at CARRIER granularity (stem-click / chord double-click) — see
   *  app/store.ts. Lets a single-note carrier's stem/notehead group tint on selection when it was
   *  explicitly picked as a carrier, without a plain notehead click on that same lone note ever
   *  doing so (see the `.selected` tint effect below). */
  carrierSelectedIds: string[];
  mode: 'line' | 'page';
  /** Page mode's per-system justification target, in layout units (`PAGE_CONTENT_W`'s live
   *  replacement) — "reflow zoom": EditorView.tsx measures `.canvas-area`'s available width and
   *  divides out the current zoom, so the RENDERED page width stays pinned to the viewport
   *  regardless of zoom level; zoom only changes how much content fits per system (more systems,
   *  taller document), never page width — page mode never needs horizontal scroll. Undefined
   *  (before the first measurement, or in line mode where it's unused) falls back to the fixed
   *  `PAGE_CONTENT_W` constant. */
  pageContentWidth?: number;
  onLayout: (layout: ScoreLayout) => void;
  /** custom voice-color overrides (keyed by voice id) — see core/model/voiceColors. */
  voiceColors: Record<string, string>;
  /** manual stem direction/length overrides (keyed by note carrier id) — see app/store.ts. */
  stemOverrides: Record<string, { direction: 1 | -1; length: number | null }>;
  /** the currently-hovered note carrier ids (ephemeral UI state, lifted in EditorView.tsx) — a
   *  single note on note-hover, a whole measure's on barline-hover, empty otherwise. Lightly
   *  tints the actual note glyph(s), not a box behind them. */
  hoveredNoteIds: string[];
}

export function VexflowRenderer({
  document: doc,
  selectedIds,
  carrierSelectedIds,
  mode,
  pageContentWidth,
  onLayout,
  voiceColors,
  stemOverrides,
  hoveredNoteIds,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const effectivePageContentWidth = pageContentWidth ?? PAGE_CONTENT_W;
  const selectionKey = selectedIds.join(',');
  const carrierSelectionKey = carrierSelectedIds.join(',');
  const hoverKey = hoveredNoteIds.join(',');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';

    const staffOrder = doc.staffOrder;
    const clefOf = (staffId: string) => (staffOrder.indexOf(staffId) === 0 ? 'treble' : 'bass');
    const inkColor = getComputedStyle(host).getPropertyValue('--color-ink').trim() || '#000';
    const mutedColor = getComputedStyle(host).getPropertyValue('--color-ink-muted').trim() || '#6f6153';

    // renderer/context created up front (resized once the total layout is known below) so we
    // can MEASURE the real clef+time-sig glyph width via VexFlow instead of guessing a constant —
    // a mismatch there is what let notes drift past their own measure's barline (§ fix).
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    const ctx = renderer.getContext();
    const probeTreble = new Stave(0, 0, 1000).setContext(ctx).addClef('treble').addTimeSignature('4/4');
    const probeBass = new Stave(0, 0, 1000).setContext(ctx).addClef('bass').addTimeSignature('4/4');
    Stave.formatBegModifiers([probeTreble, probeBass]);
    const clefTsW = Math.max(probeTreble.getNoteStartX(), probeBass.getNoteStartX());

    // 1) build the notes + voices per measure, then the measure's Gourlay-style onset timeline:
    // the union of onset beats across ALL its voices (both staffs) — a busy voice's fine onsets
    // force extra segments into a sparser voice's notes, visually stretching them (§ plan step 2).
    //
    // The document is voice-major (see core/model/score.ts) — a measure holds VOICES, and staff
    // is a per-note attribute on each item. VexFlow draws per physical staff, so here we derive a
    // staff-major grouping LOCALLY: walk each voice's own item stream (onset accumulated over
    // that FULL stream, before any staff-split — a cross-staff item's two halves must share the
    // same onset), split each item by its notes' own staffId (`splitItemByStaff`), and bucket the
    // halves by (staffId, voiceId). A staff can now end up with MORE THAN ONE real voice (a
    // cross-staff chord note landing on a staff another voice already occupies) — `Drawn` becomes
    // one entry per (staff, voice-with-content-there) pair instead of one entry per staff.
    interface Group {
      staffId: string;
      voiceId: string;
      notes: RenderNote[];
      onsets: number[];
    }
    const built: Built[] = doc.measures.map((measure) => {
      const totalBeats = (measure.timeSignature.beats * 4) / measure.timeSignature.beatValue;

      const groups = new Map<string, Group>(); // key = `${staffId}:${voiceId}`
      measure.voices.forEach((voice) => {
        let onset = 0;
        voice.items.forEach((item) => {
          const o = onset;
          onset += noteBeats(item);
          const split = splitItemByStaff(item, clefOf);
          split.forEach((renderNote, staffId) => {
            const key = `${staffId}:${voice.id}`;
            let g = groups.get(key);
            if (!g) {
              g = { staffId, voiceId: voice.id, notes: [], onsets: [] };
              groups.set(key, g);
            }
            g.notes.push(renderNote);
            g.onsets.push(o);
          });
        });
      });

      // Cross-staff chords (one carrier's notes split across MORE THAN ONE staff — see
      // splitItemByStaff) need a SINGLE stem physically connecting both halves, with EXACTLY the
      // same selection/drag/protrusion behaviour as any other note's stem — computed here, BEFORE
      // building StaveNotes, so both halves get a CONSISTENT forced direction (never each
      // independently auto-computed) even before any user override exists; the actual
      // baseY/tipY/length are only knowable once both halves are drawn (real pixel Y), so those
      // are finished in the merge pass after the draw loop below.
      const carrierStaffInfo = new Map<string, { staffs: Set<string>; hasFlag: boolean }>();
      for (const g of groups.values()) {
        g.notes.forEach((n) => {
          let info = carrierStaffInfo.get(n.id);
          if (!info) {
            info = { staffs: new Set(), hasFlag: false };
            carrierStaffInfo.set(n.id, info);
          }
          info.staffs.add(g.staffId);
          if (FLAG_DURATIONS.has(n.duration)) info.hasFlag = true;
        });
      }
      const crossStaffCarrierIds = new Set(
        [...carrierStaffInfo.entries()].filter(([, info]) => info.staffs.size > 1 && !info.hasFlag).map(([id]) => id),
      );

      const drawn: Drawn[] = [];
      staffOrder.forEach((staffId) => {
        const staffGroups = [...groups.values()]
          .filter((g) => g.staffId === staffId)
          // stable draw order = document voice order, regardless of which staff a voice lands on
          .sort(
            (a, b) =>
              doc.voices.findIndex((v) => v.id === a.voiceId) - doc.voices.findIndex((v) => v.id === b.voiceId),
          );
        // a fully untouched staff (no voice at all — a "sleeping" measure that was never
        // engine-processed, or simply nothing landed here this measure) gets the SAME
        // empty-measure dash as an explicit whole-rest fill (below).
        if (!staffGroups.length) {
          drawn.push({ staffId, voiceIndex: -1, notes: [], sns: [], onsets: [], voice: null, isEmpty: true });
          return;
        }
        staffGroups.forEach((g) => {
          const sns = g.notes.map((n) => {
            const override =
              stemOverrides[n.id] ??
              (crossStaffCarrierIds.has(n.id) ? { direction: CROSS_STAFF_DEFAULT_DIRECTION, length: null } : undefined);
            return buildStaveNote(n, clefOf(staffId), inkColor, override);
          });
          const voice = new Voice({
            num_beats: measure.timeSignature.beats,
            beat_value: measure.timeSignature.beatValue,
          }).setStrict(false);
          voice.addTickables(sns);
          // data-voice uses the GLOBAL voice index (voices span staffs), so voice colors
          // are consistent regardless of which staff a voice appears on.
          const voiceIndex = doc.voices.findIndex((vr) => vr.id === g.voiceId);
          // a voice with NOTHING user-entered comes back from the backend's gap-fill as a single
          // whole-measure rest — render it as a dash (MuseScore convention), not the rest glyph,
          // so "empty" reads as empty rather than "explicitly silent". Frontend-only: the data
          // model still holds a real rest (the backend has no separate "empty" concept to persist).
          const isEmpty =
            g.notes.length === 1 &&
            g.notes[0].kind === 'rest' &&
            Math.abs(noteBeats(g.notes[0]) - totalBeats) < 1e-6;
          drawn.push({ staffId, voiceIndex, notes: g.notes, sns, onsets: g.onsets, voice, isEmpty });
        });
      });

      const notesAtOnset = new Map<number, RenderNote[]>();
      const onsetSet = new Set<number>([0, totalBeats]);
      for (const g of groups.values()) {
        g.notes.forEach((n, i) => {
          const o = g.onsets[i];
          onsetSet.add(o);
          const at = notesAtOnset.get(o) ?? [];
          at.push(n);
          notesAtOnset.set(o, at);
        });
      }
      const sortedOnsets = [...onsetSet].sort((a, b) => a - b);

      const segmentX = new Map<number, number>([[sortedOnsets[0], 0]]);
      let cum = 0;
      for (let i = 1; i < sortedOnsets.length; i++) {
        const b0 = sortedOnsets[i - 1];
        const b1 = sortedOnsets[i];
        const hasAccidentalAtEnd = (notesAtOnset.get(b1) ?? []).some((n) =>
          n.accidentals.some((a) => a && a !== 'n'),
        );
        const dotsAtStart = (notesAtOnset.get(b0) ?? []).reduce((max, n) => Math.max(max, n.dots), 0);
        const gapW =
          Math.max(durationSpacePx(b1 - b0), NOTE_HEAD_MIN_GAP) +
          (hasAccidentalAtEnd ? ACCIDENTAL_PAD : 0) +
          dotsAtStart * DOT_PAD;
        cum += gapW;
        segmentX.set(b1, cum);
      }
      // + MEASURE_RIGHT_PAD so the barline never lands flush against the last note — the pad is
      // part of what the measure actually needs, so it must flow through packing/justification too.
      const naturalWidth = Math.max(cum, MIN_MEASURE_W) + MEASURE_RIGHT_PAD;

      return { measure, drawn, naturalWidth, segmentX, crossStaffCarrierIds };
    });

    // 2) pack measures into systems (line = one unbounded system, natural widths, no
    // justification — MuseScore's Continuous View; page = greedily fill each system to
    // PAGE_CONTENT_W by natural (content-driven) width, then justify in step 3)
    const systems: Built[][] = [];
    if (mode === 'line') {
      systems.push(built);
    } else {
      let current: Built[] = [];
      let currentW = 0;
      for (const b of built) {
        const isFirst = current.length === 0;
        const addW = b.naturalWidth + (isFirst ? clefTsW : 0);
        if (!isFirst && currentW + addW > effectivePageContentWidth) {
          systems.push(current);
          current = [b];
          currentW = b.naturalWidth + clefTsW;
        } else {
          current.push(b);
          currentW += addW;
        }
      }
      if (current.length) systems.push(current);
    }

    // compute positions (x/y/width) for every measure before drawing (resize needs totals)
    interface Placed {
      b: Built;
      x: number;
      w: number;
      isFirst: boolean;
      trebleY: number;
      bassY: number;
      /** justification factor applied to this measure's natural onset-segment widths. */
      stretch: number;
    }
    // vertical extents of each system's notes, to space staffs/systems by their ledger reach
    // (staff_step: 0 = staff bottom line, 8 = top line; < 0 or > 8 = ledger lines)
    const stepPx = STAFF_H / 8;
    // per-staff min/max staff_step reached (incl. ledger lines), keyed by staff id — generic over
    // however many staffs are in staffOrder (not hardcoded to treble+bass), so this keeps working
    // if a 3rd+ staff is added later. The current draw pipeline below still only positions exactly
    // two staffs (staffOrder[0]/[1]) — extending THAT to N staffs is a separate, larger change; this
    // just keeps the extent math itself from being the thing that has to be rewritten when it happens.
    const extents = systems.map((sysMeasures) => {
      const byStaff = new Map<string, { min: number; max: number }>(staffOrder.map((id) => [id, { min: 0, max: 8 }]));
      for (const b of sysMeasures) {
        for (const d of b.drawn) {
          const ext = byStaff.get(d.staffId);
          if (!ext) continue;
          for (const n of d.notes) {
            for (const s of n.staffSteps) {
              ext.min = Math.min(ext.min, s);
              ext.max = Math.max(ext.max, s);
            }
          }
        }
      }
      return byStaff;
    });
    const extentOf = (byStaff: Map<string, { min: number; max: number }>, staffId: string) =>
      byStaff.get(staffId) ?? { min: 0, max: 8 };
    const below = (step: number) => Math.max(0, -step) * stepPx + HEAD_HALF; // reach below a bottom line
    const above = (step: number) => Math.max(0, step - 8) * stepPx + HEAD_HALF; // reach above a top line

    // Measure widths follow their natural (content-driven) onset-segment width — NOT equal
    // across a system — so a measure with many small notes is visibly wider than a neighboring
    // measure of long notes. `page` mode then justifies (stretches, never compresses) each
    // system's total to fill PAGE_CONTENT_W; `line` mode stays at natural width (stretch = 1),
    // matching MuseScore's Continuous View. Vertical gaps are dynamic: the treble→bass gap grows
    // with the treble's lowest and the bass's highest notes (incl. ledger lines); the system gap
    // likewise with the reaches between them.
    const placedSystems: Placed[][] = [];
    let totalW = 0;
    let cursorY = MARGIN_T;
    let firstBassBottom = MARGIN_T + STAFF_H;
    systems.forEach((sysMeasures, si) => {
      const ex = extents[si];
      const staffGap =
        STAFF_H +
        below(extentOf(ex, staffOrder[0]).min) +
        above(extentOf(ex, staffOrder[1]).max) +
        STAFF_CLEARANCE;
      const trebleY = cursorY;
      const bassY = trebleY + staffGap;
      if (si === 0) firstBassBottom = bassY + STAFF_H;

      // clefTsW is fixed (never stretched — the clef glyph doesn't scale), so the stretch
      // factor must be solved against the STRETCHABLE (content-only) width, not the system's
      // full natural width incl. clef — otherwise a system with few measures (where the fixed
      // clef is a bigger fraction of the total, e.g. a short trailing system) under-stretches
      // and falls short of PAGE_CONTENT_W, leaving a gap on the right.
      const contentNaturalW = sysMeasures.reduce((sum, b) => sum + b.naturalWidth, 0);
      const naturalSystemW = contentNaturalW + clefTsW;
      const stretch =
        mode === 'page' && naturalSystemW <= effectivePageContentWidth
          ? (effectivePageContentWidth - clefTsW) / contentNaturalW
          : 1;
      let x = MARGIN_L;
      const placed = sysMeasures.map((b, mi) => {
        const extra = mi === 0 ? clefTsW : 0;
        const w = b.naturalWidth * stretch + extra;
        const item: Placed = { b, x, w, isFirst: mi === 0, trebleY, bassY, stretch };
        x += w;
        return item;
      });
      totalW = Math.max(totalW, x + MARGIN_L);
      placedSystems.push(placed);

      const nextTrebleUp =
        si + 1 < extents.length ? above(extentOf(extents[si + 1], staffOrder[0]).max) : 0;
      cursorY = bassY + STAFF_H + below(extentOf(ex, staffOrder[1]).min) + nextTrebleUp + SYSTEM_GAP;
    });
    const totalH = cursorY + 20;
    renderer.resize(totalW, totalH);

    // Per-measure bounding boxes, straight from `placedSystems` (already fully computed above,
    // before any drawing) — independent of the draw pass below, so this can't perturb it. Used by
    // EditorView.tsx to preserve a scroll anchor across line/page mode switches: matches the
    // barlines' own y0/y1 convention (`trebleY - 12` .. `bassY + STAFF_H + 12`) for consistency.
    const measures: MeasureBox[] = placedSystems.flatMap((placed) =>
      placed.map((p) => ({
        id: p.b.measure.id,
        x: p.x,
        y: p.trebleY - 12,
        w: p.w,
        h: p.bassY + STAFF_H + 12 - (p.trebleY - 12),
      })),
    );

    // 3) draw
    const timeMap: TimeMapEntry[] = [];
    const noteBoxes: NoteBox[] = [];
    const barlines: BarlineBox[] = [];
    const staffZones: StaffZone[] = [];
    const stemHandles: StemHandle[] = [];
    let cumBeat = 0;
    let lastRightX = MARGIN_L;
    // VexFlow's silent per-note stave-padding offset (see `padding` below) is a fixed quirk of
    // its own `.setStave()`/draw pipeline, not a value specific to any one measure — so a
    // measure's own real note is the BEST calibration source when it has one, but any other
    // measure's real note in this same render pass is just as valid a source, and far better
    // than assuming a false zero. Carried across the whole draw loop (last real measurement
    // wins) so a measure with NO notes of its own (first insert into a fully empty measure) still
    // gets the correct offset instead of the pure, uncorrected formula. Seeded from the
    // always-available probe measurement (not 0) so this is correct even when NOTHING in the
    // document has a real note yet, or the very first measure(s) in draw order are the empty
    // ones — the systemic fix, not just "usually right because something upstream had content".
    let documentPadding = getNotePaddingPx();
    // 1-based measure number, counted across the whole piece (document order = draw order).
    let measureNumber = 0;

    placedSystems.forEach((placed) => {
      const sysStaffs: { treble: Stave; bass: Stave }[] = [];

      placed.forEach(({ b, x, w, isFirst, trebleY, bassY, stretch }, mi) => {
        measureNumber += 1;
        // context first, so begin-modifier glyph widths are measured for alignment
        const treble = new Stave(x, trebleY, w).setContext(ctx);
        const bass = new Stave(x, bassY, w).setContext(ctx);
        if (isFirst) {
          treble.addClef('treble').addTimeSignature('4/4');
          bass.addClef('bass').addTimeSignature('4/4');
        }
        // align both staffs' begin modifiers (treble & bass clefs differ in width) so notes
        // start at the same x → same-beat notes across the grand staff line up vertically
        Stave.formatBegModifiers([treble, bass]);
        const noteStartX = Math.max(treble.getNoteStartX(), bass.getNoteStartX());
        treble.setNoteStartX(noteStartX);
        bass.setNoteStartX(noteStartX);
        treble.draw();
        bass.draw();
        sysStaffs.push({ treble, bass });
        // measure number above each system's FIRST measure (engraving convention). Counted
        // from 1 across the piece; the very first measure is left unlabelled (implicit "1").
        // Sits just above the top staff line, at the measure's left edge.
        if (mi === 0 && measureNumber > 1) {
          ctx.save();
          ctx.setFont('Inter, sans-serif', 9, 'normal');
          ctx.setFillStyle(mutedColor);
          ctx.fillText(String(measureNumber), x + 2, treble.getYForLine(0) - 6);
          ctx.restore();
        }
        // insertion geometry: a clickable zone per staff (bottom line = staff_step 0).
        // MUST read the bottom line's y from the Stave itself, not `trebleY/bassY + STAFF_H`
        // — the y passed to `new Stave(x, y, w)` is the staff's bounding-box top, not the top
        // line: VexFlow reserves `space_above_staff_ln` (4 lines' worth, 40px at the default
        // spacing) above the first drawn line, so the hand-rolled formula was off by exactly
        // that — insert clicks landed ~8 staff_steps away from the clicked line, which is what
        // put inserted notes absurdly far off-staff.
        //
        // NOT `Stave.getBottomLineY()` though — that VexFlow method actually returns
        // `getYForLine(num_lines)`, i.e. ONE FULL LINE-SPACING BELOW the real bottom line (line
        // `num_lines - 1`, 0-indexed) despite its name; using it shifted every staff_step by +2
        // (one line = 2 of our half-line steps), so insert/ghost staff_step no longer matched
        // the clicked/hovered pixel — a note landing visually ON the top line resolved to
        // staff_step 10 instead of 8 (an extra ledger exactly at the top line), and the true
        // first-ledger-below position resolved to 0 (on the bottom line — the first ledger below
        // silently vanished). `getYForLine(getNumLines() - 1)` is the real bottom line.
        const staffBottomLineY = (staff: Stave) => staff.getYForLine(staff.getNumLines() - 1);
        // Zone x0 is the measure's own LEFT EDGE (`x`, = the previous measure's barline, or the
        // system's left margin for the first measure) — NOT `noteStartX` (which sits a few px
        // further right, after the clef/time-sig or the barline's own breathing room). Using
        // noteStartX left a small dead gap, per system, between one measure's zone (ending at its
        // own barline) and the next measure's zone (starting at noteStartX): hovering exactly on
        // a barline (or in that gap) matched NO zone in the correct system, so `candidates` fell
        // through to whichever OTHER system's measure happened to numerically span that x —
        // sending the ghost to a random other system. `x` makes adjacent zones within a system
        // share a boundary with no gap, so a barline always resolves inside its own system.
        // interp() over `segments` (not x0/x1) still does the actual beat snapping, so this only
        // affects which zone gets PICKED, never the snapped position within it.
        const zoneX0 = x;
        const stepPx = STAFF_H / 8;
        const beats = b.measure.timeSignature.beats;
        const beatValue = b.measure.timeSignature.beatValue;

        const staffInfo: Record<string, { staff: Stave; y: number }> = {
          [staffOrder[0]]: { staff: treble, y: trebleY },
          [staffOrder[1]]: { staff: bass, y: bassY },
        };

        // note area width is this measure's own (possibly justified) natural width
        const formatW = Math.max(w - (isFirst ? clefTsW : 0) - MEASURE_RIGHT_PAD, 40); // pad already in `w` via naturalWidth
        // join voices GROUPED BY STAFF (not all together, and not each alone) — joining voices
        // across the two staffs makes VexFlow shift same-beat notes apart as if they collided on
        // one staff, but two REAL voices sharing the SAME staff (e.g. a cross-staff chord note
        // landing where another voice already lives) need VexFlow's own multi-voice collision
        // avoidance, which only kicks in when they're joined TOGETHER. format() still tick-aligns
        // every voice across the grand staff regardless of grouping.
        // Bound to its OWN staff by staff-id (not a positional voices[0]/[1] index) — a staff
        // with no voice at all (empty) must not shift which real voice lands on which staff.
        const realVoices = b.drawn
          .map((d) => ({ voice: d.voice, staff: staffInfo[d.staffId]?.staff }))
          .filter((v): v is { voice: Voice; staff: Stave } => v.voice !== null && !!v.staff);
        if (realVoices.length) {
          realVoices.forEach(({ voice, staff }) => voice.setStave(staff));
          const formatter = new Formatter({ softmaxFactor: 1 });
          const byStaffVoices = new Map<Stave, Voice[]>();
          realVoices.forEach(({ voice, staff }) => {
            const arr = byStaffVoices.get(staff) ?? [];
            arr.push(voice);
            byStaffVoices.set(staff, arr);
          });
          byStaffVoices.forEach((voices) => formatter.joinVoices(voices));
          formatter.format(
            realVoices.map((v) => v.voice),
            formatW,
          );
          // override the formatter's own x with the Gourlay-style position: cumulative width
          // over the measure's merged cross-voice onset timeline (built in step 1), scaled by
          // this system's justification factor — so a note's gap depends on the busiest voice
          // at that beat, not just its own duration, and can differ measure to measure.
          // NB: Note.getAbsoluteX() deliberately EXCLUDES x_shift (VexFlow's own doc comment),
          // and — at this point, before the note's own `.stave` back-reference is set during
          // draw — it ALSO excludes staff.getNoteStartX(), returning just the tick context's
          // own x. The staff offset gets added a SECOND time at actual render, so noteStartX
          // must NOT be baked into the shift here (double-counted otherwise): target the
          // content-relative segX only, not `noteStartX + segX`.
          b.drawn.forEach((d) => {
            d.sns.forEach((sn, ni) => {
              const segX = b.segmentX.get(d.onsets[ni]) ?? 0;
              const targetX = segX * stretch;
              sn.setXShift(sn.getXShift() + (targetX - sn.getAbsoluteX()));
            });
          });
        }

        // accumulates each half of a cross-staff chord (`b.crossStaffCarrierIds`) as it's drawn,
        // so a single connecting stem can be drawn ONCE both halves' real pixel positions are
        // known — see the merge pass right after this loop.
        const crossStaffHalves = new Map<string, { sn: StaveNote; staffId: string }[]>();
        b.drawn.forEach((d) => {
          const info = staffInfo[d.staffId];
          if (!info) return;

          if (d.isEmpty) {
            // empty-measure dash (MuseScore convention) — a short thick bar centered in the
            // measure on the middle line, in place of the whole-rest glyph the backend filled
            // this voice with (or, for a fully untouched staff, in place of nothing at all).
            // Drawn directly (no Voice.draw()) — no note/voice is required to place it.
            // Centered between the note-start (after any clef) and the actual barline (x + w)
            // — NOT `noteStartX + formatW`, since formatW has MEASURE_RIGHT_PAD subtracted
            // out (breathing room for real notes before the barline) and would skew the dash
            // left of the measure's true visual center.
            const cx = (noteStartX + (x + w)) / 2;
            // one half-line above dead-center (line 2 = the exact middle line) — matches the
            // reference engraving, which sits the dash slightly above center, not on it.
            const cy = info.staff.getYForLine(1.5);
            ctx.save();
            ctx.setFillStyle(inkColor);
            ctx.fillRect(cx - DASH_W / 2, cy - DASH_THICK / 2, DASH_W, DASH_THICK);
            ctx.restore();
            const id = d.notes[0]?.id ?? `${b.measure.id}-${d.staffId}-empty`;
            noteBoxes.push({
              id,
              carrierId: id,
              staffId: d.staffId,
              x: cx - DASH_W / 2 - 7,
              y: cy - HEAD_HALF,
              w: DASH_W + 14,
              h: HEAD_HALF * 2,
            });
            return;
          }

          d.voice?.draw(ctx, info.staff);
          d.sns.forEach((sn, ni) => {
            const g = sn.getSVGElement();
            g?.setAttribute('data-note-id', d.notes[ni].id);
            g?.setAttribute('data-voice', String(d.voiceIndex));
            // Tag ledger lines with `vf-ledger` so the selection tint can skip them — they're bare
            // horizontal `<path>` children under `.vf-stavenote` with no VexFlow class, same as
            // the flag glyph and augmentation dots, so a naive "skip direct-child paths" rule
            // would leave those un-tinted too. Identified by their flat horizontal `d`.
            if (g) {
              const nheads = [...g.querySelectorAll('.vf-notehead')];
              [...g.children].forEach((el) => {
                if (el.tagName !== 'path' || nheads.some((nh) => nh.contains(el))) return;
                const m = (el.getAttribute('d') ?? '').match(/^M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)/);
                if (m && Math.abs(parseFloat(m[2]) - parseFloat(m[4])) < 0.01) el.classList.add('vf-ledger');
              });
            }
            // SETTLED — see memory `chord-stem-and-notehead-layout` before changing. The stem sits
            // exactly in the middle of the chord, touching the nearest notehead on both sides in
            // every direction (explicit user requirement, chosen over a smoother-but-off-center
            // alternative). UP's natural `getStemX()` already lands on the anchor/wing shared
            // boundary; DOWN is force-translated by `width` to reach that same point — stable for
            // a chord's whole lifetime, the only discontinuity is the single-note<->chord
            // transition itself (accepted tradeoff).
            // Notehead columns: exactly two (ANCHOR/WING), assigned by pitch-rank parity (index 0
            // = lowest = anchor; odd = wing, even = anchor) — not VexFlow's own alternation
            // (reshuffles on count change) and not a per-note staircase (doesn't match real
            // engraving). Adding a note above the highest never touches existing columns; adding
            // one below shifts every rank, so about half swap columns — a deliberate `width`-sized
            // notehead reflow, never the stem. Skipped for whole notes (their own `transform` from
            // `shrinkWholeNotehead` below doesn't compose with this yet).
            // Populated only for a displaced (2nd-or-closer) chord: the per-key hit-box x must
            // match the corrected position, not a fresh `getBBox()` (which excludes the element's
            // own transform — same quirk as `shrinkWholeNotehead`). `null` means no transform was
            // set, so a plain `getBBox()` read downstream is accurate.
            let perKeyTargets: { el: SVGGraphicsElement; x: number }[] | null = null;
            // stemXCorrection tracks any horizontal shift applied to the stem below, so the
            // interactive drag handle (which reads `getStemX()` directly) follows the drawn stem.
            let stemXCorrection = 0;
            if (d.notes[ni].kind === 'note' && d.notes[ni].keys.length >= 2 && d.notes[ni].duration !== 'w') {
              const noteheads = g ? [...g.querySelectorAll<SVGGraphicsElement>('.vf-notehead')] : [];
              // Only chords VexFlow itself flagged as displaced (2nds/unisons close enough to
              // collide) get corrected below — a WIDE chord (e.g. a 5th or octave) has every
              // notehead sitting at the same natural x already (no collision to resolve), and
              // forcing a second column there too would visibly and needlessly spread it apart.
              if (noteheads.length >= 2 && sn.getNoteHeadBounds().displaced_x !== undefined) {
                // ascending pitch = descending SVG y (higher pitch sits higher on the staff =
                // smaller y) — sorted[0] is always the lowest note.
                const sorted = [...noteheads].sort((a, b) => b.getBBox().y - a.getBBox().y);
                const rawBoxes = sorted.map((nh) => nh.getBBox()); // ALL raw, before any transform below
                const width = rawBoxes[0].width;
                // BOTH columns AND the stem are placed at direction-INDEPENDENT positions, so a
                // stem-direction FLIP moves nothing horizontally — only the stem's vertical extent
                // changes (explicit user requirement: "ничего не должно двигаться при смене
                // направления, только сам штиль вертикальное положение меняет"). Anchor them at the
                // DOWN-native stem x (`beginX` = `getNoteHeadBeginX()`, the onset position pinned by
                // the Gourlay layout, direction- and count-invariant): the RIGHT column is
                // `[beginX, beginX+width]`, the LEFT (wing) column `[beginX-width, beginX]`, and the
                // stem sits at their shared boundary `beginX` for BOTH directions. For DOWN that's
                // already native `getStemX()` (no move); for UP, native is `beginX+width`, so the
                // stem is translated by `-width` to the same `beginX`. Anchoring at the down-native
                // position (rather than up's) means the common case — a high, auto-down-stemmed
                // chord — is ALSO perfectly stable when notes are added (down single-note stem is
                // already `beginX`), which was the other hard requirement. (A low, up-stemmed chord
                // gets its stem drawn on the left of the anchor and shifts by `width` on its first
                // note-add — the unavoidable residue of making both flip- and add-stability hold at
                // once; see memory `chord-stem-and-notehead-layout` for why this tradeoff is forced.)
                const beginX = sn.getNoteHeadBeginX();
                const rightX = beginX;
                const leftX = beginX - width;
                // HIGHEST note always in the RIGHT column, alternating downward — the user's own
                // stated model ("самая высокая нота всегда справа; добавляем выше — старую в лево").
                // Assigned by rank FROM THE TOP so it's stable as the chord grows upward.
                const n = sorted.length;
                const targetX = (i: number) => (((n - 1 - i) % 2 === 0 ? rightX : leftX));
                const dxByIndex = sorted.map((_, i) => targetX(i) - rawBoxes[i].x);
                perKeyTargets = sorted.map((nh, i) => ({ el: nh, x: rawBoxes[i].x + dxByIndex[i] }));
                sorted.forEach((nh, i) => {
                  if (Math.abs(dxByIndex[i]) > 0.1) nh.setAttribute('transform', `translate(${dxByIndex[i]} 0)`);
                });
                // Pin the stem to `beginX` (the shared column boundary) for BOTH directions. DOWN's
                // native `getStemX()` is already `beginX` (no move); UP's is `beginX + width`, so
                // translate it left by `width`. This is what makes a flip move nothing horizontally.
                if (sn.getStemDirection() === Stem.UP) {
                  const stemG = g?.querySelector<SVGGraphicsElement>('.vf-stem');
                  stemG?.setAttribute('transform', `translate(${-width} 0)`);
                  stemXCorrection = -width;
                }
                // Ledger lines are plain sibling `<path>` elements next to `.vf-notehead` (see
                // `engravingScale.ts`'s own ledger lookup) — NOT children of any notehead, so moving
                // noteheads above doesn't move them, and VexFlow drew them from the ORIGINAL (raw)
                // note x's. Each ledger is a horizontal segment at one staff-line ROW; it must sit
                // centered under whichever of THIS chord's notes actually reach that row. Rather
                // than chase raw-x offsets (fragile — VexFlow only ever uses two raw columns, and a
                // multi-note row's anchor jumps between them), recentre each ledger directly onto
                // the mean of its qualifying notes' FINAL (target) centers: find the notes at this
                // row (raw y past the ledger's own y, on the away-from-staff side — decided against
                // the STAFF's fixed middle line, not the chord's centroid, so a row near the staff
                // under a fully-off-staff chord still resolves its direction correctly), average
                // their target column-centers, and translate the ledger so its own center lands
                // there. Keeps VexFlow's own single/double ledger WIDTH, only re-anchors it.
                if (g) {
                  const rawYs = rawBoxes.map((b) => b.y + b.height / 2);
                  const staffMidY = info.staff.getYForLine(2);
                  [...g.children].forEach((el) => {
                    if (el.tagName !== 'path' || sorted.some((nh) => nh.contains(el))) return;
                    const d2 = el.getAttribute('d') ?? '';
                    const m = d2.match(/^M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)/);
                    if (!m || Math.abs(parseFloat(m[2]) - parseFloat(m[4])) >= 0.01) return; // not a ledger line
                    const ledgerY = parseFloat(m[2]);
                    const oldCenter = (parseFloat(m[1]) + parseFloat(m[3])) / 2;
                    const above = ledgerY < staffMidY;
                    const qualifying = rawYs
                      .map((_, i) => i)
                      .filter((i) => (above ? rawYs[i] <= ledgerY + 2 : rawYs[i] >= ledgerY - 2));
                    if (!qualifying.length) return;
                    const desiredCenter =
                      qualifying.reduce((s, i) => s + targetX(i) + width / 2, 0) / qualifying.length;
                    const dx = desiredCenter - oldCenter;
                    if (Math.abs(dx) > 0.1) el.setAttribute('transform', `translate(${dx} 0)`);
                  });
                }
              }
            }
            if (d.notes[ni].kind === 'note' && d.notes[ni].duration === 'w') shrinkWholeNotehead(g);
            const voiceId = doc.voices[d.voiceIndex]?.id;
            if (voiceId) {
              g?.style.setProperty('--voice-color', resolveVoiceColor(voiceId, d.voiceIndex, voiceColors));
            }
            // hitbox = a tight box around the NOTEHEAD(S) only (never the stem). One box per
            // INDIVIDUAL note (a chord's several keys, tagged `data-individual-note-id`, each
            // click-selectable on its own) rather than one box spanning the whole chord — a real
            // requested feature: click a specific notehead to select just that note; fast
            // double-click (Overlay.tsx) expands to the whole chord via `carrierId`.
            const carrierId = d.notes[ni].id;
            const noteIdsForKeys = d.notes[ni].noteIds;
            if (g && d.notes[ni].kind === 'note' && noteIdsForKeys.length > 1) {
              const order = noteIdsForKeys
                .map((id, i) => ({ id, step: d.notes[ni].staffSteps[i] }))
                .sort((a, b) => a.step - b.step); // ascending pitch — matches perKeyTargets/notehead sort order
              const noteheadEls = perKeyTargets
                ? perKeyTargets.map((t) => t.el)
                : [...g.querySelectorAll<SVGGraphicsElement>('.vf-notehead')].sort(
                    (a, b) => b.getBBox().y - a.getBBox().y,
                  );
              // ascending-pitch order (index 0 = lowest = largest y) — same convention as `sorted`
              // above, so consecutive entries here are always immediate pitch-neighbors.
              const centers = noteheadEls.map((el) => {
                const b = el.getBBox();
                return b.y + b.height / 2;
              });
              order.forEach((o, i) => {
                const el = noteheadEls[i];
                if (!el) return;
                el.setAttribute('data-individual-note-id', o.id);
                const box = el.getBBox();
                const x = perKeyTargets ? perKeyTargets[i].x : box.x;
                const cy = centers[i];
                // Clamp the vertical extent to the midpoint with each pitch-neighbor — a
                // 2nd-interval chord's notes sit only ~5px apart, so a fixed pad made adjacent
                // boxes overlap and steal each other's clicks. At the chord's top/bottom (no
                // neighbor to split with) extend by half a notehead height, not the full
                // `HEAD_HALF` (~11px), which made the outermost note grabbable far past its glyph.
                const outerPad = box.height * 0.7;
                const topLimit = i + 1 < centers.length ? (cy + centers[i + 1]) / 2 : box.y - outerPad;
                const bottomLimit = i - 1 >= 0 ? (cy + centers[i - 1]) / 2 : box.y + box.height + outerPad;
                noteBoxes.push({
                  id: o.id,
                  carrierId,
                  staffId: d.staffId,
                  x: x - 6,
                  y: topLimit,
                  w: box.width + 12,
                  h: bottomLimit - topLimit,
                });
              });
            } else {
              // single note or rest — one box, id === its own single note id (or the carrier id
              // for a rest, which has no individual notes at all).
              const singleId = noteIdsForKeys[0] ?? carrierId;
              const el = g?.querySelector<SVGGraphicsElement>('.vf-notehead');
              el?.setAttribute('data-individual-note-id', singleId);
              const headX0 = sn.getNoteHeadBeginX();
              const headX1 = sn.getNoteHeadEndX();
              const ys = sn.getYs();
              const top = Math.min(...ys);
              const bottom = Math.max(...ys);
              noteBoxes.push({
                id: singleId,
                carrierId,
                staffId: d.staffId,
                x: headX0 - 7,
                y: top - HEAD_HALF,
                w: headX1 - headX0 + 14,
                h: bottom - top + HEAD_HALF * 2,
              });
            }
            // whole notes never have a stem at all (real engraving convention) — a whole-note
            // cross-staff chord stays two plain, unconnected noteheads; only STEMMED halves get
            // merged below.
            const crossStaffCarrierId =
              sn.hasStem() && b.crossStaffCarrierIds.has(d.notes[ni].id) ? d.notes[ni].id : null;
            if (crossStaffCarrierId) {
              // ONE stemHandle for the whole merged stem is pushed in the post-pass below (once
              // BOTH halves are drawn) — not here, and not per half: selection/drag/double-click
              // flip must work exactly like any other note's stem, through the exact same
              // `stemHandles`/`stemOverrides` mechanism, just with ONE handle for the whole chord
              // instead of one per physical staff.
              const arr = crossStaffHalves.get(crossStaffCarrierId) ?? [];
              arr.push({ sn, staffId: d.staffId });
              crossStaffHalves.set(crossStaffCarrierId, arr);
            } else if (sn.hasStem()) {
              const { topY, baseY } = sn.getStemExtents();
              stemHandles.push({
                noteId: d.notes[ni].id,
                staffId: d.staffId,
                x: sn.getStemX() + stemXCorrection,
                baseY,
                tipY: topY,
                direction: sn.getStemDirection() as 1 | -1,
              });
            }
          });
          d.notes.forEach((n, ni) => {
            if (n.tieToNext && d.sns[ni + 1]) {
              new StaveTie({
                first_note: d.sns[ni],
                last_note: d.sns[ni + 1],
                first_indices: [0],
                last_indices: [0],
              })
                .setContext(ctx)
                .draw();
            }
          });
        });

        // cross-staff chords: now that both halves are drawn (real pixel positions known), draw
        // ONE stem physically connecting them, protruding past its outer notehead and
        // selectable/draggable like any other stem — one `stemHandles` push below, driven by the
        // same `stemOverrides` a normal note uses (Overlay.tsx's drag code is untouched).
        //
        // `baseY` is ALWAYS the TOP half's own notehead position, never re-derived from the
        // override's direction — Overlay.tsx's drag captures `baseY` ONCE at pointer-down and
        // holds it fixed for the whole gesture, but a drag can flip `direction` mid-gesture; if
        // the anchor were picked FROM direction, that flip would relocate it to a different y,
        // desyncing the render from the drag's fixed reference (a note detaching from the stem
        // mid-air). Direction only controls which end gets the extra protrusion — the core span
        // (top note's y to bottom note's y) is drawn unconditionally, a hard geometry invariant.
        crossStaffHalves.forEach((halves, carrierId) => {
          if (halves.length < 2) return; // the other half didn't actually draw a stem this measure
          const ordered = [...halves].sort((a, c) => staffOrder.indexOf(a.staffId) - staffOrder.indexOf(c.staffId));
          const topHalf = ordered[0];
          const override = stemOverrides[carrierId];
          const direction: 1 | -1 = override?.direction ?? CROSS_STAFF_DEFAULT_DIRECTION;
          // Span the stem over every notehead's actual y (`getYs()`), not `getStemExtents()`:
          // its base/tip are direction-dependent (a stem-up half reports its base at its lowest
          // note, stem-down at its highest), so anchoring off it tore outer notes off the stem on
          // flip. Note y's are direction-invariant, so `topNoteY..botNoteY` always covers everything.
          const allNoteYs = ordered.flatMap((h) => h.sn.getYs());
          const topNoteY = Math.min(...allNoteYs);
          const botNoteY = Math.max(...allNoteYs);
          // Stem x = `getNoteHeadBeginX()`, the SAME anchor the chord notehead-column correction
          // (above) pins its two columns to — RIGHT column [beginX, beginX+width], LEFT column
          // [beginX-width, beginX], stem on their shared boundary `beginX`. It MUST match that
          // anchor, not `getStemX()`: for a chord with a SECOND, the column correction straddles
          // the noteheads around beginX, but `getStemX()` for an up stem is `beginX+width` (the
          // right edge), so using it drew the stem a whole notehead-width RIGHT of the straddled
          // cluster — disconnected (reported: "если на аккорде есть интервалы в секунду не должно
          // такого быть"). Pinning to beginX keeps the cross-staff stem CONSISTENT with the settled
          // single-staff chord behaviour ("ШТИЛЬ ПОСРЕДИНЕ АККОРДА, всегда, ноты по бокам" — stem in
          // the middle, notes straddling, nothing moves horizontally on a flip; see the memory
          // `chord-stem-and-notehead-layout`). Direction-invariant, so a flip only changes the
          // stem's vertical extent, never its x — same as a single-staff chord.
          const stemX = topHalf.sn.getNoteHeadBeginX();
          // drag reference `baseY` = the OUTER notehead on the stem's FREE side (bottom note for a
          // down stem, top note for an up stem) — the SAME thing a normal note's `getStemExtents().
          // baseY` is. This is what makes the stem-length clamp behave: with `baseY` at the outer
          // note, the drag's `length` (`|tip - baseY|`, see Overlay.tsx) IS the protrusion past that
          // note, so the global `MIN_STEM_LENGTH`/`MAX_STEM_LENGTH` become MIN/MAX PROTRUSION exactly
          // like a normal chord (measured: a normal chord clamps to a 20px min protrusion). Anchoring
          // `baseY` at the TOP note instead (an earlier version) measured `length` across the whole
          // inter-staff gap, so the 20px min was swallowed by the gap and the stem could be shortened
          // flush to the far note — the reported "нет минимальной длины штиля как у обычных аккордов".
          const baseY = direction === -1 ? botNoteY : topNoteY;
          // protrusion past `baseY` on the free side; a dragged length is that protrusion directly.
          const protrusion = override?.length ?? DEFAULT_STEM_PROTRUSION;
          const freeEndY = baseY - direction * protrusion; // down: botNoteY + P ; up: topNoteY - P
          // the drawn line always covers EVERY notehead [topNoteY, botNoteY] PLUS whatever the free
          // end adds beyond either side — never less than the full note span, in any direction.
          const lineTopY = Math.min(topNoteY, freeEndY);
          const lineBottomY = Math.max(botNoteY, freeEndY);
          ordered.forEach((h) => {
            h.sn.getSVGElement()?.querySelector('.vf-stem')?.remove();
          });
          // Appended as a DOM child of the TOP half's own `.vf-stavenote` group (not a bare
          // top-level shape) so the EXISTING selection/hover CSS
          // (`.vf-stavenote.selected path:not(.vf-ledger)`) tints it automatically, with zero new
          // styling rules — it's just another path alongside the noteheads/ledgers, exactly like a
          // real stem is.
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.setAttribute('d', `M${stemX} ${lineTopY}L${stemX} ${lineBottomY}`);
          line.setAttribute('stroke', inkColor);
          line.setAttribute('stroke-width', String(STEM_WIDTH));
          line.setAttribute('fill', 'none');
          line.setAttribute('class', 'vf-cross-staff-stem');
          topHalf.sn.getSVGElement()?.appendChild(line);
          // `tipY` (drag DOT + drag reference) = the DRAWN stem's free extremity, i.e. the end on
          // the free (protrusion) side: `lineBottomY` for a down stem, `lineTopY` for an up one.
          // NOT the raw `freeEndY`: on a SHORT drag `freeEndY` can fall SHORT of the far note, at
          // which point the drawn stem is clamped to the note (`lineBottomY = max(botNoteY,
          // freeEndY)`) to stay connected — but the dot must sit on the visible tip, not float in
          // the stem's interior at the un-clamped `freeEndY` (reported: "точка может оставаться не
          // на кончике штиля"). Using the clamped extremity keeps the dot on the tip AND makes the
          // next grab's drag reference match what's on screen. It is never the CONNECTED far end:
          // the free-side extremity is always the protruding tip, never the note the stem hangs off.
          const tipY = direction === -1 ? lineBottomY : lineTopY;
          // Overlay's hit-line spans [baseY-inset, tipY] for a normal note — always the whole
          // visible stem, since baseY and tipY are its two extremities. For a cross-staff stem the
          // drawn line is [lineTopY, lineBottomY] and baseY sits INSIDE it after a flip, so the
          // hit-line must be given the full drawn extent explicitly, or the core span between the
          // notes has no hit target and a grab there falls through to a marquee-select (which then
          // overwrites the chord's selection — the reported "сломан селект штиля").
          const hitY1 = lineTopY;
          const hitY2 = lineBottomY;
          // No custom `maxLength`: now that `length` is the protrusion past `baseY` (the outer
          // note), the GLOBAL `MIN_STEM_LENGTH`/`MAX_STEM_LENGTH` clamp applies unchanged — the drag
          // feel (min + max protrusion) is identical to an ordinary chord's, no per-stem override.
          stemHandles.push({ noteId: carrierId, staffId: topHalf.staffId, x: stemX, baseY, tipY, direction, hitY1, hitY2 });
        });

        // insert snapping / the ghost preview must land where notes are ACTUALLY drawn — not
        // re-derive that position: VexFlow silently adds its own internal stave-padding offset
        // the moment a note's `.stave` is set (see the noteStartX double-count fix above), which
        // a from-scratch `noteStartX + segX*stretch` reconstruction has no way to know about.
        // So read real notehead positions off the just-drawn notes for every onset that has one,
        // and only fall back to the formula — using whatever padding a real note in this same
        // measure revealed — for onsets with none (the end-of-measure boundary; a fully empty
        // staff).
        //
        // MUST key by `getNoteHeadBeginX()` (the LEFT edge), never `(begin+end)/2` (the notehead
        // CENTER): `sn.setXShift(...)` above aligns every note at a shared onset to the exact
        // SAME `getNoteHeadBeginX()` regardless of duration/width (the shift target never
        // references glyph width) — begin-X is the one thing guaranteed consistent across a
        // same-onset collision between differently-wide noteheads (e.g. an upper-staff 8th note
        // and a lower-staff whole note sharing beat 0: whole notes render ~5px wider than filled
        // noteheads, so their CENTERS differ even at an identical begin-X). `segments` is SHARED
        // across both staff zones (cross-staff alignment), and multiple staffs/voices can and do
        // share an onset — whichever note is recorded last here must not corrupt the position for
        // a different-width note at the same beat on the OTHER staff. Bug found via a real
        // reported mismatch: the ghost/click target for an 8th note was off by exactly
        // (wholeNoteWidth - filledNoteWidth) / 2 ≈ 2.57px — the bass staff's whole note (recorded
        // later in `b.drawn` = [treble, bass]) had overwritten the treble 8th note's realBeatX
        // entry with its own (wider) center.
        const realBeatX = new Map<number, number>();
        for (const d of b.drawn) {
          d.sns.forEach((sn, ni) => {
            realBeatX.set(d.onsets[ni], sn.getNoteHeadBeginX());
          });
        }
        const [sampleBeat, sampleX] = [...realBeatX.entries()][0] ?? [];
        // a fully empty measure (no real note on either staff — e.g. the FIRST insert ever
        // lands here) has nothing of its own to calibrate from; falling back to a bare 0 assumed
        // VexFlow's silent stave-padding offset away entirely, landing the ghost measurably too
        // far left. Fall back to `documentPadding` instead — the offset is a fixed VexFlow quirk,
        // not measure-specific data (see the comment above), so any other measure's real note in
        // this same render is a valid source.
        const padding =
          sampleBeat !== undefined
            ? sampleX - (noteStartX + (b.segmentX.get(sampleBeat) ?? 0) * stretch)
            : documentPadding;
        if (sampleBeat !== undefined) documentPadding = padding;
        // the LAST breakpoint (beat = measure end) is pinned to the true right edge (`x + w`),
        // not `noteStartX + cum*stretch` — `segmentX`'s cumulative value deliberately excludes
        // MEASURE_RIGHT_PAD (real notes must stop short of the barline), but that leaves the pad
        // region outside every breakpoint's domain, so `interp()` clamps ANY click that lands in
        // it onto the last valid beat — collapsing the last grid position onto (and beyond) half
        // the measure's clickable width instead of getting a fair, proportional share. Click
        // targeting must span the FULL visible measure, pad included.
        const rawSegments = [...b.segmentX.entries()]
          .sort(([beatA], [beatB]) => beatA - beatB)
          .map(([beat, segX]) => ({
            beat,
            x: realBeatX.get(beat) ?? noteStartX + segX * stretch + padding,
          }));
        const segments = rawSegments.map((p, i) =>
          i === rawSegments.length - 1 ? { ...p, x: x + w } : p,
        );
        // playback timeline: built from `segments` (the true MERGED cross-voice/cross-staff onset
        // timeline for this measure) rather than any one voice's own onsets — with more than one
        // real voice possibly sharing a staff now (cross-staff chords), no single "spine" voice is
        // guaranteed to carry every onset any more (e.g. a whole-note voice would report only 1
        // point for a measure where another voice has 4). `segments` already covers every real
        // onset across the whole measure, so this is strictly more complete than the old
        // one-voice-spine approach, not just an equivalent rewrite.
        const measureBeats = (beats * 4) / beatValue;
        segments.forEach((s) => timeMap.push({ timeBeats: cumBeat + s.beat, x: s.x }));
        cumBeat += measureBeats;
        staffZones.push(
          { measureId: b.measure.id, staffId: staffOrder[0], x0: zoneX0, x1: x + w, bottomLineY: staffBottomLineY(treble), stepPx, beats, beatValue, segments },
          { measureId: b.measure.id, staffId: staffOrder[1], x0: zoneX0, x1: x + w, bottomLineY: staffBottomLineY(bass), stepPx, beats, beatValue, segments },
        );

        barlines.push({ measureId: b.measure.id, x: x + w, y0: trebleY - 12, y1: bassY + STAFF_H + 12 });
        lastRightX = x + w;
      });

      if (sysStaffs.length) {
        const first = sysStaffs[0];
        const last = sysStaffs[sysStaffs.length - 1];
        new StaveConnector(first.treble, first.bass).setType('brace').setContext(ctx).draw();
        new StaveConnector(first.treble, first.bass).setType('singleLeft').setContext(ctx).draw();
        new StaveConnector(last.treble, last.bass).setType('singleRight').setContext(ctx).draw();
      }
    });

    timeMap.push({ timeBeats: cumBeat, x: lastRightX - 10 });

    onLayout({
      mode,
      width: totalW,
      height: totalH,
      timeMap,
      totalBeats: cumBeat,
      systemTop: MARGIN_T - 24,
      systemBottom: firstBassBottom + 24,
      noteBoxes,
      barlines,
      staffZones,
      stemHandles,
      measures,
    });
  }, [doc, mode, effectivePageContentWidth, onLayout, voiceColors, stemOverrides]);

  // selection = DOM recolour on the already-rendered SVG (CSS class), no re-layout. MUST also
  // re-run on every dep the MAIN draw effect rebuilds the DOM from (`voiceColors`, `stemOverrides`)
  // — that effect does `host.innerHTML = ''` and redraws from scratch, wiping every class
  // including `.selected`; if only ITS deps changed (this effect's deps didn't), React skips this
  // effect for that render and the freshly-rebuilt DOM is left with no selection styling at all.
  // Found via a real repro: dragging a stem handle (which updates `stemOverrides` on every
  // pointermove, `selectedIds` unchanged) silently cleared the visible selection highlight.
  // `selectedIds` holds INDIVIDUAL note ids (one per key — see `data-individual-note-id`, set in
  // the main draw effect above), not carrier ids: a chord's noteheads select one at a time.
  // `.selected` on each `.vf-notehead` tints just that notehead; `.selected` on the CARRIER group
  // (`[data-note-id]`, tints stem/ledgers too — see index.css) is a CARRIER-CONTEXT thing — the
  // stem belongs to the carrier, not to any one note — so it requires EVERY key selected AND
  // either a REAL chord (2+ keys, "every key" already implies a deliberate whole-chord pick) OR
  // this exact carrier having been picked at CARRIER granularity (`carrierSelectedIds` — set only
  // by the stem handle's own click/drag or a chord double-click, see app/store.ts). A single-note
  // carrier's stem must NEVER tint from a plain notehead click on its one note: that's a NOTE
  // selection (the note's own context is accidental/fingering, not the stem — see
  // PropertiesPanel's `isStemCarrier`), not a carrier selection — even though clicking/double-
  // clicking the STEM of that very carrier must still tint it (explicitly requested: "одиночную
  // ноту тоже нужно выделять как carrier по штилю/двойному клику"). An earlier version let a
  // single-note carrier's one key trivially satisfy "every key selected" via ANY click and tint
  // the stem — explicitly rejected by the user ("селект ноты все еще выделяет и стем, а не
  // должен... именно одиночной ноты, отдельные ноты в аккорде можно выделить" — individual notes
  // WITHIN a chord select fine, only the single-note case must never imply the stem from a plain
  // note click).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = new Set(selectedIds);
    const carrierSet = new Set(carrierSelectedIds);
    host.querySelectorAll<SVGElement>('[data-note-id]').forEach((g) => {
      const keyEls = [...g.querySelectorAll<SVGElement>('[data-individual-note-id]')];
      const carrierId = g.getAttribute('data-note-id') || '';
      const allSelected =
        keyEls.length > 0 &&
        keyEls.every((el) => set.has(el.getAttribute('data-individual-note-id') || '')) &&
        (keyEls.length > 1 || carrierSet.has(carrierId));
      g.classList.toggle('selected', allSelected);
      keyEls.forEach((el) => {
        el.classList.toggle('selected', set.has(el.getAttribute('data-individual-note-id') || ''));
      });
    });
  }, [selectionKey, carrierSelectionKey, doc, mode, voiceColors, stemOverrides]);

  // hover = same DOM-recolour pattern as selection (must re-run whenever the main effect could
  // have rebuilt the DOM) — a light tint on the note glyph itself, per-individual-note like
  // `.selected` above (Overlay.tsx's stem hover separately tints the whole chord). `hoveredNoteIds`
  // is lifted UI state in EditorView.tsx, not the global store — too ephemeral to belong there.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = new Set(hoveredNoteIds);
    host.querySelectorAll<SVGElement>('[data-individual-note-id]').forEach((el) => {
      el.classList.toggle('hovered', set.has(el.getAttribute('data-individual-note-id') || ''));
    });
  }, [hoverKey, doc, mode, voiceColors, stemOverrides]);

  return <div ref={hostRef} />;
}

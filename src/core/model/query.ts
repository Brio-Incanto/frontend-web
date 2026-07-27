import type { Item, NoteRef, ScoreDocument } from './score';

/** An item's own individually-selectable ids — its chord's several note ids, or (a rest) its
 *  own carrier id as a single-element fallback. Every group-select helper below (`selectedIds`
 *  is always individual-note-id-granularity, see Overlay.tsx) flattens through this so a chord
 *  inside a selected voice/staff/measure highlights ALL its notes, not nothing. */
function itemNoteIds(item: Item): string[] {
  return item.notes.length ? item.notes.map((n) => n.noteId) : [item.id];
}

export interface NoteLocation {
  measureId: string;
  staffId: string;
  voiceId: string;
}

/** Which measure/staff/voice a note lives in. Accepts EITHER an individual note id (resolves to
 *  that note's own staff — unambiguous) OR a carrier id (a cross-staff chord makes this
 *  ambiguous: falls back to its FIRST note's staff — callers that need an exact staff should
 *  pass the individual note id instead, e.g. a `NoteBox.id`, not its `carrierId`). */
export function locate(doc: ScoreDocument, id: string): NoteLocation | null {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      for (const item of v.items) {
        if (item.kind === 'rest') {
          if (item.id === id && item.staffId) return { measureId: m.id, staffId: item.staffId, voiceId: v.id };
          continue;
        }
        const n = item.notes.find((x) => x.noteId === id);
        if (n) return { measureId: m.id, staffId: n.staffId, voiceId: v.id };
        if (item.id === id && item.notes[0]) {
          return { measureId: m.id, staffId: item.notes[0].staffId, voiceId: v.id };
        }
      }
    }
  }
  return null;
}

/** All individually-selectable note ids belonging to one carrier (a chord's several keys,
 *  possibly across DIFFERENT staves, or a single note's own one id) — used to expand a fast
 *  double-click on one notehead into "select the whole chord," including any cross-staff
 *  partner notes. Falls back to the carrier id itself (a rest, or a lookup miss). */
export function chordNoteIds(doc: ScoreDocument, carrierId: string): string[] {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      const item = v.items.find((x) => x.id === carrierId);
      if (item) return itemNoteIds(item);
    }
  }
  return [carrierId];
}

/** The carrier a given id belongs to — accepts EITHER a carrier id (returned as-is) or an
 *  individual note id (resolved to its owning carrier). Used wherever an operation is only
 *  defined at carrier granularity (e.g. delete) but `selectedIds` may hold individual note ids. */
export function carrierIdOf(doc: ScoreDocument, id: string): string {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      for (const item of v.items) {
        if (item.id === id || item.notes.some((n) => n.noteId === id)) return item.id;
      }
    }
  }
  return id;
}

/** The full item (chord/rest) a carrier id belongs to — for callers that need its `notes` list
 *  itself, not just derived id sets (e.g. within-chord note-to-note navigation). */
export function itemOf(doc: ScoreDocument, carrierId: string): Item | null {
  for (const m of doc.measures) {
    for (const v of m.voices) {
      const item = v.items.find((x) => x.id === carrierId);
      if (item) return item;
    }
  }
  return null;
}

/** A chord's own note ids, ordered bottom-to-top PHYSICALLY (screen position), not by pitch —
 *  pitch/spelling isn't implemented (`staff_step` carried as-is, see backend CLAUDE.md), so this
 *  is the only "low to high" the client can compute. `staffStep` (0 = that staff's bottom line,
 *  increasing = higher) is only comparable WITHIN one staff — a cross-staff chord's two halves
 *  live in different physical coordinate systems, so staves are ordered first (by `doc.staffOrder`,
 *  top-to-bottom; a note on a LOWER staff always sorts below one on a HIGHER staff, regardless of
 *  its own `staffStep`), and `staffStep` only breaks ties within the same staff. */
export function physicalNoteOrder(doc: ScoreDocument, item: Item): string[] {
  return [...item.notes]
    .sort((a, b) => {
      const ai = doc.staffOrder.indexOf(a.staffId);
      const bi = doc.staffOrder.indexOf(b.staffId);
      if (ai !== bi) return bi - ai; // higher staffOrder index = lower staff = sorts first (lowest)
      return a.staffStep - b.staffStep; // ascending staffStep = low to high within one staff
    })
    .map((n) => n.noteId);
}

/** Every individually-selectable note id of one voice within one measure, across ALL the
 *  staves that voice touches there (voice is the real axis — a cross-staff chord's partner
 *  notes belong to the same "whole voice in this measure" group even though they render on a
 *  different staff). */
export function voiceNoteIds(doc: ScoreDocument, measureId: string, voiceId: string): string[] {
  const v = doc.measures.find((m) => m.id === measureId)?.voices.find((x) => x.id === voiceId);
  return v ? v.items.flatMap(itemNoteIds) : [];
}

/** Every individually-selectable note id landing on one staff within one measure, across all
 *  voices — a chord note only counts if ITS OWN staff matches (a cross-staff chord contributes
 *  only its notes on this staff, not its partner notes on the other staff). */
export function staffNoteIds(doc: ScoreDocument, measureId: string, staffId: string): string[] {
  const m = doc.measures.find((x) => x.id === measureId);
  if (!m) return [];
  const ids: string[] = [];
  for (const v of m.voices) {
    for (const item of v.items) {
      if (item.kind === 'rest') {
        if (item.staffId === staffId) ids.push(item.id);
        continue;
      }
      ids.push(...item.notes.filter((n) => n.staffId === staffId).map((n) => n.noteId));
    }
  }
  return ids;
}

/** Every individually-selectable note id of a global voice, across all staffs and measures.
 *  Voices are global (a voice spans staffs), so we match by voice id, not a per-staff index. */
export function voiceCarrierIds(doc: ScoreDocument, voiceId: string): string[] {
  const ids: string[] = [];
  for (const m of doc.measures) {
    const v = m.voices.find((x) => x.id === voiceId);
    if (v) ids.push(...v.items.flatMap(itemNoteIds));
  }
  return ids;
}

/** One entry PER CARRIER (chord/rest, `item.id` — not exploded to individual note ids like
 *  `voiceCarrierIds`) of a global voice, in document order across measures. Used for arrow-key
 *  carrier-to-carrier navigation: a measure the voice has nothing in simply contributes no id, so
 *  a multi-measure gap in that voice is skipped over for free — no separate "find next" search. */
export function orderedVoiceCarrierIds(doc: ScoreDocument, voiceId: string): string[] {
  const ids: string[] = [];
  for (const m of doc.measures) {
    const v = m.voices.find((x) => x.id === voiceId);
    if (v) ids.push(...v.items.map((item) => item.id));
  }
  return ids;
}

export function measureNoteIds(doc: ScoreDocument, measureId: string): string[] {
  const m = doc.measures.find((x) => x.id === measureId);
  return m ? m.voices.flatMap((v) => v.items.flatMap(itemNoteIds)) : [];
}

/** One carrier (chord/rest) touched by the current selection, with which of its notes are picked. */
export interface SelectedCarrier {
  item: Item;
  measureId: string;
  voiceId: string;
  /** the selected individual note refs of THIS carrier (empty for a rest). */
  notes: NoteRef[];
  /** true when every one of the carrier's notes is selected (or it's a rest, selected as a whole). */
  whole: boolean;
}

/** Structured view of `selectedIds` (which hold individual note ids, plus a rest's own carrier id)
 *  for the contextual properties panel: the distinct carriers touched, and per-carrier which notes.
 *  Ordered by document position (measure, then voice, then item) for a stable panel. */
export interface SelectionInfo {
  carriers: SelectedCarrier[];
  /** count of individually-selected notes across all chords. */
  noteCount: number;
  /** count of selected rests. */
  restCount: number;
}

export function describeSelection(doc: ScoreDocument, selectedIds: string[]): SelectionInfo {
  const ids = new Set(selectedIds);
  const carriers: SelectedCarrier[] = [];
  let noteCount = 0;
  let restCount = 0;
  for (const m of doc.measures) {
    for (const v of m.voices) {
      for (const item of v.items) {
        if (item.kind === 'rest') {
          if (ids.has(item.id)) {
            carriers.push({ item, measureId: m.id, voiceId: v.id, notes: [], whole: true });
            restCount += 1;
          }
          continue;
        }
        const picked = item.notes.filter((n) => ids.has(n.noteId));
        if (picked.length) {
          carriers.push({
            item,
            measureId: m.id,
            voiceId: v.id,
            notes: picked,
            whole: picked.length === item.notes.length,
          });
          noteCount += picked.length;
        }
      }
    }
  }
  return { carriers, noteCount, restCount };
}

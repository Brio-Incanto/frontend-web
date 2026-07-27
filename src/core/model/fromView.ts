// Maps the backend render view (see PianoAppBackend `view.py` / `serialize_view`) into the
// client model. The two are now the SAME shape by design — the backend already lays out the
// graph by the VOICE timeline (measures -> voices -> items) with STAFF as a per-note attribute
// (a carrier's notes each carry their own `staff_id`, so one carrier may natively span more than
// one staff — a cross-staff chord). This file therefore only translates field-level encodings
// (numeric duration -> code, string accidental -> symbol) — it does NOT restructure the graph.
// Staff-major grouping is a RENDERING concern only, derived locally by VexflowRenderer.tsx.

import type { Accidental, DurationValue, Item, Measure, NoteRef, ScoreDocument, VoiceMeasure } from '@/core/model/score';

interface ViewNote {
  note_id: string;
  staff_id: string;
  staff_step: number;
  accidental: string;
}
interface ViewItem {
  carrier_id: string;
  kind: 'note' | 'rest';
  position: { numerator: number; denominator: number };
  duration: { value: number; dots: number };
  notes: ViewNote[];
  /** rests only — a rest lives on a single staff (no per-note entries). */
  staff_id?: string;
  staff_step?: number;
}
interface ViewVoice {
  voice_id: string;
  items: ViewItem[];
}
interface ViewMeasure {
  id: string;
  time_signature: { beats: number; beat_value: number };
  voices: ViewVoice[];
}
export interface ScoreView {
  score_id: string;
  staff_order: string[];
  voices: string[];
  measures: ViewMeasure[];
}

const DURATION: Record<number, DurationValue> = {
  1: 'w',
  2: 'h',
  4: 'q',
  8: '8',
  16: '16',
  32: '32',
};

function toAccidental(a: string): Accidental {
  if (a === 'sharp') return '#';
  if (a === 'flat') return 'b';
  if (a === 'natural') return 'n';
  return null;
}

function toNoteRef(n: ViewNote): NoteRef {
  return { noteId: n.note_id, staffId: n.staff_id, staffStep: n.staff_step, accidental: toAccidental(n.accidental) };
}

function toItem(v: ViewItem): Item {
  return {
    id: v.carrier_id,
    kind: v.kind,
    duration: DURATION[v.duration.value] ?? 'q',
    dots: v.duration.dots,
    notes: v.kind === 'note' ? v.notes.map(toNoteRef) : [],
    staffId: v.kind === 'rest' ? v.staff_id : undefined,
    staffStep: v.kind === 'rest' ? v.staff_step : undefined,
  };
}

function toVoiceMeasure(v: ViewVoice): VoiceMeasure {
  return { id: v.voice_id, items: v.items.map(toItem) };
}

function toMeasure(m: ViewMeasure): Measure {
  return {
    id: m.id,
    timeSignature: { beats: m.time_signature.beats, beatValue: m.time_signature.beat_value },
    voices: m.voices.map(toVoiceMeasure),
  };
}

export function fromView(view: ScoreView): ScoreDocument {
  return {
    id: view.score_id,
    title: 'Untitled',
    staffOrder: view.staff_order,
    voices: view.voices.map((id, index) => ({ id, index })),
    measures: view.measures.map(toMeasure),
  };
}

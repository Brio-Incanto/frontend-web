// Maps the backend's flat entity dump (PianoAppBackend
// `application/use_cases/score/view.py` — `ScoreEditView.jsonify`) into the client model.
// The backend sends the raw document graph, normalized by id (staffs, measures, voices,
// rhythmic_containers, carriers, items, relations) rather than a pre-grouped render tree —
// this file does the measure/voice grouping and position ordering the backend used to do.

import type { Accidental, DurationValue, Item, Measure, NoteRef, ScoreDocument, VoiceMeasure } from '@/core/model/score';

interface ViewStaff {
  id: string;
}
interface ViewMeasure {
  id: string;
  time_signature: { count: number; value: number; dots: number };
}
interface ViewVoice {
  id: string;
  rhythmic_container_ids: string[];
}
interface ViewRhythmicSize {
  count: number;
  value: number;
  dots: number;
}
interface ViewFraction {
  numerator: number;
  denominator: number;
}
interface ViewGroupContainer {
  id: string;
  kind: 'group';
  written_size: ViewRhythmicSize;
  occupied_size: ViewRhythmicSize;
  child_ids: string[];
}
interface ViewLeafContainer {
  id: string;
  kind: 'leaf';
  written_size: ViewRhythmicSize;
  occupied_size: ViewRhythmicSize;
  measure_id: string;
  position: ViewFraction;
  carrier_id: string;
}
type ViewRhythmicContainer = ViewGroupContainer | ViewLeafContainer;
interface ViewChordCarrier {
  id: string;
  kind: 'chord';
  articulation: string;
  note_ids: string[];
}
interface ViewRestCarrier {
  id: string;
  kind: 'rest';
  rest_id: string;
}
type ViewCarrier = ViewChordCarrier | ViewRestCarrier;
interface ViewNoteItem {
  id: string;
  kind: 'note';
  staff_id: string;
  staff_step: number;
  accidental: string;
  fingering: number;
}
interface ViewRestItem {
  id: string;
  kind: 'rest';
  staff_id: string;
  staff_step: number;
}
type ViewMusicalItem = ViewNoteItem | ViewRestItem;

export interface ScoreView {
  staffs: ViewStaff[];
  measures: ViewMeasure[];
  voices: ViewVoice[];
  rhythmic_containers: ViewRhythmicContainer[];
  carriers: ViewCarrier[];
  items: ViewMusicalItem[];
  relations: unknown[];
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

function positionValue(p: ViewFraction): number {
  return p.numerator / p.denominator;
}

// measure_id + voice_id -> a stable, order-independent lookup key.
function bucketKey(measureId: string, voiceId: string): string {
  return `${measureId}\0${voiceId}`;
}

export function fromView(view: ScoreView, scoreId: string): ScoreDocument {
  const containerById = new Map(view.rhythmic_containers.map((c) => [c.id, c]));
  const carrierById = new Map(view.carriers.map((c) => [c.id, c]));
  const itemById = new Map(view.items.map((i) => [i.id, i]));

  // A voice only lists its TOP-LEVEL container ids -> descend groups to reach every leaf.
  const voiceOfLeaf = new Map<string, string>();
  const collectLeaves = (containerId: string, voiceId: string): void => {
    const container = containerById.get(containerId);
    if (!container) return;
    if (container.kind === 'group') {
      for (const childId of container.child_ids) collectLeaves(childId, voiceId);
    } else {
      voiceOfLeaf.set(container.id, voiceId);
    }
  };
  for (const voice of view.voices) {
    for (const containerId of voice.rhythmic_container_ids) collectLeaves(containerId, voice.id);
  }

  const leavesByBucket = new Map<string, ViewLeafContainer[]>();
  for (const container of view.rhythmic_containers) {
    if (container.kind !== 'leaf') continue;
    const voiceId = voiceOfLeaf.get(container.id);
    if (!voiceId) continue;
    const key = bucketKey(container.measure_id, voiceId);
    const bucket = leavesByBucket.get(key);
    if (bucket) bucket.push(container);
    else leavesByBucket.set(key, [container]);
  }

  function toNoteRef(noteId: string): NoteRef {
    const note = itemById.get(noteId);
    if (!note || note.kind !== 'note') throw new Error(`Missing note item ${noteId}`);
    return { noteId: note.id, staffId: note.staff_id, staffStep: note.staff_step, accidental: toAccidental(note.accidental) };
  }

  function toItem(leaf: ViewLeafContainer): Item {
    const carrier = carrierById.get(leaf.carrier_id);
    if (!carrier) throw new Error(`Missing carrier ${leaf.carrier_id}`);
    const base = {
      id: carrier.id,
      duration: DURATION[leaf.written_size.value] ?? 'q',
      dots: leaf.written_size.dots,
    };
    if (carrier.kind === 'chord') {
      return { ...base, kind: 'note', notes: carrier.note_ids.map(toNoteRef) };
    }
    const rest = itemById.get(carrier.rest_id);
    if (!rest) throw new Error(`Missing rest item ${carrier.rest_id}`);
    return { ...base, kind: 'rest', notes: [], staffId: rest.staff_id, staffStep: rest.staff_step };
  }

  function toVoiceMeasure(voiceId: string, measureId: string): VoiceMeasure {
    const leaves = leavesByBucket.get(bucketKey(measureId, voiceId)) ?? [];
    const items = [...leaves].sort((a, b) => positionValue(a.position) - positionValue(b.position)).map(toItem);
    return { id: voiceId, items };
  }

  function toMeasure(m: ViewMeasure): Measure {
    return {
      id: m.id,
      timeSignature: { beats: m.time_signature.count, beatValue: m.time_signature.value },
      voices: view.voices.map((v) => toVoiceMeasure(v.id, m.id)),
    };
  }

  return {
    id: scoreId,
    title: 'Untitled',
    staffOrder: view.staffs.map((s) => s.id),
    voices: view.voices.map((v, index) => ({ id: v.id, index })),
    measures: view.measures.map(toMeasure),
  };
}

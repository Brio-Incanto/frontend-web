// Client-side render/edit model. This is the transient document the editor owns
// (branch or draft). Shaped to mirror the BACKEND's domain truth directly: voice and
// staff are independent axes (see PianoAppBackend CLAUDE.md / the `staff-voice-independent-axes`
// design note) — a measure holds VOICES, and staff is a per-note attribute, never a level
// of the document hierarchy. The backend sends a flat, normalized entity dump (not this
// shape) — fromView.ts resolves it into `measures -> voices -> items` with staff on each
// note. Only the VexFlow renderer (which must place glyphs on physical staves) derives a
// per-staff view, locally, at draw time.

export type Clef = 'treble' | 'bass';
export type StaffId = string;

export type DurationValue = 'w' | 'h' | 'q' | '8' | '16' | '32';
export type Accidental = '#' | 'b' | 'n' | '##' | 'bb' | null;

/** One note of a chord (or the chord's only note) — carries its OWN staff, so a chord (one
 *  `Item`) can natively span more than one staff (a cross-staff chord: e.g. voice 1 holding a
 *  note on the treble staff and one on the bass staff at the same beat, in one carrier). */
export interface NoteRef {
  noteId: string;
  staffId: StaffId;
  staffStep: number;
  accidental: Accidental;
}

/** A rhythmic item on one voice's timeline — a chord/single-note carrier, or a rest. */
export interface Item {
  /** The carrier id — the chord/rest as a WHOLE (delete-carrier, stem handle, group-select all
   *  key off this). Individual-note selection uses `notes[].noteId` instead. */
  id: string;
  kind: 'note' | 'rest';
  duration: DurationValue;
  dots: number;
  /** One entry per note in the chord — possibly on DIFFERENT staffs. Empty for a rest. */
  notes: NoteRef[];
  /** Rests only — a rest lives on exactly one staff (no per-note list). */
  staffId?: StaffId;
  staffStep?: number;
  /** Tie from this item into the next in the same voice. */
  tieToNext?: boolean;
}

export interface VoiceMeasure {
  id: string;
  items: Item[];
}

export interface Measure {
  id: string;
  timeSignature: { beats: number; beatValue: number };
  voices: VoiceMeasure[];
}

/** A global voice (spans staffs). Voice color is keyed by `index`. */
export interface VoiceRef {
  id: string;
  index: number;
}

export interface ScoreDocument {
  id: string;
  title: string;
  /** Top-to-bottom staff order, e.g. ['rh', 'lh']. Staves exist as a rendering/insertion
   *  surface (`staffOrder`, click geometry) — they are not a level of the document tree. */
  staffOrder: StaffId[];
  /** Global voices in document order (backend truth), for panels + voice selection. */
  voices: VoiceRef[];
  measures: Measure[];
}

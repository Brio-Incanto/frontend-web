// The intent of an edit — the boundary to the backend mutation engine. The gateway
// ships each command to `/scores/{id}/edit/...` and returns the resulting document.

export type Command =
  | {
      type: 'insertNote';
      measureId: string;
      staffId: string;
      voiceId: string;
      /** position within the measure, in whole-note units (whole = 1/1). */
      position: { numerator: number; denominator: number };
      /** rhythmic value: `value` is the note denominator (1,2,4,8,16,32). */
      writtenValue: { value: number; dots: number };
      /** clef-independent staff geometry: 0 = the staff's bottom line, +1 per step up. */
      staffStep: number;
      accidental?: string;
    }
  /** mixed multi-select delete — whole carriers AND individual notes-out-of-chords — all removed
   *  in ONE backend gesture (one transaction, one undo entry). This is what makes a single Delete
   *  over any selection a single undo step, instead of one gesture for the carriers plus one per
   *  leftover note. `entityIds` is a FLAT list of ids of any deletable kind — the backend resolves
   *  each id to its entity (note / note-carrier / rest-carrier) and classifies it (see the backend
   *  `DeleteBatchCommand.entity_ids` / `compile_delete_batch`), so the client sends a carrier id to
   *  drop a whole chord and individual note ids to drop notes out of a chord, in one array. */
  | { type: 'deleteBatch'; entityIds: string[] };

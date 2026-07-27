import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useEditor } from '@/app/store';
import { springSnappy } from '@/styles/motion';
import type { Accidental, ScoreDocument } from '@/core/model/score';
import { describeSelection, type SelectedCarrier } from '@/core/model/query';
import { staffStepToKey } from '@/core/model/pitch';

// The right panel is a CONTEXTUAL-ACTIONS panel: it inspects the current selection and shows the
// info + actions relevant to whatever is selected (a single note, a whole chord, a rest, or a mixed
// multi-selection). Only actions that exist end-to-end today are wired: Delete (backend) and stem
// direction (client-only override, see app/store `stemOverrides`). Note-attribute edits the vision
// also calls for — accidental, fingering, chord accent/articulation — need backend mutations that
// don't exist yet, so they are intentionally NOT shown as dead buttons; they slot into the same
// per-selection structure once the engine grows those gestures.

function clefOf(doc: ScoreDocument, staffId: string): 'treble' | 'bass' {
  return doc.staffOrder.indexOf(staffId) === 0 ? 'treble' : 'bass';
}

const ACCIDENTAL_LABEL: Record<NonNullable<Accidental>, string> = {
  '#': '♯',
  b: '♭',
  n: '♮',
  '##': '𝄪',
  bb: '𝄫',
};

function accidentalLabel(a: Accidental): string {
  return a ? ACCIDENTAL_LABEL[a] : '—';
}

function durationLabel(duration: string, dots: number): string {
  return duration + '.'.repeat(dots);
}

/** The stem is a CARRIER-level property (one stem shared by all of a chord's notes), so stem
 *  controls belong to the CARRIER context only. A real chord (2+ notes) selected AS A WHOLE
 *  always qualifies. A single-note carrier only qualifies when it was picked at CARRIER
 *  granularity — via the stem handle itself or a chord double-click, tracked in
 *  `carrierSelectedIds` (app/store.ts) — NOT from a plain notehead click on that same lone note,
 *  which is a NOTE selection (context: accidental / fingering, todo — need backend), not a
 *  carrier one. */
function isStemCarrier(c: SelectedCarrier, carrierSelectedIds: string[]): boolean {
  return (
    c.item.kind === 'note' &&
    c.whole &&
    c.item.duration !== 'w' &&
    (c.item.notes.length > 1 || carrierSelectedIds.includes(c.item.id))
  );
}

export function PropertiesPanel() {
  const document = useEditor((s) => s.document);
  const selectedIds = useEditor((s) => s.selectedIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const setStemOverride = useEditor((s) => s.setStemOverride);

  // DESIGN.md §3.5 Apple-style motion: opacity+transform only, `--ease-standard`
  // (`cubic-bezier(0.2,0,0,1)`) — the panel's content used to hard-swap (empty <-> note <-> chord
  // <-> ...) with no transition at all. One shared AnimatePresence (below, in the final return)
  // keyed on the coarse "what kind of thing is this" signature crossfades between them instead of
  // popping — both branches must render under the SAME AnimatePresence instance for that to work
  // across the empty <-> non-empty boundary, so the body is built as (key, content) here and
  // rendered once at the bottom, rather than two separate early-return `<aside>` trees.
  let panelKey: string;
  let body: ReactNode;

  if (selectedIds.length === 0) {
    panelKey = 'empty';
    body = (
      <>
        <h3>Properties</h3>
        <div className="empty">
          Select an element to see its details and actions. Shift-click to add to the selection;
          Esc clears.
        </div>
      </>
    );
  } else {
    const sel = describeSelection(document, selectedIds);
    const { carriers, noteCount, restCount } = sel;

    // What is selected, at a glance — drives the header + which detail rows to show.
    const singleCarrier = carriers.length === 1 ? carriers[0] : null;
    const isSingleNote = noteCount === 1 && restCount === 0 && carriers.length === 1;
    const isWholeChord =
      singleCarrier != null &&
      singleCarrier.item.kind === 'note' &&
      singleCarrier.whole &&
      singleCarrier.item.notes.length > 1;
    const isSingleRest = restCount === 1 && noteCount === 0 && carriers.length === 1;

    let heading: string;
    if (isSingleRest) heading = 'Rest';
    else if (isWholeChord) heading = `Chord · ${singleCarrier!.item.notes.length} notes`;
    else if (isSingleNote) heading = 'Note';
    else heading = `Selection · ${noteCount + restCount}`;
    // the animation key is the COARSE kind, not the exact heading (e.g. not the chord's note
    // count) — switching from a 2-note chord to a 3-note chord re-renders in place, only a real
    // kind change (note -> chord, chord -> rest, ...) crossfades.
    panelKey = isSingleRest ? 'rest' : isWholeChord ? 'chord' : isSingleNote ? 'note' : 'mixed';

    // Stem direction acts on every carrier-context (whole chord) in the selection — never a single
    // note. The active chip lights only when ALL of them agree, so a mixed set shows no active state.
    const stemmable = carriers.filter((c) => isStemCarrier(c, carrierSelectedIds));
    // `stemOverrides` is a partial map at runtime (absent = automatic), but its Record type reads
    // as always-present, so annotate the "auto" fallback explicitly to keep 0 in the union.
    const stemDirOf = (id: string): 1 | -1 | 0 => (stemOverrides[id]?.direction ?? 0) as 1 | -1 | 0;
    const stemDirs = new Set(stemmable.map((c) => stemDirOf(c.item.id)));
    const commonStemDir = stemDirs.size === 1 ? [...stemDirs][0] : null; // 1 up, -1 down, 0 auto, null mixed
    const setStemDir = (dir: 1 | -1 | null) =>
      stemmable.forEach((c) => setStemOverride(c.item.id, dir === null ? null : { direction: dir, length: null }));

    const deleteLabel = isSingleRest
      ? 'Delete rest'
      : isWholeChord
        ? 'Delete chord'
        : isSingleNote
          ? 'Delete note'
          : `Delete ${noteCount + restCount}`;

    body = (
      <>
        <h3>{heading}</h3>

        {/* ---- contextual detail ---- */}
        {isSingleNote && singleCarrier && (
          <>
            <Row label="Pitch" value={staffStepToKey(singleCarrier.notes[0].staffStep, clefOf(document, singleCarrier.notes[0].staffId))} />
            <Row label="Accidental" value={accidentalLabel(singleCarrier.notes[0].accidental)} />
            <Row label="Duration" value={durationLabel(singleCarrier.item.duration, singleCarrier.item.dots)} />
          </>
        )}
        {isWholeChord && singleCarrier && (
          <>
            <Row
              label="Pitches"
              value={singleCarrier.item.notes
                .map((n) => staffStepToKey(n.staffStep, clefOf(document, n.staffId)))
                .join(', ')}
            />
            <Row label="Duration" value={durationLabel(singleCarrier.item.duration, singleCarrier.item.dots)} />
          </>
        )}
        {isSingleRest && singleCarrier && (
          <Row label="Duration" value={durationLabel(singleCarrier.item.duration, singleCarrier.item.dots)} />
        )}
        {!singleCarrier && (
          <>
            {noteCount > 0 && <Row label="Notes" value={String(noteCount)} />}
            {restCount > 0 && <Row label="Rests" value={String(restCount)} />}
            <Row label="Carriers" value={String(carriers.length)} />
          </>
        )}

        {/* ---- stem direction (client-side) ---- */}
        {stemmable.length > 0 && (
          <div className="props-section">
            <div className="props-section-label">Stem</div>
            <div className="props-chip-row">
              <button
                className={'chip' + (commonStemDir === 0 ? ' active' : '')}
                onClick={() => setStemDir(null)}
                title="Automatic direction"
              >
                Auto
              </button>
              <button
                className={'chip' + (commonStemDir === 1 ? ' active' : '')}
                onClick={() => setStemDir(1)}
                title="Stem up"
              >
                Up
              </button>
              <button
                className={'chip' + (commonStemDir === -1 ? ' active' : '')}
                onClick={() => setStemDir(-1)}
                title="Stem down"
              >
                Down
              </button>
            </div>
          </div>
        )}

        {/* ---- destructive ---- */}
        <div className="props-section">
          <button className="icon-btn danger props-delete" onClick={() => void deleteSelected()}>
            {deleteLabel}
          </button>
        </div>
      </>
    );
  }

  return (
    <aside className="props">
      {/* DESIGN.md §3.5 (unified spring model): the panel's content swap is a small, direct
          response to a selection change, so it uses `springSnappy` (the small-controls preset) —
          honest spring motion, no faked-impulse bezier. AnimatePresence gives it the enter/exit
          lifecycle; the spring makes the slide+fade feel physical and interruptible. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={panelKey}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={springSnappy}
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span>{label}</span>
      <b>{value || '—'}</b>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { useEditor, hotbarSlotKey, HOTBAR_SLOT_COUNT } from '@/app/store';
import { LeftPanel } from '@/features/editor/LeftPanel';
import { Toolbar } from '@/features/editor/Toolbar';
import { EditorView } from '@/features/editor/EditorView';
import { PropertiesPanel } from '@/features/editor/PropertiesPanel';
import { PlaybackBar } from '@/features/playback/PlaybackBar';
import { SegmentedControl } from '@/features/editor/SegmentedControl';
import {
  locate,
  carrierIdOf,
  itemOf,
  chordNoteIds,
  orderedVoiceCarrierIds,
  physicalNoteOrder,
} from '@/core/model/query';

const CANVAS_MODE_OPTIONS = [
  { value: 'line' as const, label: 'Line' },
  { value: 'page' as const, label: 'Page' },
];

/** Arrow-key navigation's in-progress Shift-range state (App.tsx's keydown handler). `scopeId` is
 *  the carrier id (note-mode) or voice id (carrier-mode) the range is confined to — carried
 *  through only to identify the scope, nothing reads it back apart from re-threading it. `ids` is
 *  the ordered id list it's ranging over (a chord's own notes, or a voice's carriers); `anchorId`/
 *  `cursorId` are the range's fixed/moving ends; `appliedIds` is exactly what we last set
 *  `selectedIds` to, so the NEXT Shift+Arrow can tell whether the store's selection still matches
 *  what we produced, or something else changed it in between (e.g. a mouse click) — in which case
 *  the range restarts fresh instead of extending a now-stale anchor. */
interface NavRange {
  kind: 'note' | 'carrier';
  scopeId: string;
  anchorId: string;
  cursorId: string;
  ids: string[];
  appliedIds: string[];
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      {locked ? <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /> : <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />}
    </svg>
  );
}

export default function App() {
  const load = useEditor((s) => s.load);
  const document = useEditor((s) => s.document);
  const error = useEditor((s) => s.error);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const locked = useEditor((s) => s.locked);
  const setLocked = useEditor((s) => s.setLocked);
  const canvasMode = useEditor((s) => s.canvasMode);
  const setCanvasMode = useEditor((s) => s.setCanvasMode);
  const navRangeRef = useRef<NavRange | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const s = useEditor.getState();
      const meta = e.metaKey || e.ctrlKey;
      // `e.code` (physical key position, e.g. "KeyV") — not `e.key` (the character the active
      // keyboard LAYOUT produces for that key). Under a Cyrillic layout, `e.key` for the physical
      // V/Z keys is "м"/"я", not "v"/"z", so a `.key`-based check silently never fires (real
      // reported bug) — `.code` is layout-independent for any QWERTY-derived physical layout.
      if (meta && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) void s.redo();
        else void s.undo();
      } else if (!meta && !e.altKey && e.code === 'KeyV') {
        // the cursor/select tool's own fixed hotkey — it's not a hotbar slot (nothing to fill or
        // rearrange), so it isn't part of the 1-9/0 lookup below. NOT Escape: Escape is a
        // browser-TRUSTED key for exiting Fullscreen API mode — unblockable by design (a page can
        // never override it, precisely so it can't trap a user in fullscreen), so binding
        // anything to it also fires that native "collapse the window" behavior every time,
        // regardless of what our own handler does (real reported annoyance). `V` matches the
        // cursor/select-tool convention in Figma/Illustrator/Photoshop.
        e.preventDefault();
        s.setTool('select');
        s.select(null);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (s.selectedIds.length) {
          e.preventDefault();
          void s.deleteSelected();
        }
      } else if (!meta && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Two granularities, no extra endpoint — everything needed is already in the loaded
        // `document`. If the selection is ONE note out of a multi-note chord (not the whole
        // carrier), arrows step between that SAME chord's notes, bottom-to-top PHYSICALLY
        // (`physicalNoteOrder` — screen position, not pitch/spelling, which isn't implemented),
        // WRAPPING at the ends (top → bottom on ArrowRight past the last, and back). Once the
        // whole carrier is selected (stem-click/double-click, `carrierSelectedIds` — or a chord
        // with every one of its notes individually selected, which the codebase already treats as
        // equivalent, see [[note-vs-carrier-selection-granularity]]), arrows step between carriers
        // instead — that level does NOT wrap (past either end, nothing happens). `e.key`, not
        // `.code` — arrow keys aren't layout-remapped, unlike letters.
        const doc = s.document;
        const dir = e.key === 'ArrowRight' ? 1 : -1;

        if (!e.shiftKey) navRangeRef.current = null; // a plain move collapses any in-progress range

        // Derive the current single position + which granularity it's in — used both for a plain
        // move and for STARTING a new Shift-range. An in-progress Shift-range (below) skips this
        // and reuses its own stored anchor/cursor, since a multi-item range selection has no
        // single "current index" to re-derive from `selectedIds` alone.
        let mode: { kind: 'note' | 'carrier'; scopeId: string; ids: string[] } | null = null;
        let cursorId: string | null = null;
        if (s.selectedIds.length) {
          const anchorId = s.selectedIds[0];
          const carrierId = carrierIdOf(doc, anchorId);
          const item = itemOf(doc, carrierId);
          const selectedInCarrier = item ? item.notes.filter((n) => s.selectedIds.includes(n.noteId)) : [];
          if (item && item.notes.length > 1 && selectedInCarrier.length < item.notes.length) {
            mode = { kind: 'note', scopeId: carrierId, ids: physicalNoteOrder(doc, item) };
            cursorId = anchorId;
          } else {
            const voiceId = locate(doc, anchorId)?.voiceId;
            if (voiceId) {
              mode = { kind: 'carrier', scopeId: voiceId, ids: orderedVoiceCarrierIds(doc, voiceId) };
              cursorId = carrierId;
            }
          }
        } else {
          const voiceId = doc.voices[s.currentVoice]?.id;
          if (voiceId) mode = { kind: 'carrier', scopeId: voiceId, ids: orderedVoiceCarrierIds(doc, voiceId) };
        }

        // wrap for note-mode, clamp (no wrap) for carrier-mode — returns null past a carrier-mode edge
        const step = (kind: 'note' | 'carrier', ids: string[], fromIdx: number): number | null => {
          let next = fromIdx === -1 ? (dir === 1 ? 0 : ids.length - 1) : fromIdx + dir;
          if (kind === 'note') return ((next % ids.length) + ids.length) % ids.length;
          return next < 0 || next >= ids.length ? null : next;
        };
        const applySelection = (kind: 'note' | 'carrier', rangeIds: string[]): string[] => {
          if (kind === 'note') {
            s.selectMany(rangeIds, false);
            return rangeIds;
          }
          const noteIds = rangeIds.flatMap((cid) => chordNoteIds(doc, cid));
          s.selectMany(noteIds, false, rangeIds);
          return noteIds;
        };

        if (e.shiftKey) {
          const existing = navRangeRef.current;
          // reuse the in-progress range only if the store's selection still matches exactly what
          // WE last set it to — anything else in between (a mouse click) means the anchor is stale.
          const reusing = existing && sameIds(existing.appliedIds, s.selectedIds);
          const kind = reusing ? existing.kind : mode?.kind;
          const scopeId = reusing ? existing.scopeId : mode?.scopeId;
          const ids = reusing ? existing.ids : mode?.ids;
          const anchorId = reusing ? existing.anchorId : cursorId;
          const fromId = reusing ? existing.cursorId : cursorId;
          if (!kind || !scopeId || !ids || !ids.length || anchorId == null || fromId == null) return;
          const nextIdx = step(kind, ids, ids.indexOf(fromId));
          if (nextIdx === null) return;
          e.preventDefault();
          const anchorIdx = ids.indexOf(anchorId);
          const lo = Math.min(anchorIdx, nextIdx);
          const hi = Math.max(anchorIdx, nextIdx);
          const appliedIds = applySelection(kind, ids.slice(lo, hi + 1));
          navRangeRef.current = { kind, scopeId, anchorId, cursorId: ids[nextIdx], ids, appliedIds };
          return;
        }

        // plain move — single item, no range
        if (!mode || !mode.ids.length) return;
        const nextIdx = step(mode.kind, mode.ids, cursorId ? mode.ids.indexOf(cursorId) : -1);
        if (nextIdx === null) return;
        e.preventDefault();
        if (mode.kind === 'note') {
          s.select(mode.ids[nextIdx]);
        } else {
          const carrierId = mode.ids[nextIdx];
          s.selectMany(chordNoteIds(doc, carrierId), false, [carrierId]);
        }
      } else if (!meta && !e.altKey) {
        // hotbar quick-select: 1-9 then 0 (the 10th slot — matches the common browser-tab
        // convention, not a wraparound). Empty slots are inert — the key is reserved for them but
        // does nothing until something is dropped in (future work).
        for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
          if (e.key !== hotbarSlotKey(i)) continue;
          const slotTool = s.hotbarSlots[i];
          if (slotTool) {
            e.preventDefault();
            s.setTool(slotTool);
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          Piano Studio
          <small>{document.title || 'Untitled'} · draft</small>
        </div>
        <div className="spacer" />
        {error && <span className="topbar-error" title={error}>{error}</span>}
        <SegmentedControl
          value={canvasMode}
          onChange={setCanvasMode}
          options={CANVAS_MODE_OPTIONS}
          ariaLabel="Canvas layout"
        />
        <button
          className={'icon-btn' + (locked ? ' active' : '')}
          title="Lock — block selection for playback"
          onClick={() => setLocked(!locked)}
        >
          <LockIcon locked={locked} />
        </button>
        <button className="icon-btn" onClick={() => void undo()} title="Undo (Cmd+Z)">
          ↶
        </button>
        <button className="icon-btn" onClick={() => void redo()} title="Redo (Cmd+Shift+Z)">
          ↷
        </button>
        <div className="zoom">
          <button className="icon-btn" onClick={() => setZoom(zoom - 0.1)}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => setZoom(zoom + 0.1)}>
            +
          </button>
        </div>
      </header>
      <Toolbar />
      <div className="workspace">
        <LeftPanel />
        <EditorView />
        <PropertiesPanel />
      </div>
      <PlaybackBar />
    </div>
  );
}

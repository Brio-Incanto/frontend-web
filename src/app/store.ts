import { create } from 'zustand';
import type { ScoreDocument } from '@/core/model/score';
import { carrierIdOf, chordNoteIds } from '@/core/model/query';
import type { Command } from '@/core/commands/command';
import type { EditorGateway } from '@/core/gateway/EditorGateway';
import { HttpGateway } from '@/core/gateway/HttpGateway';
import { QueuedGateway } from '@/core/gateway/QueuedGateway';

export type Tool = 'select' | 'w' | 'h' | 'q' | '8' | '16' | 'rest' | 'tie';

/** number of quick-access hotbar slots (DESIGN.md §4/§7's "Deck") — hotkeys 1-9 then 0, matching
 *  the common browser-tab convention (0 = the 10th slot, not "before 1"). `null` = an empty,
 *  reachable-but-unfilled slot — visually present with its hotkey label, functionally inert until
 *  something is dropped into it. The cursor/select tool is NOT one of these ten: it has its own
 *  fixed hotkey (Esc, see App.tsx) since it's not a "stamp" you fill/rearrange like the rest. */
export const HOTBAR_SLOT_COUNT = 10;
/** the digit each slot index binds to — index 9 is '0' (the 10th key on the row), not a wraparound. */
export function hotbarSlotKey(index: number): string {
  return index === 9 ? '0' : String(index + 1);
}

const EMPTY_DOC: ScoreDocument = { id: '', title: '', staffOrder: [], voices: [], measures: [] };

interface EditorState {
  // the backend owns the draft document + undo/redo journal, keyed by score id;
  // the client holds the last rendered view + transient UI state only.
  scoreId: string;
  document: ScoreDocument;
  loading: boolean;
  error: string | null;

  tool: Tool;
  /** the ten quick-access hotbar slots, in hotkey order (index 0 = key "1", … index 9 = key "0") —
   *  `null` is an empty slot. Currently a fixed starting layout (the 5 duration tools); the
   *  eventual drag-from-constructor customization (DESIGN.md §13) will call `setHotbarSlot` to
   *  rearrange it — the slot MODEL is built now so that feature only appends, per this repo's
   *  usual "don't rewrite it twice" rule. */
  hotbarSlots: (Tool | null)[];
  selectedIds: string[];
  // carrier ids that were selected AT CARRIER GRANULARITY (via the stem handle or a chord
  // double-click), not derived from `selectedIds`/note counts — needed specifically to
  // distinguish a single-note carrier's "select the carrier" action (stem-click / double-click,
  // which must show stem context) from a plain notehead click on that same lone note (a NOTE
  // selection, which must not — see PropertiesPanel's `isStemCarrier`). For a real (2+ note)
  // chord this is redundant with "every note selected" and isn't needed to tell the two apart,
  // but is still set for consistency. Reset to `[]` by any note-granularity selection action
  // (plain `select`, marquee/group `selectMany` with no `carrierIds`).
  carrierSelectedIds: string[];
  zoom: number;
  locked: boolean;
  canvasMode: 'line' | 'page';

  // current working target (which staff / voice edits act on). The staff pick is a deliberate
  // manual choice, not inferred from click geometry — it's what lets you choose ledger lines on
  // the current staff vs. a cross-staff note on the other one (see Overlay.tsx's
  // resolveInsertTarget).
  currentStaff: string;
  currentVoice: number;
  leftPanelOpen: boolean;

  // custom voice-color overrides (keyed by voice id) — unset voices fall back to the default
  // palette cycling by index (see core/model/voiceColors). Drives the left-panel swatch, the
  // score's selection highlight, and the insert-ghost preview, so they never drift apart.
  voiceColors: Record<string, string>;

  // manual stem direction/length overrides (keyed by note carrier id) — CLIENT-ONLY, not sent to
  // the backend and lost on reload; the model has no stem concept to persist yet (TODO: persist
  // once the backend grows one). Unset notes get VexFlow's automatic direction (see
  // VexflowRenderer.tsx's `auto_stem`).
  stemOverrides: Record<string, { direction: 1 | -1; length: number | null }>;

  gateway: EditorGateway;

  load: () => Promise<void>;
  dispatch: (command: Command) => Promise<void>;
  deleteSelected: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  setTool: (tool: Tool) => void;
  /** rearranges/fills/clears one hotbar slot — not wired to any UI yet (drag-from-constructor is
   *  future work), but exists now so that feature is additive, not a rewrite. */
  setHotbarSlot: (index: number, tool: Tool | null) => void;
  /** null clears; additive (Shift) toggles the id in/out of the set. */
  select: (id: string | null, additive?: boolean) => void;
  /** replace or (additive) union the selection — used by the marquee / group selects.
   *  `carrierIds`: pass the carrier id(s) this call selects AT CARRIER GRANULARITY (stem-click,
   *  chord double-click) — omitted (or empty) for note-granularity multi-selects (marquee,
   *  voice/staff/measure group-select), which resets `carrierSelectedIds`. */
  selectMany: (ids: string[], additive: boolean, carrierIds?: string[]) => void;
  setZoom: (zoom: number) => void;
  setLocked: (locked: boolean) => void;
  setCanvasMode: (mode: 'line' | 'page') => void;
  setCurrentStaff: (id: string) => void;
  setCurrentVoice: (voice: number) => void;
  toggleLeftPanel: () => void;
  /** null resets the voice back to its default palette color. */
  setVoiceColor: (voiceId: string, color: string | null) => void;
  /** null clears the override, reverting the note to automatic stem direction/length. */
  setStemOverride: (noteId: string, override: { direction: 1 | -1; length: number | null } | null) => void;
}

// Queued so edit requests to one draft (load/apply/undo/redo) are always in flight
// one at a time, in call order — see QueuedGateway for why.
const gateway: EditorGateway = new QueuedGateway(new HttpGateway());

export const useEditor = create<EditorState>((set, get) => ({
  scoreId: 'default',
  document: EMPTY_DOC,
  loading: true,
  error: null,
  tool: 'select',
  // starting layout: the 5 duration tools in their old toolbar order, then 5 empty slots ready to
  // be filled later. Not derived from anything — this is the deliberate default arrangement.
  hotbarSlots: ['w', 'h', 'q', '8', '16', null, null, null, null, null],
  selectedIds: [],
  carrierSelectedIds: [],
  zoom: 1,
  locked: false,
  canvasMode: 'line',
  currentStaff: '',
  currentVoice: 0,
  leftPanelOpen: true,
  voiceColors: {},
  stemOverrides: {},
  gateway,

  load: async () => {
    try {
      const document = await get().gateway.load(get().scoreId);
      set((s) => ({
        document,
        loading: false,
        error: null,
        currentStaff: s.currentStaff || document.staffOrder[0] || '',
      }));
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  dispatch: async (command) => {
    try {
      const document = await get().gateway.apply(get().scoreId, command);
      set({ document, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  deleteSelected: async () => {
    // `selectedIds` holds INDIVIDUAL note ids (one note within a chord is selectable on its own —
    // see Overlay.tsx). Group them by owning carrier: a carrier with EVERY note selected (the
    // common "single-note carrier" and "whole chord via fast double-click" cases) is deleted whole;
    // a carrier with only SOME notes selected has just those notes removed, leaving the rest of the
    // chord intact. BOTH kinds go in ONE `deleteBatch` gesture → a single Delete is a single undo
    // entry regardless of how the selection mixes whole carriers and partial chord-notes.
    const doc = get().document;
    const ids = get().selectedIds;
    if (!ids.length) return;
    set({ selectedIds: [], carrierSelectedIds: [] });

    const selectedByCarrier = new Map<string, string[]>();
    for (const id of ids) {
      const carrierId = carrierIdOf(doc, id);
      const arr = selectedByCarrier.get(carrierId) ?? [];
      arr.push(id);
      selectedByCarrier.set(carrierId, arr);
    }

    // Build a FLAT list of entity ids: a fully-selected carrier collapses to its carrier id (drop
    // the whole chord), a partially-selected one contributes its picked note ids (drop those notes,
    // keep the rest). The backend resolves + classifies each id, so both kinds go in one array.
    const entityIds: string[] = [];
    for (const [carrierId, selectedInCarrier] of selectedByCarrier) {
      const allNoteIds = chordNoteIds(doc, carrierId);
      const isWholeCarrier = allNoteIds.every((nid) => selectedInCarrier.includes(nid));
      if (isWholeCarrier) entityIds.push(carrierId);
      else entityIds.push(...selectedInCarrier);
    }

    if (entityIds.length) {
      await get().dispatch({ type: 'deleteBatch', entityIds });
    }
  },

  undo: async () => {
    try {
      const document = await get().gateway.undo(get().scoreId);
      set({ document, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  redo: async () => {
    try {
      const document = await get().gateway.redo(get().scoreId);
      set({ document, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // entering an insert tool (any non-select tool) drops the current selection — inserting
  // while old elements are still selected read as if they were about to be affected too.
  setTool: (tool) =>
    set((s) => ({
      tool,
      selectedIds: tool === 'select' ? s.selectedIds : [],
      carrierSelectedIds: tool === 'select' ? s.carrierSelectedIds : [],
    })),

  setHotbarSlot: (index, tool) =>
    set((s) => {
      if (index < 0 || index >= HOTBAR_SLOT_COUNT) return {};
      const hotbarSlots = [...s.hotbarSlots];
      hotbarSlots[index] = tool;
      return { hotbarSlots };
    }),

  select: (id, additive = false) =>
    set((s) => {
      if (s.locked) return {};
      if (id === null) return { selectedIds: [], carrierSelectedIds: [] };
      if (additive) {
        return s.selectedIds.includes(id)
          ? { selectedIds: s.selectedIds.filter((x) => x !== id) }
          : { selectedIds: [...s.selectedIds, id] };
      }
      // a fresh plain click is a NOTE-granularity pick, even if it happens to land on a
      // single-note carrier — drop any prior carrier-level selection.
      return { selectedIds: [id], carrierSelectedIds: [] };
    }),

  selectMany: (ids, additive, carrierIds = []) =>
    set((s) => {
      if (s.locked) return {};
      if (additive) {
        return {
          selectedIds: [...new Set([...s.selectedIds, ...ids])],
          carrierSelectedIds: [...new Set([...s.carrierSelectedIds, ...carrierIds])],
        };
      }
      return { selectedIds: ids, carrierSelectedIds: carrierIds };
    }),

  setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(2, Math.round(zoom * 10) / 10)) }),

  setLocked: (locked) =>
    set((s) => ({
      locked,
      selectedIds: locked ? [] : s.selectedIds,
      carrierSelectedIds: locked ? [] : s.carrierSelectedIds,
    })),

  setCanvasMode: (mode) => set({ canvasMode: mode }),

  setCurrentStaff: (id) => set({ currentStaff: id }),
  setCurrentVoice: (voice) => set({ currentVoice: voice }),
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),

  setVoiceColor: (voiceId, color) =>
    set((s) => {
      const voiceColors = { ...s.voiceColors };
      if (color === null) delete voiceColors[voiceId];
      else voiceColors[voiceId] = color;
      return { voiceColors };
    }),

  setStemOverride: (noteId, override) =>
    set((s) => {
      const stemOverrides = { ...s.stemOverrides };
      if (override === null) delete stemOverrides[noteId];
      else stemOverrides[noteId] = override;
      return { stemOverrides };
    }),
}));

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useEditor, hotbarSlotKey, type Tool } from '@/app/store';
import { ToolIcon } from './icons';
import { SegmentedControl } from './SegmentedControl';
import { DEFAULT_VOICE_COLORS, resolveVoiceColor } from '@/core/model/voiceColors';
import { voiceCarrierIds, orderedVoiceCarrierIds } from '@/core/model/query';

// rest/tie tools parked for now — everything reachable today is either the cursor or a real
// VexFlow-rendered duration glyph (see icons.tsx); no hand-drawn ones left.
const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  w: 'Whole note',
  h: 'Half note',
  q: 'Quarter note',
  '8': 'Eighth note',
  '16': 'Sixteenth note',
  rest: 'Rest',
  tie: 'Tie',
};

function staffLabel(staffOrder: string[], id: string): string {
  const i = staffOrder.indexOf(id);
  if (i === 0) return 'Upper';
  if (i === 1) return 'Lower';
  return `Staff ${i + 1}`;
}

// Cursor/select tool has its own fixed hotkey (V, matching Figma/Illustrator convention) — not
// Escape, which the browser reserves for exiting Fullscreen API mode unblockably. Not one of the
// ten numbered hotbar slots (DESIGN.md §4/§7's "Deck") either: it's always the same tool in the
// same place, nothing to fill/rearrange. The ten slots after it are quick-access stamps (digits
// 1-9, 0); currently fixed to the 5 duration tools, rest empty. Filling from the left constructor
// panel is future work.
export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const hotbarSlots = useEditor((s) => s.hotbarSlots);
  const doc = useEditor((s) => s.document);
  const currentStaff = useEditor((s) => s.currentStaff);
  const currentVoice = useEditor((s) => s.currentVoice);
  const setCurrentStaff = useEditor((s) => s.setCurrentStaff);
  const setCurrentVoice = useEditor((s) => s.setCurrentVoice);
  const voiceColors = useEditor((s) => s.voiceColors);
  const setVoiceColor = useEditor((s) => s.setVoiceColor);
  const selectMany = useEditor((s) => s.selectMany);

  const [voicePopoverOpen, setVoicePopoverOpen] = useState(false);
  const voiceGroupRef = useRef<HTMLDivElement>(null);

  // click-outside close — the popover is the only overflow content in the deck, no library needed
  useEffect(() => {
    if (!voicePopoverOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (voiceGroupRef.current && !voiceGroupRef.current.contains(e.target as Node)) {
        setVoicePopoverOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [voicePopoverOpen]);

  const currentVoiceId = doc.voices[currentVoice]?.id;

  return (
    <div className="hotbar">
      <button
        className={'tool' + (tool === 'select' ? ' active' : '')}
        title={`${TOOL_LABELS.select} (V)`}
        onClick={() => setTool('select')}
      >
        <ToolIcon id="select" />
        <span className="tool-hotkey">V</span>
      </button>

      <div className="hotbar-sep" />

      {hotbarSlots.map((slotTool, i) => (
        <button
          key={i}
          className={'tool' + (slotTool && tool === slotTool ? ' active' : '') + (slotTool ? '' : ' empty')}
          title={slotTool ? `${TOOL_LABELS[slotTool]} (${hotbarSlotKey(i)})` : `Empty slot (${hotbarSlotKey(i)})`}
          disabled={!slotTool}
          onClick={() => slotTool && setTool(slotTool)}
        >
          {slotTool && <ToolIcon id={slotTool} />}
          <span className="tool-hotkey">{hotbarSlotKey(i)}</span>
        </button>
      ))}

      <div className="deck-right">
        <SegmentedControl
          value={currentStaff}
          onChange={setCurrentStaff}
          options={doc.staffOrder.map((id) => ({ value: id, label: staffLabel(doc.staffOrder, id) }))}
          ariaLabel="Staff"
        />

        <div className="deck-voice-group" ref={voiceGroupRef}>
          {doc.voices.map((voice) => (
            <button
              key={voice.id}
              className={'deck-voice-chip' + (currentVoice === voice.index ? ' active' : '')}
              style={{ '--vc': resolveVoiceColor(voice.id, voice.index, voiceColors) } as CSSProperties}
              title={`Voice ${voice.index + 1}`}
              onClick={() => setCurrentVoice(voice.index)}
            >
              {voice.index + 1}
            </button>
          ))}
          <button
            className={'icon-btn deck-voice-more' + (voicePopoverOpen ? ' active' : '')}
            title="Voice color & select all"
            disabled={!currentVoiceId}
            onClick={() => setVoicePopoverOpen((v) => !v)}
          >
            {voicePopoverOpen ? '▴' : '▾'}
          </button>

          {voicePopoverOpen && currentVoiceId && (
            <div className="deck-voice-popover">
              <div className="deck-voice-popover-header">
                <span
                  className="deck-voice-popover-dot"
                  style={{ '--vc': resolveVoiceColor(currentVoiceId, currentVoice, voiceColors) } as CSSProperties}
                />
                Voice {currentVoice + 1}
              </div>
              <span className="lp-sublabel">Color</span>
              <div className="voice-swatch-row">
                {DEFAULT_VOICE_COLORS.map((c) => (
                  <button
                    key={c}
                    className="voice-swatch"
                    style={{ '--vc': c } as CSSProperties}
                    title={c}
                    onClick={() => setVoiceColor(currentVoiceId, c)}
                  />
                ))}
                <label className="voice-swatch voice-swatch-custom" title="Custom color">
                  <input
                    type="color"
                    value={resolveVoiceColor(currentVoiceId, currentVoice, voiceColors)}
                    onChange={(e) => setVoiceColor(currentVoiceId, e.target.value)}
                  />
                </label>
              </div>
              <button
                className="icon-btn deck-voice-select-all"
                onClick={() => {
                  // carrier granularity, not note granularity — every carrier in the voice counts
                  // as "selected as a whole" (stem-context UI, etc.), matching double-click/arrow-
                  // key whole-carrier selection, not a plain multi-note pick (see
                  // [[note-vs-carrier-selection-granularity]]). `selectedIds` still needs every
                  // individual note id too (that's what actually tints each note on the score).
                  const carrierIds = orderedVoiceCarrierIds(doc, currentVoiceId);
                  selectMany(voiceCarrierIds(doc, currentVoiceId), false, carrierIds);
                  setVoicePopoverOpen(false);
                }}
              >
                Select all in voice
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

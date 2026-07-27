import { useCallback, useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import type { AnimationPlaybackControls } from 'motion/react';
import { useEditor } from '@/app/store';
import { VexflowRenderer } from '@/rendering/vexflow/VexflowRenderer';
import { Overlay } from './Overlay';
import type { ScoreLayout, MeasureBox } from '@/rendering/ScoreRenderer';
import { playback } from '@/core/playback/PlaybackController';
import { SPRING_SMOOTH } from '@/styles/motion';

// Mode-switch wipe timings (DESIGN.md §3.5 mode case). Erase is a quick accelerate-out; the redraw
// is slower and decelerates, so the new mode reads as being progressively drawn back in, not popped.
const ERASE_S = 0.19;
const REDRAW_S = 0.4;

/** The measure closest to the top-left of the current viewport, in the given mode — line mode
 *  cares about horizontal scroll only (one row), page mode about vertical (which row is topmost;
 *  `measures` is already in row-major, left-to-right document order, so the first measure not yet
 *  fully scrolled past vertically IS that row's leftmost one, no separate column search needed). */
function computeAnchorMeasureId(
  measures: MeasureBox[],
  mode: 'line' | 'page',
  scrollLeft: number,
  scrollTop: number,
  zoom: number,
): string | null {
  if (!measures.length) return null;
  if (mode === 'line') {
    const viewX = scrollLeft / zoom;
    for (const m of measures) if (m.x + m.w > viewX + 1) return m.id;
    return measures[measures.length - 1].id;
  }
  const viewY = scrollTop / zoom;
  for (const m of measures) if (m.y + m.h > viewY + 1) return m.id;
  return measures[measures.length - 1].id;
}

/** Scrolls so `anchorId` lands exactly at the viewport's leading edge in the given mode — the
 *  leftmost column (line) or the top row (page). Instant: it fires while the content is still fully
 *  clipped (erased), so the jump itself is invisible; only the redraw reads as motion. */
function scrollToAnchor(
  el: HTMLDivElement,
  measures: MeasureBox[],
  mode: 'line' | 'page',
  anchorId: string,
  zoom: number,
): void {
  const m = measures.find((mm) => mm.id === anchorId);
  if (!m) return;
  if (mode === 'line') {
    el.scrollLeft = m.x * zoom;
    el.scrollTop = 0;
  } else {
    el.scrollTop = m.y * zoom;
    el.scrollLeft = 0;
  }
}

export function EditorView() {
  const document = useEditor((s) => s.document);
  const selectedIds = useEditor((s) => s.selectedIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const storeMode = useEditor((s) => s.canvasMode);
  const zoom = useEditor((s) => s.zoom);
  const voiceColors = useEditor((s) => s.voiceColors);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const [layout, setLayout] = useState<ScoreLayout | null>(null);
  const [hoveredNoteIds, setHoveredNoteIds] = useState<string[]>([]);

  const reduce = useReducedMotion();

  // Mode actually being RENDERED — decoupled from the store's `canvasMode` so the OLD content can be
  // erased before the new mode's layout replaces it.
  const [displayMode, setDisplayMode] = useState(storeMode);
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;

  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const scoreContentRef = useRef<HTMLDivElement>(null);

  const onLayout = useCallback((l: ScoreLayout) => {
    setLayout(l);
    playback.setTotalBeats(l.totalBeats);
  }, []);

  // Reflow-zoom (page mode): rendered page width stays pinned to `.canvas-area`'s available
  // width regardless of zoom, so page mode never needs horizontal scroll — zoom only changes how
  // much content fits per system. Recomputed off the store's `zoom` (commits instantly, unlike
  // the animated `scale`), which does trigger a fresh layout per click; also watches
  // `.canvas-area`'s own size via `ResizeObserver` for window resizes and panel toggles.
  const [pageContentWidth, setPageContentWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const area = canvasAreaRef.current;
    if (!area) return;
    const recompute = () => {
      // Inverts EditorView's own `paperW` formula (`w*zoom + 48`) and VexflowRenderer's page-mode
      // `totalW = 2*MARGIN_L(24) + pageContentWidth` against the actual available box, so the
      // result is exactly what was already correct at 100% zoom, just generalized to any zoom.
      const available = area.clientWidth - 48; // minus .canvas-area's own --space-6 padding (24px * 2)
      const target = (available - 48) / zoom - 48; // minus paperW's own +48, then MARGIN_L*2
      setPageContentWidth(Math.max(200, target));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(area);
    return () => ro.disconnect();
  }, [zoom]);

  // --- ZOOM (unchanged, works): store `zoom` commits instantly; one spring chases it, and the
  // scale transform + container sizes are all read from that ONE value every frame so they can't
  // desync. A content edit leaves the spring at rest, so the size transforms recompute to the new
  // w/h instantly — edits never lag.
  const scale = useSpring(zoom, SPRING_SMOOTH);
  useEffect(() => {
    if (reduce) scale.jump(zoom);
    else scale.set(zoom);
  }, [zoom, reduce, scale]);

  // Zoom anchors on the VIEWPORT CENTER, not the scroll container's top-left (the default: a
  // scaled box growing/shrinking from `transformOrigin: top left` leaves `scrollLeft`/`scrollTop`
  // untouched, so the content pixel that was at the top-left corner stays put — everything visibly
  // drifts away from center as you zoom). Captured once per zoom trigger (the content-local point
  // currently under the viewport's center, read from the CURRENT scale before this change starts
  // animating), then re-applied on every `scale` tick for the rest of the spring's flight so the
  // anchor stays fixed on screen throughout the animation, not just once it settles.
  useEffect(() => {
    const area = canvasAreaRef.current;
    const content = scoreContentRef.current;
    if (!area || !content) return;

    const areaRect = area.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const s = scale.get() || 1;
    const centerX = areaRect.left + areaRect.width / 2;
    const centerY = areaRect.top + areaRect.height / 2;
    const anchor = {
      x: (centerX - contentRect.left) / s,
      y: (centerY - contentRect.top) / s,
    };

    return scale.on('change', (curS) => {
      const a = canvasAreaRef.current;
      const c = scoreContentRef.current;
      if (!a || !c) return;
      const aRect = a.getBoundingClientRect();
      const cRect = c.getBoundingClientRect();
      const cx = aRect.left + aRect.width / 2;
      const cy = aRect.top + aRect.height / 2;
      const anchorScreenX = cRect.left + anchor.x * curS;
      const anchorScreenY = cRect.top + anchor.y * curS;
      a.scrollLeft += anchorScreenX - cx;
      a.scrollTop += anchorScreenY - cy;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Keep the selection in view, smoothly — arrow-key carrier navigation (App.tsx) can move the
  // selection past the edge of what's currently scrolled into view, in both line and page mode.
  // Same idea as the zoom-center fix above (animate `.canvas-area`'s scroll, don't jump it), same
  // spring preset as everything else chrome-weight (`SPRING_SMOOTH`, §3.5) — deliberately a ONE-
  // SHOT animation (current scroll -> a computed target), not a continuously-live value like
  // `scale`, since there's no per-frame-changing source driving it here.
  const selectionScrollAnimRef = useRef<AnimationPlaybackControls | null>(null);
  const prevSelectedIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevSelectedIdsRef.current;
    const changed = selectedIds.length !== prev.length || selectedIds.some((id, i) => id !== prev[i]);
    prevSelectedIdsRef.current = selectedIds;
    if (!changed || !selectedIds.length || !layout) return;

    const area = canvasAreaRef.current;
    const content = scoreContentRef.current;
    if (!area || !content) return;

    const boxes = layout.noteBoxes.filter((nb) => selectedIds.includes(nb.id));
    if (!boxes.length) return;
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));

    const s = scale.get() || 1;
    const contentRect = content.getBoundingClientRect();
    const areaRect = area.getBoundingClientRect();
    const boxLeft = contentRect.left + minX * s;
    const boxRight = contentRect.left + maxX * s;
    const boxTop = contentRect.top + minY * s;
    const boxBottom = contentRect.top + maxY * s;
    const viewLeft = areaRect.left;
    const viewRight = areaRect.left + areaRect.width;
    const viewTop = areaRect.top;
    const viewBottom = areaRect.top + areaRect.height;

    // already fully on screen — don't yank the view for a selection change that's already visible
    // (a plain click), only rescue one that navigated past the edge.
    if (boxLeft >= viewLeft && boxRight <= viewRight && boxTop >= viewTop && boxBottom <= viewBottom) return;

    const deltaX = (boxLeft + boxRight) / 2 - (viewLeft + viewRight) / 2;
    const deltaY = (boxTop + boxBottom) / 2 - (viewTop + viewBottom) / 2;
    const startL = area.scrollLeft;
    const startT = area.scrollTop;
    const targetL = startL + deltaX;
    const targetT = startT + deltaY;

    selectionScrollAnimRef.current?.stop();
    if (reduce) {
      area.scrollLeft = targetL;
      area.scrollTop = targetT;
      return;
    }
    selectionScrollAnimRef.current = animate(0, 1, {
      type: 'spring',
      ...SPRING_SMOOTH,
      onUpdate: (t) => {
        area.scrollLeft = startL + (targetL - startL) * t;
        area.scrollTop = startT + (targetT - startT) * t;
      },
    });
  }, [selectedIds, layout, reduce, scale]);

  const w = layout?.width ?? 0;
  const h = layout?.height ?? 0;
  const dimsRef = useRef({ w, h });
  dimsRef.current = { w, h };

  const paperW = useTransform(scale, (z) => dimsRef.current.w * z + 48);
  const paperH = useTransform(scale, (z) => dimsRef.current.h * z + 48);
  const scaleW = useTransform(scale, (z) => dimsRef.current.w * z);
  const scaleH = useTransform(scale, (z) => dimsRef.current.h * z);

  // --- MODE SWITCH: erase along the old axis → redraw along the new axis, no ghost. ---
  // `wipe`: 0 = fully drawn (visible), 1 = fully erased. Implemented as `overflow: hidden` on a
  // dedicated `.score-wipe` wrapper whose own box size shrinks/grows — NOT `clip-path` on the
  // `scale`-transformed content itself. `clip-path` animated together with `transform` on an
  // element containing a big SVG tree, inside a SCROLLABLE ancestor, is a known compositor
  // trigger for stale-paint trails in Chromium/WebKit (confirmed real repro: fast scrolling during
  // a switch left note-glyph streaks behind). Plain `overflow: hidden` + a real box-size change is
  // the standard, reliably-repainted clipping mechanism — the axis (line = width, page = height)
  // is still keyed on whatever mode is currently DISPLAYED, same as before.
  const wipe = useMotionValue(0);
  const wipeFactor = useTransform(wipe, (v) => 1 - v);
  const wipeW = useTransform([scaleW, wipeFactor], (vals: number[]) =>
    displayModeRef.current === 'line' ? vals[0] * vals[1] : vals[0],
  );
  const wipeH = useTransform([scaleH, wipeFactor], (vals: number[]) =>
    displayModeRef.current === 'page' ? vals[0] * vals[1] : vals[0],
  );

  const switchGenRef = useRef(0);
  const wipeAnimRef = useRef<AnimationPlaybackControls | null>(null);
  const pendingRedrawRef = useRef<{ gen: number; mode: 'line' | 'page'; anchorId: string | null } | null>(null);
  // the scroll anchor is LOCKED: only a genuine user scroll updates it; the programmatic scroll we
  // do on each switch is ignored (guarded below). Without this, re-reading the anchor from the
  // post-switch scroll position quantised differently each time and the focused measure DRIFTED
  // across repeated switches — now the same measure stays anchored no matter how many switches.
  const lastAnchorRef = useRef<string | null>(null);
  const suppressScrollAnchorRef = useRef(false);

  // Start the switch when the store's mode diverges from what's displayed. Erase the current
  // content, then (on completion) commit the new mode — the redraw is kicked off by the layout
  // effect below once the new layout is actually ready + scroll-anchored.
  useEffect(() => {
    if (storeMode === displayMode) return;
    const gen = ++switchGenRef.current;
    const toMode = storeMode;

    // lock the anchor: reuse the last user-chosen one, or compute it once from the current scroll
    // (and store it, so subsequent switches reuse the identical measure — no drift).
    let anchorId = lastAnchorRef.current;
    const area = canvasAreaRef.current;
    if (anchorId == null && layout && area) {
      anchorId = computeAnchorMeasureId(layout.measures, displayMode, area.scrollLeft, area.scrollTop, zoom);
      lastAnchorRef.current = anchorId;
    }

    const el = scoreContentRef.current;
    if (reduce || !el) {
      pendingRedrawRef.current = { gen, mode: toMode, anchorId };
      setDisplayMode(toMode);
      return;
    }

    wipeAnimRef.current?.stop();
    wipeAnimRef.current = animate(wipe, 1, {
      duration: ERASE_S,
      ease: [0.4, 0, 1, 1],
      // onComplete fires only on NATURAL completion — a superseding switch calls `.stop()`, which
      // does not fire it — so this never runs for a stale erase. (The gen check is belt-and-braces.)
      onComplete: () => {
        if (switchGenRef.current !== gen) return;
        pendingRedrawRef.current = { gen, mode: toMode, anchorId };
        setDisplayMode(toMode); // content stays fully clipped (wipe=1) until the redraw effect fires
      },
    });
  }, [storeMode, displayMode, reduce, wipe, layout, zoom]);

  // Once the freshly-switched-to layout has actually arrived, scroll the locked anchor to the
  // leading edge (invisible — still fully erased), then redraw: wipe 1 → 0 along the new axis.
  useEffect(() => {
    const pending = pendingRedrawRef.current;
    if (!pending || !layout || pending.mode !== displayMode || layout.mode !== displayMode) return;
    if (switchGenRef.current !== pending.gen) {
      pendingRedrawRef.current = null;
      return;
    }
    const area = canvasAreaRef.current;
    if (area && pending.anchorId) {
      suppressScrollAnchorRef.current = true;
      scrollToAnchor(area, layout.measures, displayMode, pending.anchorId, zoom);
      requestAnimationFrame(() => {
        suppressScrollAnchorRef.current = false;
      });
    }
    pendingRedrawRef.current = null;

    const el = scoreContentRef.current;
    if (reduce || !el) {
      wipe.set(0);
      return;
    }
    wipeAnimRef.current?.stop();
    wipeAnimRef.current = animate(wipe, 0, { duration: REDRAW_S, ease: [0, 0, 0.2, 1] });
  }, [layout, displayMode, zoom, reduce, wipe]);

  useEffect(() => {
    return () => {
      wipeAnimRef.current?.stop();
      selectionScrollAnimRef.current?.stop();
    };
  }, []);

  const onScroll = () => {
    if (suppressScrollAnchorRef.current) return; // our own programmatic scroll — never re-anchor on it
    const el = canvasAreaRef.current;
    if (!el || !layout || layout.mode !== displayMode) return;
    lastAnchorRef.current = computeAnchorMeasureId(layout.measures, displayMode, el.scrollLeft, el.scrollTop, zoom);
  };

  return (
    <div className="canvas-area" ref={canvasAreaRef} onScroll={onScroll}>
      <motion.div className="paper" style={{ width: paperW, height: paperH }}>
        <motion.div className="score-scale" style={{ width: scaleW, height: scaleH }}>
          <motion.div className="score-wipe" style={{ width: wipeW, height: wipeH }}>
            <motion.div
              ref={scoreContentRef}
              className="score-content"
              style={{ scale, transformOrigin: 'top left', width: w, height: h, position: 'relative' }}
            >
              <VexflowRenderer
                document={document}
                selectedIds={selectedIds}
                carrierSelectedIds={carrierSelectedIds}
                mode={displayMode}
                pageContentWidth={pageContentWidth}
                onLayout={onLayout}
                voiceColors={voiceColors}
                stemOverrides={stemOverrides}
                hoveredNoteIds={hoveredNoteIds}
              />
              {layout && <Overlay layout={layout} onHoverNote={setHoveredNoteIds} />}
            </motion.div>
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  );
}

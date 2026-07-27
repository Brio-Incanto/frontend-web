import { useEffect, useRef } from 'react';
import type { Tool } from '@/app/store';
import {
  type DurationTool,
  isDurationTool,
  renderDurationSvg,
  getSharedGlyphBox,
} from '@/rendering/vexflow/noteGlyph';

// Duration icons are REAL VexFlow glyphs (see rendering/vexflow/noteGlyph.ts) — this guarantees
// the toolbar matches the actual score engraving pixel-for-pixel, instead of a hand-drawn
// approximation drifting out of sync with it, and shares its notehead-centered anchoring with
// the insert-ghost preview (Overlay.tsx) so both come from one mechanism. Non-duration tools
// (select/rest/tie) stay hand-drawn — they're UI symbols, not notation this app renders.

function VexDurationIcon({ duration }: { duration: DurationTool }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { svg, noteheadBox: box } = renderDurationSvg(duration, host);
    const noteheadBox = box ?? svg.getBBox();
    const cx = noteheadBox.x + noteheadBox.width / 2;
    const noteheadBottom = noteheadBox.y + noteheadBox.height;

    // one shared, measured box for every duration — this icon's own notehead center is placed
    // at its horizontal middle, and its bottom sits `above` a fixed distance up from the box
    // bottom, so all 5 icons render at the same size with their noteheads at the same spot.
    const { halfW, above, below } = getSharedGlyphBox();
    const pad = halfW * 0.15; // proportional breathing room — scales with the measured box, not a flat guess
    const left = cx - halfW - pad;
    const width = 2 * (halfW + pad);
    const top = noteheadBottom - above - pad;
    const height = above + below + pad * 2;
    svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);

    const ICON_H = 24; // fixed render height, shared by every duration icon — sized for legibility
    // inside the 32px deck cell (was 20px/26px cell, too small to read — real user feedback)
    const scale = ICON_H / height;
    const iconW = Math.round(width * scale);
    svg.setAttribute('width', String(iconW));
    svg.setAttribute('height', String(ICON_H));
    // Renderer.resize() set an inline width (SVGContext) that otherwise wins over the
    // attributes above for layout size — override it explicitly to match the crop.
    svg.style.width = `${iconW}px`;
    svg.style.height = `${ICON_H}px`;
  }, [duration]);

  return <div className="vex-icon" ref={hostRef} />;
}

// stroke width 1.75 per DESIGN.md §9's icon spec — was 1.4/1.7/1.8, three ad-hoc per-icon values
// with no documented reason for the differences; one shared value now, applied uniformly.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// rendered at 24x24 — sized for legibility inside the 32px deck cell (was 20px, too small to read
// — real user feedback). viewBox stays the hand-tuned "0 0 24 24" authoring space (the select
// icon's centroid correction is calibrated to it) so only the OUTPUT size changed, not the path
// coordinate math — at 24x24 output this now also happens to be a 1:1 pixel mapping.
function svg(children: React.ReactNode) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

export function ToolIcon({ id }: { id: Tool }) {
  if (isDurationTool(id)) return <VexDurationIcon duration={id} />;

  switch (id) {
    case 'select':
      // shifted +2.3 in x from the raw bbox-centered coordinates: the cursor's visible "weight"
      // is its solid triangular head, not the thin tail, so the AREA-weighted centroid (not the
      // bbox center) needs to land on-center. Vertical needed no correction.
      return svg(
        <path d="M8.3 4 L8.3 18 L12 14 L14.6 20 L16.6 19 L13.9 13.2 L18.8 13 Z" fill="currentColor" />,
      );
    case 'rest':
      return svg(
        <path
          d="M9 5 L12.6 9 L9.9 11.4 C8.5 12.6 9.7 13.8 11.8 14.4 C9.6 14.5 8.3 15.7 10.4 18.2"
          {...STROKE}
        />,
      );
    case 'tie':
      return svg(<path d="M5.5 11 Q12 17.5 18.5 11" {...STROKE} />);
    default:
      return null;
  }
}

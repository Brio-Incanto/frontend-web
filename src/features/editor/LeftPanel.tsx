import { motion, useTransform } from 'motion/react';
import { useEditor } from '@/app/store';
import { useLayoutSafeSpring, SPRING_PANEL_BOUNCE } from '@/styles/motion';

const OPEN_W = 264;

// macOS-window-style slide: CLOSE kicks right a touch before accelerating off-left, OPEN grows
// past 264 before settling back. Uses `useLayoutSafeSpring` (src/styles/motion.ts, the
// project-wide pattern for this): `layout` (critically damped, no overshoot) is the only value
// driving `.left-panel`'s flex `width`; `visual` carries the actual bounce and drives only
// `.lp-content`'s transform, so the score next to it never gets nudged by the bounce.
const CLOSE_ANTICIPATE_VELOCITY = 6; // kicks right before sliding left
const OPEN_OVERSHOOT_VELOCITY = 5; // grows past 264 before settling back to it
// visibly underdamped (ζ ≈ 0.6) — the whole point of `visual` is to carry a real bounce, unlike
// the hook's default `visualSpring` (SPRING_SMOOTH, ζ ≈ 1.02, tuned calm for OTHER use cases and
// barely shows the injected-velocity overshoot at all). Config lives in `src/styles/motion.ts`
// (`SPRING_PANEL_BOUNCE`) — §11: components never inline their own stiffness/damping.

export function LeftPanel() {
  const open = useEditor((s) => s.leftPanelOpen);
  const toggle = useEditor((s) => s.toggleLeftPanel);

  const { layout: p, visual: pv } = useLayoutSafeSpring(open, {
    visualSpring: SPRING_PANEL_BOUNCE,
    openVelocity: OPEN_OVERSHOOT_VELOCITY,
    closeVelocity: CLOSE_ANTICIPATE_VELOCITY,
  });
  // defensive [0,1] clamp — belt-and-braces on top of `layout`'s own critical damping (see the
  // hook's doc); should never actually engage, but costs nothing and removes any doubt.
  const layoutWidth = useTransform(p, (v) => Math.max(0, Math.min(1, v)) * OPEN_W);
  const visualX = useTransform(pv, (v) => (v - 1) * OPEN_W); // 0 open → -OPEN_W gone; carries the bounce
  const revealOpacity = useTransform(pv, [0, 0.4], [1, 0]); // edge "show" button fades in as it leaves

  return (
    <>
      <motion.aside className="left-panel" style={{ width: layoutWidth }}>
        <motion.div className="lp-content" style={{ x: visualX }}>
          <button className="icon-btn lp-toggle" title="Hide panel" onClick={toggle}>
            ◂
          </button>

          <h3>Editor</h3>

          <div className="lp-hint">
            New notes go to the current staff &amp; voice. Switch staff and click the same beat again
            to build a cross-staff chord — a voice is global, so it can place notes on either staff.
          </div>
        </motion.div>
      </motion.aside>

      <motion.button
        className="icon-btn lp-reveal"
        title="Show panel"
        onClick={toggle}
        style={{ opacity: revealOpacity, pointerEvents: open ? 'none' : 'auto' }}
      >
        ▸
      </motion.button>
    </>
  );
}

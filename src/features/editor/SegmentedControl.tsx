import { motion } from 'motion/react';
import { springSnappy } from '@/styles/motion';

// The ONE shared "Segmented control" (DESIGN.md §7) — used for canvas mode (Line/Page, App.tsx)
// and the staff selector (Upper/Lower, Toolbar.tsx). A "raised active thumb that slides" between
// options, not a per-button background swap: `.seg-thumb` is a single `motion.div` that only ever
// renders inside the currently-active button, so switching options re-parents it — `motion/react`
// tracks that via `layoutId` and animates the move as one continuous FLIP, using `springSnappy`
// (small-control preset, §3.5) rather than a component-local stiffness/damping guess.
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {value === opt.value && (
            <motion.div className="seg-thumb" layoutId={`seg-thumb-${ariaLabel}`} transition={springSnappy} />
          )}
          <span className="seg-btn-label">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

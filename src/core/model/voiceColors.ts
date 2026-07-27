// Per-voice colours (MuseScore-style), aligned with the DESIGN.md voice tokens. A voice's
// color is used for its identity swatch (left panel), its selection highlight on the score,
// and its insert-ghost preview — all three read from the SAME resolved color so they never
// drift out of sync. Defaults cycle through this palette by voice index; the user can override
// any voice with an arbitrary custom color (stored separately, checked first).
export const DEFAULT_VOICE_COLORS = ['#a34b2f', '#4e7cb8', '#4e9b8f', '#8b6fb8', '#c25e8f'];

export const defaultVoiceColor = (index: number): string =>
  DEFAULT_VOICE_COLORS[index % DEFAULT_VOICE_COLORS.length];

/** custom overrides (keyed by voice id) win; otherwise cycle the default palette by index. */
export const resolveVoiceColor = (
  voiceId: string,
  index: number,
  overrides: Record<string, string>,
): string => overrides[voiceId] ?? defaultVoiceColor(index);

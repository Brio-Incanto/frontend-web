import { useSyncExternalStore } from 'react';

export interface PlaybackState {
  playing: boolean;
  timeBeats: number;
  totalBeats: number;
}

export type PlaybackListener = (state: PlaybackState) => void;

/**
 * Transport for the moving-timeline cursor and (later) audio playback.
 * The editor reads `timeBeats` and maps it to an x via the renderer's time map.
 * A Tone.js-backed impl will replace the stub behind this same interface.
 */
export interface PlaybackController {
  play(): void;
  pause(): void;
  stop(): void;
  seek(beats: number): void;
  setTotalBeats(total: number): void;
  setTempo(bpm: number): void;
  getState(): PlaybackState;
  subscribe(listener: PlaybackListener): () => void;
}

class StubPlaybackController implements PlaybackController {
  private state: PlaybackState = { playing: false, timeBeats: 0, totalBeats: 12 };
  private bpm = 96;
  private listeners = new Set<PlaybackListener>();
  private raf = 0;
  private last = 0;

  play() {
    if (this.state.playing) return;
    this.set({ playing: true });
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.set({ playing: false });
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.set({ playing: false, timeBeats: 0 });
  }

  seek(beats: number) {
    this.set({ timeBeats: Math.max(0, Math.min(beats, this.state.totalBeats)) });
  }

  setTotalBeats(total: number) {
    this.set({ totalBeats: total });
  }

  setTempo(bpm: number) {
    this.bpm = bpm;
  }

  getState() {
    return this.state;
  }

  subscribe(listener: PlaybackListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private loop = () => {
    if (!this.state.playing) return;
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    let t = this.state.timeBeats + dt * (this.bpm / 60);
    if (t >= this.state.totalBeats) t = 0; // loop for the demo
    this.set({ timeBeats: t });
    this.raf = requestAnimationFrame(this.loop);
  };
}

export const playback: PlaybackController = new StubPlaybackController();

/** Subscribe a React component to the transport state. */
export function usePlayback(): PlaybackState {
  return useSyncExternalStore(
    (cb) => playback.subscribe(() => cb()),
    () => playback.getState(),
  );
}

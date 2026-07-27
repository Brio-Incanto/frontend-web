import { playback, usePlayback } from '@/core/playback/PlaybackController';

export function PlaybackBar() {
  const { playing, timeBeats, totalBeats } = usePlayback();
  return (
    <footer className="transport">
      <button className="play" onClick={() => (playing ? playback.pause() : playback.play())}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="icon-btn" title="Stop" onClick={() => playback.stop()}>
        ◼
      </button>
      <span className="time">
        {timeBeats.toFixed(1)} / {totalBeats.toFixed(0)} beats
      </span>
      <input
        className="seek"
        type="range"
        min={0}
        max={totalBeats}
        step={0.01}
        value={timeBeats}
        onChange={(e) => playback.seek(parseFloat(e.target.value))}
      />
      <span className="badge">Playback: stub timeline (Tone.js later)</span>
    </footer>
  );
}

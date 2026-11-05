// Tells a stuck video tile from a slow share. On a slow share a tile goes
// 'waiting' and comes back ('playing', or its time moves) again and again; a
// stuck tile goes 'waiting' and never comes back. waiting(id) arms a timer
// for that tile and resumed(id) disarms it; if the timer fires, onStall(id)
// is called once for that wait so the caller can log every tile's state.
export function createMediaStallWatch({
  stallMs = 10000,
  onStall,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout
} = {}) {
  const timers = new Map();
  return {
    waiting(id) {
      if (timers.has(id)) return;
      timers.set(id, setTimer(() => {
        timers.delete(id);
        onStall?.(id, stallMs);
      }, stallMs));
    },
    resumed(id) {
      const timer = timers.get(id);
      if (timer === undefined) return;
      clearTimer(timer);
      timers.delete(id);
    },
    clear() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
    get waitingCount() {
      return timers.size;
    }
  };
}

// One line per tile for the stall log: position, readyState, networkState,
// buffered ranges and file name.
export function describeVideoTile(video) {
  if (!video) return 'none';
  const ranges = [];
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push(`${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}`);
    }
  } catch { /* detached element */ }
  const src = String(video.currentSrc || video.src || '').split('/').pop();
  return `${video.id || '?'} t=${Number(video.currentTime || 0).toFixed(2)} ` +
    `readyState=${video.readyState} networkState=${video.networkState}` +
    `${video.paused ? ' paused' : ''}${video.seeking ? ' seeking' : ''}` +
    `${video.error ? ` error=${video.error.code}` : ''} buffered=[${ranges.join(',')}] ${decodeURIComponent(src)}`;
}

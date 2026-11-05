import test from 'node:test';
import assert from 'node:assert/strict';

import { createMediaStallWatch, describeVideoTile } from '../../src/shared/mediaStallWatch.mjs';

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(fn, ms) { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
    }
  };
}

test('a tile that keeps coming back from waiting is never reported (slow share)', () => {
  const timers = fakeTimers();
  const stalls = [];
  const watch = createMediaStallWatch({ stallMs: 10000, onStall: (id) => stalls.push(id), ...timers });
  for (let i = 0; i < 20; i++) {
    watch.waiting('videoTC');
    timers.advance(4000);
    watch.resumed('videoTC');
    timers.advance(1000);
  }
  assert.deepEqual(stalls, []);
  assert.equal(watch.waitingCount, 0);
});

test('a tile that never comes back is reported once per wait', () => {
  const timers = fakeTimers();
  const stalls = [];
  const watch = createMediaStallWatch({ stallMs: 10000, onStall: (id, ms) => stalls.push([id, ms]), ...timers });
  watch.waiting('videoBL');
  watch.waiting('videoBL'); // repeated waiting/stalled events do not re-arm
  timers.advance(9999);
  assert.deepEqual(stalls, []);
  timers.advance(1);
  assert.deepEqual(stalls, [['videoBL', 10000]]);
  timers.advance(60000);
  assert.equal(stalls.length, 1);
  watch.resumed('videoBL');
  watch.waiting('videoBL');
  timers.advance(10000);
  assert.equal(stalls.length, 2);
});

test('clear() disarms every tile', () => {
  const timers = fakeTimers();
  const stalls = [];
  const watch = createMediaStallWatch({ stallMs: 1000, onStall: (id) => stalls.push(id), ...timers });
  watch.waiting('a');
  watch.waiting('b');
  watch.clear();
  timers.advance(5000);
  assert.deepEqual(stalls, []);
});

test('describeVideoTile reports position, states and buffered ranges', () => {
  const video = {
    id: 'videoTC', currentTime: 12.345, readyState: 2, networkState: 2, paused: false, seeking: false, error: null,
    currentSrc: 'file:///Volumes/USB/SavedClips/x/2026-10-16_10-02-50-front.mp4',
    buffered: { length: 1, start: () => 0, end: () => 14.5 }
  };
  assert.equal(describeVideoTile(video),
    'videoTC t=12.35 readyState=2 networkState=2 buffered=[0.0-14.5] 2026-10-16_10-02-50-front.mp4');
  assert.equal(describeVideoTile(null), 'none');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAsyncLimiter,
  createBoundedLru,
  createInFlightDeduper,
  createLifecycleSession,
  createObjectUrlRegistry,
  createOwnedResourceSlot,
  detachMediaElement,
  isAbortError
} from '../../src/shared/asyncLifecycle.mjs';

test('one limiter caps overlapping callers globally and skips aborted queued work', async () => {
  const limiter = createAsyncLimiter(2);
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const run = index => limiter.run(async () => {
    started.push(index);
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return index;
  }, { signal: index >= 2 ? controller.signal : undefined });

  const promises = [0, 1, 2, 3].map(run);
  await Promise.resolve();
  controller.abort();
  release();

  const settled = await Promise.allSettled(promises);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1]);
  assert.ok(settled.slice(2).every(item =>
    item.status === 'rejected' && isAbortError(item.reason)
  ));
});

test('disposing a lifecycle session cancels scheduled callbacks and runs cleanup once', () => {
  const frames = new Map();
  const timers = new Map();
  let nextId = 1;
  let cleaned = 0;
  const session = createLifecycleSession({
    requestFrame: callback => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: id => frames.delete(id),
    setTimer: callback => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: id => timers.delete(id)
  });

  session.onDispose(() => cleaned++);
  session.requestFrame(() => assert.fail('disposed frame ran'));
  session.setTimeout(() => assert.fail('disposed timer ran'), 10);
  session.dispose();
  session.dispose();

  assert.equal(session.signal.aborted, true);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(cleaned, 1);
});

test('owned resources and object URLs are released exactly once', () => {
  const disconnected = [];
  const slot = createOwnedResourceSlot(value => value.disconnect());
  slot.replace({ disconnect: () => disconnected.push('first') });
  slot.replace({ disconnect: () => disconnected.push('second') });
  slot.clear();
  slot.clear();

  const revoked = [];
  const urls = createObjectUrlRegistry({
    revokeObjectURL: value => revoked.push(value)
  });
  urls.add('blob:a');
  urls.add('blob:a');
  urls.add('blob:b');
  urls.revokeAll();
  urls.revokeAll();

  assert.deepEqual(disconnected, ['first', 'second']);
  assert.deepEqual(revoked, ['blob:a', 'blob:b']);
});

test('bounded LRU evicts the oldest entry and refreshes hits', () => {
  const cache = createBoundedLru(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.size, 2);
});

test('in-flight deduper shares one load while one caller cancels waiting', async () => {
  const deduper = createInFlightDeduper();
  const controller = new AbortController();
  let loads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const loader = async () => {
    loads++;
    await gate;
    return { seiData: [1] };
  };

  const cancelled = deduper.run('clip', loader, { signal: controller.signal });
  const survivor = deduper.run('clip', loader);
  controller.abort();
  release();

  await assert.rejects(cancelled, error => error.name === 'AbortError');
  assert.deepEqual(await survivor, { seiData: [1] });
  assert.equal(loads, 1);
  assert.equal(deduper.size, 0);
});

test('a disposed lifecycle session cannot publish after awaited work', async () => {
  const session = createLifecycleSession({
    requestFrame: callback => callback(),
    cancelFrame: () => {},
    setTimer: callback => callback(),
    clearTimer: () => {}
  });
  let published = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const work = (async () => {
    await pending;
    if (session.isActive()) published = true;
  })();

  session.dispose();
  release();
  await work;

  assert.equal(published, false);
});

test('detaching inactive media pauses and releases its source', () => {
  const calls = [];
  const video = {
    pause: () => calls.push('pause'),
    removeAttribute: name => calls.push(`remove:${name}`),
    load: () => calls.push('load')
  };

  detachMediaElement(video);
  detachMediaElement(null);

  assert.deepEqual(calls, ['pause', 'remove:src', 'load']);
});

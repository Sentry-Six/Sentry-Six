import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialSegmentDurations,
  resolveSegmentDurations
} from '../../src/shared/playbackTiming.mjs';
import {
  createAsyncLimiter,
  createBoundedLru
} from '../../src/shared/asyncLifecycle.mjs';

test('uses profile-specific duration estimates before metadata is available', () => {
  assert.deepEqual(createInitialSegmentDurations(3, 'tesla'), [60, 60, 60]);
  assert.deepEqual(
    createInitialSegmentDurations(3, 'gm_surroundvision'),
    [300, 300, 300]
  );
});

test('keeps mixed one-minute and five-minute metadata durations exactly', async () => {
  const groups = [{ duration: 60 }, { duration: 300 }, { duration: 75.5 }];
  const durations = await resolveSegmentDurations(groups, {
    profileId: 'gm_surroundvision',
    probe: async group => group.duration,
    concurrency: 2
  });

  assert.deepEqual(durations, [60, 300, 75.5]);
});

test('falls back per segment when metadata probing fails or is invalid', async () => {
  const groups = [{ result: 61 }, { result: NaN }, { error: true }];
  const durations = await resolveSegmentDurations(groups, {
    profileId: 'gm_surroundvision',
    probe: async group => {
      if (group.error) throw new Error('unreadable');
      return group.result;
    },
    concurrency: 2
  });

  assert.deepEqual(durations, [61, 300, 300]);
});

test('limits metadata probes to the requested concurrency', async () => {
  let active = 0;
  let peak = 0;
  const groups = Array.from({ length: 8 }, (_, index) => ({ index }));

  await resolveSegmentDurations(groups, {
    profileId: 'tesla',
    concurrency: 3,
    probe: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return 60;
    }
  });

  assert.equal(peak, 3);
});

test('overlapping duration resolutions share one global limiter', async () => {
  const limiter = createAsyncLimiter(4);
  let active = 0;
  let peak = 0;
  const probe = async group => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return group.duration;
  };
  const options = {
    profileId: 'tesla',
    probe,
    runProbe: (task, signal) => limiter.run(task, { signal })
  };

  await Promise.all([
    resolveSegmentDurations(
      Array.from({ length: 8 }, () => ({ duration: 60 })),
      options
    ),
    resolveSegmentDurations(
      Array.from({ length: 8 }, () => ({ duration: 60 })),
      options
    )
  ]);

  assert.equal(peak, 4);
});

test('aborting duration resolution prevents queued probes and cache writes', async () => {
  const controller = new AbortController();
  const limiter = createAsyncLimiter(1);
  const cache = createBoundedLru(8);
  let started = 0;

  const resultPromise = resolveSegmentDurations(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    {
      profileId: 'tesla',
      signal: controller.signal,
      cache,
      getCacheKey: group => group.id,
      runProbe: (task, signal) => limiter.run(task, { signal }),
      probe: async () => {
        started++;
        controller.abort();
        return 61;
      }
    }
  );

  await assert.rejects(resultPromise, error => error.name === 'AbortError');
  assert.equal(started, 1);
  assert.equal(cache.size, 0);
});

test('duration cache reuses stable results without changing fallbacks', async () => {
  const cache = createBoundedLru(2);
  let probes = 0;
  const options = {
    profileId: 'tesla',
    cache,
    getCacheKey: group => group.id,
    probe: async group => {
      probes++;
      return group.duration;
    }
  };

  assert.deepEqual(
    await resolveSegmentDurations([{ id: 'a', duration: 61 }], options),
    [61]
  );
  assert.deepEqual(
    await resolveSegmentDurations([{ id: 'a', duration: 99 }], options),
    [61]
  );
  assert.equal(probes, 1);
});

import { getDashcamProfile } from './dashcamProfiles.mjs';
import { createAbortError, isAbortError } from './asyncLifecycle.mjs';

export function createInitialSegmentDurations(count, profileId) {
  const fallback = getDashcamProfile(profileId).defaultSegmentDurationSeconds;
  return new Array(Math.max(0, Number(count) || 0)).fill(fallback);
}

export async function resolveSegmentDurations(groups, options = {}) {
  const items = Array.isArray(groups) ? groups : [];
  const fallback = getDashcamProfile(options.profileId)
    .defaultSegmentDurationSeconds;
  const probe = options.probe;
  const signal = options.signal;
  const concurrency = Math.max(
    1,
    Math.min(items.length || 1, Number(options.concurrency) || 4)
  );
  const results = new Array(items.length).fill(fallback);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      if (signal?.aborted) throw createAbortError();
      const index = nextIndex++;
      const cacheKey = options.getCacheKey?.(items[index], index);
      if (cacheKey && options.cache?.has(cacheKey)) {
        results[index] = options.cache.get(cacheKey);
        continue;
      }

      try {
        const task = () => probe(items[index], index, signal);
        const duration = options.runProbe
          ? await options.runProbe(task, signal)
          : await task();
        if (signal?.aborted) throw createAbortError();
        if (Number.isFinite(duration) && duration > 0) {
          results[index] = duration;
          if (cacheKey) options.cache?.set(cacheKey, duration);
        }
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw createAbortError();
        results[index] = fallback;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

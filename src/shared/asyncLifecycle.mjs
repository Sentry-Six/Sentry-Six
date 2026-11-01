export function createAbortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('Operation aborted', 'AbortError');
  }
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function waitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function createAsyncLimiter(maxConcurrent) {
  const limit = Math.max(1, Number(maxConcurrent) || 1);
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const item = queue.shift();
      item.signal?.removeEventListener('abort', item.onAbort);
      if (item.signal?.aborted) {
        item.reject(createAbortError());
        continue;
      }

      active++;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };

  return {
    run(task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(createAbortError());

      return new Promise((resolve, reject) => {
        const item = { task, signal, resolve, reject, onAbort: null };
        item.onAbort = () => {
          const index = queue.indexOf(item);
          if (index < 0) return;
          queue.splice(index, 1);
          reject(createAbortError());
        };
        signal?.addEventListener('abort', item.onAbort, { once: true });
        queue.push(item);
        drain();
      });
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return queue.length;
    }
  };
}

export function createLifecycleSession(options = {}) {
  const controller = new AbortController();
  const frames = new Set();
  const timers = new Set();
  const disposers = new Set();
  const requestFrame = options.requestFrame || globalThis.requestAnimationFrame;
  const cancelFrame = options.cancelFrame || globalThis.cancelAnimationFrame;
  const setTimer = options.setTimer || globalThis.setTimeout;
  const clearTimer = options.clearTimer || globalThis.clearTimeout;
  let active = true;

  const session = {
    signal: controller.signal,
    isActive() {
      return active;
    },
    requestFrame(callback) {
      if (!active) return null;
      const id = requestFrame(() => {
        frames.delete(id);
        if (active) callback();
      });
      frames.add(id);
      return id;
    },
    setTimeout(callback, delay) {
      if (!active) return null;
      const id = setTimer(() => {
        timers.delete(id);
        if (active) callback();
      }, delay);
      timers.add(id);
      return id;
    },
    onDispose(dispose) {
      if (active) disposers.add(dispose);
      else dispose();
    },
    dispose() {
      if (!active) return;
      active = false;
      controller.abort();
      for (const id of frames) cancelFrame(id);
      for (const id of timers) clearTimer(id);
      frames.clear();
      timers.clear();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Cleanup is best-effort; remaining resources must still be released.
        }
      }
      disposers.clear();
    }
  };

  return session;
}

export function createOwnedResourceSlot(dispose) {
  let current = null;
  return {
    get() {
      return current;
    },
    replace(next) {
      if (current && current !== next) dispose(current);
      current = next || null;
      return current;
    },
    clear() {
      if (!current) return;
      const value = current;
      current = null;
      dispose(value);
    }
  };
}

export function createObjectUrlRegistry(urlApi) {
  const urls = new Set();
  return {
    add(url) {
      if (url?.startsWith?.('blob:')) urls.add(url);
      return url;
    },
    revokeAll() {
      for (const url of urls) {
        try {
          urlApi.revokeObjectURL(url);
        } catch {
          // Continue revoking the remaining URLs.
        }
      }
      urls.clear();
    },
    get size() {
      return urls.size;
    }
  };
}

export function createBoundedLru(maxEntries) {
  const limit = Math.max(1, Number(maxEntries) || 1);
  const values = new Map();
  return {
    has(key) {
      return values.has(key);
    },
    get(key) {
      if (!values.has(key)) return undefined;
      const value = values.get(key);
      values.delete(key);
      values.set(key, value);
      return value;
    },
    set(key, value) {
      values.delete(key);
      values.set(key, value);
      while (values.size > limit) {
        values.delete(values.keys().next().value);
      }
    },
    clear() {
      values.clear();
    },
    get size() {
      return values.size;
    }
  };
}

export function createInFlightDeduper() {
  const inFlight = new Map();
  return {
    run(key, loader, { signal } = {}) {
      if (!key) {
        return waitWithSignal(Promise.resolve().then(loader), signal);
      }
      if (!inFlight.has(key)) {
        const promise = Promise.resolve()
          .then(loader)
          .finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
      }
      return waitWithSignal(inFlight.get(key), signal);
    },
    get size() {
      return inFlight.size;
    }
  };
}

export function detachMediaElement(video) {
  if (!video) return;
  try {
    video.pause?.();
  } catch {}
  try {
    video.removeAttribute?.('src');
  } catch {}
  try {
    video.load?.();
  } catch {}
}

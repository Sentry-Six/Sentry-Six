function emptySentryUsbCache() {
  return {
    filePath: null,
    mtimeMs: 0,
    drives: null,
    routeCount: 0,
    routesLen: 0
  };
}

function createSentryUsbCache() {
  let value = emptySentryUsbCache();
  let generation = 0;

  return {
    get() {
      return value;
    },
    replace(next, expectedGeneration = generation) {
      if (expectedGeneration !== generation) return false;
      value = next;
      return true;
    },
    clear() {
      value = emptySentryUsbCache();
      generation++;
      return { success: true };
    },
    get generation() {
      return generation;
    }
  };
}

module.exports = { createSentryUsbCache };

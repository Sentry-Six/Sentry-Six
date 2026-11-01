export function createDirtyValueTracker() {
  const values = new Map();
  return {
    changed(key, value) {
      if (values.has(key) && Object.is(values.get(key), value)) return false;
      values.set(key, value);
      return true;
    },
    reset() {
      values.clear();
    }
  };
}

const { createSentryUsbCache } = require('../../src/main/sentryUsbCache');

test('clearing SentryUSB cache releases heavy drive references', () => {
  const store = createSentryUsbCache();
  const drives = [{
    id: 1,
    pointsBuf: new Float64Array(1000),
    fsdEvents: [{ id: 1 }]
  }];

  store.replace({
    filePath: '/drive-data.json',
    mtimeMs: 1,
    drives,
    routeCount: 2,
    routesLen: 3
  }, store.generation);
  expect(store.get().drives).toBe(drives);

  expect(store.clear()).toEqual({ success: true });
  expect(store.get()).toEqual({
    filePath: null,
    mtimeMs: 0,
    drives: null,
    routeCount: 0,
    routesLen: 0
  });
});

test('a load started before clear cannot repopulate the cache', () => {
  const store = createSentryUsbCache();
  const loadGeneration = store.generation;
  store.clear();

  const replaced = store.replace({
    filePath: '/stale.json',
    mtimeMs: 1,
    drives: [{ id: 'stale' }],
    routeCount: 1,
    routesLen: 1
  }, loadGeneration);

  expect(replaced).toBe(false);
  expect(store.get().drives).toBeNull();
});

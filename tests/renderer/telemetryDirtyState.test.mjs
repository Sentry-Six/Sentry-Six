import test from 'node:test';
import assert from 'node:assert/strict';

import { createDirtyValueTracker } from '../../src/shared/telemetryDirtyState.mjs';

test('dirty tracker reports first and changed values but skips repeats', () => {
  const dirty = createDirtyValueTracker();

  assert.equal(dirty.changed('speed', 20), true);
  assert.equal(dirty.changed('speed', 20), false);
  assert.equal(dirty.changed('speed', 21), true);
  dirty.reset();
  assert.equal(dirty.changed('speed', 21), true);
});

test('dirty tracker distinguishes map, state, and language values', () => {
  const dirty = createDirtyValueTracker();

  assert.equal(dirty.changed('map', '1|2|90'), true);
  assert.equal(dirty.changed('map', '1|2|90'), false);
  assert.equal(dirty.changed('autopilot', '2|en'), true);
  assert.equal(dirty.changed('autopilot', '2|en'), false);
  assert.equal(dirty.changed('autopilot', '2|es'), true);
});

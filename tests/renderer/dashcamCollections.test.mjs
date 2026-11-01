import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashcamCollections } from '../../src/shared/dashcamCollections.mjs';

function group(timestampKey, {
  profileId = 'gm_surroundvision',
  tag = 'Continuous',
  eventId = null
} = {}) {
  return {
    id: `${tag}/${eventId ? `${eventId}/` : ''}${timestampKey}`,
    profileId,
    tag,
    eventId,
    timestampKey,
    filesByCamera: new Map([['front', { file: { name: 'clip.mp4' } }]])
  };
}

test('builds one Continuous collection per GMC date without one-minute splitting', () => {
  const groups = [
    group('2026-07-17_19-04-53'),
    group('2026-07-17_19-09-53'),
    group('2026-07-17_19-10-53')
  ];

  const result = buildDashcamCollections(groups, {
    profileId: 'gm_surroundvision',
    sourceKind: 'gmc-raw-flat'
  });
  const collection = result.collections.get('custom:2026-07-17');

  assert.equal(result.collections.size, 1);
  assert.equal(collection.tag, 'Continuous');
  assert.equal(collection.groups.length, 3);
  assert.equal(collection.profileId, 'gm_surroundvision');
  assert.equal(collection.durationMs, (6 * 60 + 300) * 1000);
  assert.deepEqual(collection.deletion, { allowed: false, path: null });
});

test('allows deleting only the exact Continuous date directory', () => {
  const deletionByDate = new Map([
    ['2026-07-17', { allowed: true, path: 'E:\\Continuous\\2026-07-17' }]
  ]);
  const result = buildDashcamCollections([
    group('2026-07-17_19-04-53')
  ], {
    profileId: 'gm_surroundvision',
    sourceKind: 'gmc-continuous',
    deletionByDate
  });

  assert.deepEqual(
    result.collections.get('custom:2026-07-17').deletion,
    { allowed: true, path: 'E:\\Continuous\\2026-07-17' }
  );
});

test('preserves Tesla Recent, Sentry, and Saved collection identifiers', () => {
  const groups = [
    group('2026-07-17_19-04-53', {
      profileId: 'tesla',
      tag: 'RecentClips'
    }),
    group('2026-07-17_19-05-53', {
      profileId: 'tesla',
      tag: 'SentryClips',
      eventId: '2026-07-17_19-05-53'
    }),
    group('2026-07-17_19-06-53', {
      profileId: 'tesla',
      tag: 'SavedClips',
      eventId: '2026-07-17_19-06-53'
    })
  ];

  const result = buildDashcamCollections(groups, { profileId: 'tesla' });

  assert.deepEqual(Array.from(result.collections.keys()).sort(), [
    'recent:2026-07-17',
    'saved:2026-07-17:2026-07-17_19-06-53',
    'sentry:2026-07-17:2026-07-17_19-05-53'
  ]);
  assert.equal(
    result.collections.get('recent:2026-07-17').durationMs,
    60_000
  );
});

test('preserves the legacy Tesla Custom label for loose-file libraries', () => {
  const result = buildDashcamCollections([
    group('2026-07-17_19-04-53', {
      profileId: 'tesla',
      tag: 'MyArchive'
    })
  ], { profileId: 'tesla' });

  assert.equal(
    result.collections.get('custom:2026-07-17').tag,
    'Custom'
  );
});

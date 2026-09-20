import test from 'node:test';
import assert from 'node:assert/strict';

import * as profiles from '../../src/shared/dashcamProfiles.mjs';
import {
  normalizeTeslaCamera,
  parseTeslaFilename
} from '../../src/shared/teslaFilename.mjs';

test('shares the Tesla filename parser with non-renderer consumers', () => {
  assert.deepEqual(parseTeslaFilename('2026-07-17_19-34-53-left.mp4'), {
    profileId: 'tesla',
    timestampKey: '2026-07-17_19-34-53',
    date: '2026-07-17',
    camera: 'left_repeater'
  });
  assert.equal(normalizeTeslaCamera('RIGHT'), 'right_repeater');
  assert.equal(profiles.parseTeslaFilename, parseTeslaFilename);
});

test('parses a GMC front clip without requiring side-camera evidence', () => {
  assert.deepEqual(
    profiles.parseDashcamFilename('FRONT_2026_07_17_T_19_34_53.mp4'),
    {
      profileId: 'gm_surroundvision',
      timestampKey: '2026-07-17_19-34-53',
      date: '2026-07-17',
      camera: 'front'
    }
  );
});

test('keeps Tesla as the default telemetry-capable profile', () => {
  const profile = profiles.getDashcamProfile();

  assert.equal(profile.id, 'tesla');
  assert.deepEqual(profile.capabilities, {
    telemetry: true,
    gps: true,
    dashboard: true,
    map: true,
    export: true,
    driveMatching: true
  });
  assert.equal(profile.defaultSegmentDurationSeconds, 60);
  assert.equal(profile.layoutId, 'six_default');
});

test('parses existing Tesla filenames without changing camera IDs', () => {
  const cases = [
    ['2026-07-17_19-34-53-front.mp4', 'front'],
    ['2026-07-17_19-34-53-left.mp4', 'left_repeater'],
    ['2026-07-17_19-34-53-right_pillar.mp4', 'right_pillar']
  ];

  for (const [filename, camera] of cases) {
    assert.deepEqual(profiles.parseDashcamFilename(filename), {
      profileId: 'tesla',
      timestampKey: '2026-07-17_19-34-53',
      date: '2026-07-17',
      camera
    });
  }
});

test('parses every GMC camera case-insensitively into profile-scoped IDs', () => {
  const cases = [
    ['FRONT_2026_07_17_T_19_34_53.mp4', 'front'],
    ['left_2026_07_17_t_19_34_53.MP4', 'left'],
    ['RIGHT_2026_07_17_T_19_34_53.mp4', 'right'],
    ['REAR_2026_07_17_T_19_34_53.mp4', 'rear'],
    ['INTERIOR_2026_07_17_T_19_34_53.mp4', 'interior']
  ];

  for (const [filename, camera] of cases) {
    assert.equal(profiles.parseDashcamFilename(filename)?.camera, camera);
  }
});

test('detects GMC from front and rear clips without requiring side cameras', () => {
  assert.deepEqual(profiles.detectDashcamProfile([
    'FRONT_2026_07_17_T_19_34_53.mp4',
    'REAR_2026_07_17_T_19_34_53.mp4'
  ]), {
    profileId: 'gm_surroundvision',
    mixed: false,
    counts: { tesla: 0, gm_surroundvision: 2 },
    ignoredCount: 0
  });
});

test('reports mixed Tesla and GMC selections instead of guessing', () => {
  assert.deepEqual(profiles.detectDashcamProfile([
    '2026-07-17_19-34-53-front.mp4',
    'FRONT_2026_07_17_T_19_34_53.mp4'
  ]), {
    profileId: null,
    mixed: true,
    counts: { tesla: 1, gm_surroundvision: 1 },
    ignoredCount: 0
  });
});

test('reports malformed filenames without preventing valid clips from loading', () => {
  assert.deepEqual(profiles.detectDashcamProfile([
    'FRONT_2026_07_17_T_19_34_53.mp4',
    'BROKEN_2026_07_17_T_19_34_53.mp4',
    'notes.txt'
  ]), {
    profileId: 'gm_surroundvision',
    mixed: false,
    counts: { tesla: 0, gm_surroundvision: 1 },
    ignoredCount: 2
  });
});

test('defines the GMC layout, capabilities, discovery, export defaults, and no-mirror rule', () => {
  const profile = profiles.getDashcamProfile('gm_surroundvision');

  assert.deepEqual(profile.capabilities, {
    telemetry: false,
    gps: false,
    dashboard: false,
    map: false,
    export: false,
    driveMatching: false
  });
  assert.equal(profile.defaultSegmentDurationSeconds, 300);
  assert.equal(profile.layoutId, 'gmc_surroundvision');
  assert.deepEqual(profile.layoutSlots, [
    { slot: 'tl', camera: 'left' },
    { slot: 'tc', camera: 'front' },
    { slot: 'tr', camera: 'right' },
    { slot: 'bl', camera: 'interior' },
    { slot: 'bc', camera: 'rear' },
    { slot: 'br', camera: null }
  ]);
  assert.deepEqual(profile.mirroredCameras, []);
  assert.equal(typeof profile.parseFilename, 'function');
  assert.deepEqual(profile.sourceRules, {
    rawAndroidPath: [
      'Android',
      'media',
      'com.gm.ultifi.gmconnectedcameraservice',
      'Recordings',
      'SurroundVisionRecorder'
    ],
    continuousFolder: 'Continuous'
  });
  assert.deepEqual(profile.exportDefaults, {
    fps: 30,
    cameraOrder: ['left', 'front', 'right', 'interior', 'rear']
  });
  assert.equal(profiles.getCameraLabel('gm_surroundvision', 'rear'), 'Rear');
});

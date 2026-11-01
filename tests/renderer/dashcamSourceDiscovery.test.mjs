import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverGmcSource } from '../../src/shared/dashcamSourceDiscovery.mjs';

function dir(name, children = []) {
  return { name, kind: 'directory', children };
}

function file(name) {
  return { name, kind: 'file' };
}

const adapter = {
  name: node => node.name,
  list: async node => node.children || []
};

function gmcFiles(date = '2026_07_17', time = '19_34_53') {
  return [
    file(`FRONT_${date}_T_${time}.mp4`),
    file(`REAR_${date}_T_${time}.mp4`)
  ];
}

function manifestSummary(manifest) {
  return {
    profileId: manifest?.profileId,
    sourceKind: manifest?.sourceKind,
    dates: Array.from(manifest?.dates?.keys?.() || []),
    deletionAllowed: Array.from(manifest?.dates?.values?.() || [])
      .map(value => value.deletionAllowed),
    mixedProfiles: manifest?.mixedProfiles === true
  };
}

test('discovers the raw Android SurroundVisionRecorder tree from a whole drive', async () => {
  const recorder = dir('SurroundVisionRecorder', gmcFiles());
  const drive = dir('GM_DRIVE', [
    dir('Android', [
      dir('media', [
        dir('com.gm.ultifi.gmconnectedcameraservice', [
          dir('Recordings', [recorder])
        ])
      ])
    ])
  ]);

  assert.deepEqual(manifestSummary(await discoverGmcSource(drive, adapter)), {
    profileId: 'gm_surroundvision',
    sourceKind: 'gmc-raw-flat',
    dates: ['2026-07-17'],
    deletionAllowed: [false],
    mixedProfiles: false
  });
});

test('discovers a directly selected flat SurroundVisionRecorder folder', async () => {
  const recorder = dir('SurroundVisionRecorder', [
    ...gmcFiles('2026_07_17'),
    ...gmcFiles('2026_07_18', '08_00_00')
  ]);

  assert.deepEqual(manifestSummary(await discoverGmcSource(recorder, adapter)), {
    profileId: 'gm_surroundvision',
    sourceKind: 'gmc-raw-flat',
    dates: ['2026-07-18', '2026-07-17'],
    deletionAllowed: [false, false],
    mixedProfiles: false
  });
});

test('discovers Continuous below either Recordings or an archive parent', async () => {
  for (const root of [
    dir('Recordings', [dir('Continuous', [dir('2026-07-17', gmcFiles())])]),
    dir('Archive', [dir('Continuous', [dir('2026-07-17', gmcFiles())])])
  ]) {
    assert.deepEqual(manifestSummary(await discoverGmcSource(root, adapter)), {
      profileId: 'gm_surroundvision',
      sourceKind: 'gmc-continuous',
      dates: ['2026-07-17'],
      deletionAllowed: [true],
      mixedProfiles: false
    });
  }
});

test('discovers Continuous and a date folder when each is selected directly', async () => {
  const dateFolder = dir('2026-07-17', gmcFiles());

  assert.deepEqual(
    manifestSummary(await discoverGmcSource(dir('Continuous', [dateFolder]), adapter)),
    {
      profileId: 'gm_surroundvision',
      sourceKind: 'gmc-continuous',
      dates: ['2026-07-17'],
      deletionAllowed: [true],
      mixedProfiles: false
    }
  );

  assert.deepEqual(manifestSummary(await discoverGmcSource(dateFolder, adapter)), {
    profileId: 'gm_surroundvision',
    sourceKind: 'gmc-continuous-date',
    dates: ['2026-07-17'],
    deletionAllowed: [true],
    mixedProfiles: false
  });
});

test('marks mixed Tesla and GMC files in raw, Continuous, and whole-drive sources', async () => {
  const teslaClip = file('2026-07-18_08-00-00-front.mp4');

  const raw = dir('SurroundVisionRecorder', [...gmcFiles(), teslaClip]);
  assert.equal((await discoverGmcSource(raw, adapter)).mixedProfiles, true);

  const continuous = dir('Continuous', [
    dir('2026-07-17', gmcFiles()),
    dir('2026-07-18', [teslaClip])
  ]);
  assert.equal((await discoverGmcSource(continuous, adapter)).mixedProfiles, true);

  const drive = dir('GM_DRIVE', [
    teslaClip,
    dir('Android', [
      dir('media', [
        dir('com.gm.ultifi.gmconnectedcameraservice', [
          dir('Recordings', [dir('SurroundVisionRecorder', gmcFiles())])
        ])
      ])
    ])
  ]);
  assert.equal((await discoverGmcSource(drive, adapter)).mixedProfiles, true);
});

test('rejects lookalike date folders that do not contain valid GMC clips', async () => {
  const root = dir('Continuous', [
    dir('2026-07-17', [
      file('notes.txt'),
      file('2026-07-17_19-34-53-front.mp4')
    ])
  ]);

  assert.equal(await discoverGmcSource(root, adapter), null);
});

import {
  TESLA_PROFILE_ID,
  parseTeslaFilename
} from './teslaFilename.mjs';

export {
  TESLA_PROFILE_ID,
  normalizeTeslaCamera,
  parseTeslaFilename
} from './teslaFilename.mjs';

export const GMC_PROFILE_ID = 'gm_surroundvision';

const GMC_CAMERA_IDS = {
  FRONT: 'front',
  LEFT: 'left',
  RIGHT: 'right',
  REAR: 'rear',
  INTERIOR: 'interior'
};

const TESLA_CAMERA_LABELS = {
  front: 'Front',
  back: 'Back',
  left_repeater: 'Left Repeater',
  right_repeater: 'Right Repeater',
  left_pillar: 'Left Pillar',
  right_pillar: 'Right Pillar'
};

const GMC_CAMERA_LABELS = {
  left: 'Left',
  front: 'Front',
  right: 'Right',
  rear: 'Rear',
  interior: 'Interior'
};

function parseGmcFilename(filename) {
  const match = String(filename || '').match(
    /^(FRONT|LEFT|RIGHT|REAR|INTERIOR)_(\d{4})_(\d{2})_(\d{2})_T_(\d{2})_(\d{2})_(\d{2})\.mp4$/i
  );
  if (!match) return null;
  const [, rawCamera, year, month, day, hour, minute, second] = match;
  return {
    profileId: GMC_PROFILE_ID,
    timestampKey: `${year}-${month}-${day}_${hour}-${minute}-${second}`,
    date: `${year}-${month}-${day}`,
    camera: GMC_CAMERA_IDS[rawCamera.toUpperCase()]
  };
}

export const DASHCAM_PROFILES = Object.freeze({
  [TESLA_PROFILE_ID]: Object.freeze({
    id: TESLA_PROFILE_ID,
    displayName: 'Tesla',
    collectionLabel: 'TeslaCam',
    customCollectionLabel: 'Custom',
    normalizeCollectionTag: false,
    localizedCameraLabels: true,
    defaultLooseSourceKind: 'tesla',
    parseFilename: parseTeslaFilename,
    layoutId: 'six_default',
    defaultSegmentDurationSeconds: 60,
    sourceRules: Object.freeze({
      roots: Object.freeze(['TeslaCam', 'RecentClips', 'SentryClips', 'SavedClips'])
    }),
    exportDefaults: Object.freeze({
      fps: 36,
      cameraOrder: Object.freeze([
        'left_pillar',
        'front',
        'right_pillar',
        'left_repeater',
        'back',
        'right_repeater'
      ])
    }),
    capabilities: Object.freeze({
      telemetry: true,
      gps: true,
      dashboard: true,
      map: true,
      export: true,
      driveMatching: true
    }),
    cameras: Object.freeze(TESLA_CAMERA_LABELS),
    layoutSlots: Object.freeze([
      { slot: 'tl', camera: 'left_pillar' },
      { slot: 'tc', camera: 'front' },
      { slot: 'tr', camera: 'right_pillar' },
      { slot: 'bl', camera: 'left_repeater' },
      { slot: 'bc', camera: 'back' },
      { slot: 'br', camera: 'right_repeater' }
    ]),
    mirroredCameras: Object.freeze(['back', 'left_repeater', 'right_repeater'])
  }),
  [GMC_PROFILE_ID]: Object.freeze({
    id: GMC_PROFILE_ID,
    displayName: 'GM Surround Vision',
    collectionLabel: 'Continuous',
    customCollectionLabel: 'Continuous',
    normalizeCollectionTag: true,
    localizedCameraLabels: false,
    defaultLooseSourceKind: 'gmc-raw-flat',
    parseFilename: parseGmcFilename,
    layoutId: 'gmc_surroundvision',
    defaultSegmentDurationSeconds: 300,
    sourceRules: Object.freeze({
      rawAndroidPath: Object.freeze([
        'Android',
        'media',
        'com.gm.ultifi.gmconnectedcameraservice',
        'Recordings',
        'SurroundVisionRecorder'
      ]),
      continuousFolder: 'Continuous'
    }),
    exportDefaults: Object.freeze({
      fps: 30,
      cameraOrder: Object.freeze(['left', 'front', 'right', 'interior', 'rear'])
    }),
    capabilities: Object.freeze({
      telemetry: false,
      gps: false,
      dashboard: false,
      map: false,
      export: false,
      driveMatching: false
    }),
    cameras: Object.freeze(GMC_CAMERA_LABELS),
    layoutSlots: Object.freeze([
      { slot: 'tl', camera: 'left' },
      { slot: 'tc', camera: 'front' },
      { slot: 'tr', camera: 'right' },
      { slot: 'bl', camera: 'interior' },
      { slot: 'bc', camera: 'rear' },
      { slot: 'br', camera: null }
    ]),
    mirroredCameras: Object.freeze([])
  })
});

export function getDashcamProfile(profileId = TESLA_PROFILE_ID) {
  return DASHCAM_PROFILES[profileId] || DASHCAM_PROFILES[TESLA_PROFILE_ID];
}

export function getCameraLabel(profileId, cameraId) {
  const profile = getDashcamProfile(profileId);
  return profile.cameras[cameraId] || cameraId || '';
}

export function parseDashcamFilename(filename) {
  const name = String(filename || '');
  if (name.toLowerCase() === 'event.mp4') return null;

  for (const profile of Object.values(DASHCAM_PROFILES)) {
    const parsed = profile.parseFilename(name);
    if (parsed) return parsed;
  }
  return null;
}

export function detectDashcamProfile(filenames) {
  const counts = { [TESLA_PROFILE_ID]: 0, [GMC_PROFILE_ID]: 0 };
  let ignoredCount = 0;

  for (const filename of filenames || []) {
    const parsed = parseDashcamFilename(filename);
    if (parsed) counts[parsed.profileId]++;
    else ignoredCount++;
  }

  const matchedProfiles = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([profileId]) => profileId);

  return {
    profileId: matchedProfiles.length === 1 ? matchedProfiles[0] : null,
    mixed: matchedProfiles.length > 1,
    counts,
    ignoredCount
  };
}

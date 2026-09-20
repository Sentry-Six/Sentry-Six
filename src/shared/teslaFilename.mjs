export const TESLA_PROFILE_ID = 'tesla';

export function normalizeTeslaCamera(cameraRaw) {
  const camera = String(cameraRaw || '').toLowerCase();
  if (camera === 'left') return 'left_repeater';
  if (camera === 'right') return 'right_repeater';
  return camera;
}

export function parseTeslaFilename(filename) {
  const match = String(filename || '').match(
    /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)\.mp4$/i
  );
  if (!match) return null;
  return {
    profileId: TESLA_PROFILE_ID,
    timestampKey: `${match[1]}_${match[2]}`,
    date: match[1],
    camera: normalizeTeslaCamera(match[3])
  };
}

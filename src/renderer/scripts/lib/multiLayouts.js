// Multi-camera layouts are supplied by the active dashcam profile.
// The current player exposes six reusable slots: tl, tc, tr, bl, bc, br.

import { DASHCAM_PROFILES } from '../../../shared/dashcamProfiles.mjs';

function profileLayout(profileId, name) {
  const profile = DASHCAM_PROFILES[profileId];
  return {
    name,
    columns: 3,
    slots: profile.layoutSlots.map(({ slot, camera }) => ({
      slot,
      camera,
      label: camera ? profile.cameras[camera] : ''
    }))
  };
}

export const MULTI_LAYOUTS = {
  six_default: profileLayout('tesla', 'Default'),
  gm_surroundvision: profileLayout('gm_surroundvision', 'GM Surround Vision')
};

export const DEFAULT_MULTI_LAYOUT = 'six_default';

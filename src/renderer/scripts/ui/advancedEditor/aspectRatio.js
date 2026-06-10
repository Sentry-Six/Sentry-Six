// Detect each camera's native aspect ratio. Used to lock tile resize so
// Tesla footage doesn't appear stretched.
//
// HW3 cameras: 1280×960 (4:3 = 1.333)
// HW4 sides + pillars: 1448×938 (~1.543)
// HW4 front: 2896×1876 (~1.543)
//
// Fallbacks (used until videos load):
const FALLBACK_HW4_RATIO = 1448 / 938;  // ≈ 1.543
const FALLBACK_HW3_RATIO = 1280 / 960;  // ≈ 1.333

// Cameras default to HW4 ratio until we observe otherwise.
export const CAMERA_FALLBACK_RATIOS = {
    front: FALLBACK_HW4_RATIO,
    back: FALLBACK_HW4_RATIO,
    left_repeater: FALLBACK_HW4_RATIO,
    right_repeater: FALLBACK_HW4_RATIO,
    left_pillar: FALLBACK_HW4_RATIO,
    right_pillar: FALLBACK_HW4_RATIO,
};

// Given a Map of camera -> HTMLVideoElement, return camera -> aspect ratio.
// Cameras whose video has not yet emitted metadata fall back to HW4 defaults.
export function detectNativeAspects(videoElements) {
    const out = {};
    for (const camera of Object.keys(CAMERA_FALLBACK_RATIOS)) {
        const vid = videoElements?.get?.(camera);
        if (vid && vid.videoWidth > 0 && vid.videoHeight > 0) {
            out[camera] = vid.videoWidth / vid.videoHeight;
        } else {
            out[camera] = CAMERA_FALLBACK_RATIOS[camera];
        }
    }

    // Sniff HW3 — if the side cameras come back as 4:3, the whole vehicle is HW3.
    const sideRatio = out.left_repeater || out.right_repeater || out.back;
    if (sideRatio && Math.abs(sideRatio - FALLBACK_HW3_RATIO) < 0.05) {
        for (const c of Object.keys(out)) {
            out[c] = FALLBACK_HW3_RATIO;
        }
    }
    return out;
}

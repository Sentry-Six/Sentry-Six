// Pure snap math. No DOM access.
//
// Snap targets per tile T:
//   - corners + sides (left, right, top, bottom, centerX, centerY)
//   - side-midpoints: top-mid, bottom-mid, left-mid, right-mid
//
// For the dragged tile we test its 4 corners + 4 side-midpoints + center
// against every target. The smallest within-threshold delta wins per axis.
//
// Resize: only the moving edge(s) snap. Aspect lock is enforced AFTER snap
// so the lock can adjust the non-driving axis.

/**
 * @param {Object} opts
 * @param {string} opts.draggedId
 * @param {{x:number, y:number, w:number, h:number}} opts.proposed - in px
 * @param {string} opts.mode - 'drag' | 'resize-nw' | 'resize-n' | ...
 * @param {Array<{id:string, x:number, y:number, w:number, h:number}>} opts.otherTiles
 * @param {number} opts.canvasW
 * @param {number} opts.canvasH
 * @param {number} opts.threshold
 * @param {boolean} opts.aspectLocked
 * @param {number} opts.nativeAspect - w / h
 * @returns {{x:number, y:number, w:number, h:number, guides:{x:number|null, y:number|null}}}
 */
export function snapPositionAndSize(opts) {
    const { proposed, mode, otherTiles, canvasW, canvasH, threshold } = opts;

    // Build snap targets (in px). Matches layoutLab.js's detectSnap exactly:
    //   - canvas left edge, canvas right edge, canvas horizontal center
    //   - canvas top edge, canvas bottom edge, canvas vertical center
    //   - each sibling tile's left, right, centerX
    //   - each sibling tile's top, bottom, centerY
    // Notably we do NOT add "default-grid" targets for tiles that aren't
    // currently at their default position — those produced confusing snap
    // guides that pointed at empty space.
    const xTargets = [0, canvasW / 2, canvasW];
    const yTargets = [0, canvasH / 2, canvasH];

    for (const t of otherTiles) {
        xTargets.push(t.x, t.x + t.w, t.x + t.w / 2);
        yTargets.push(t.y, t.y + t.h, t.y + t.h / 2);
    }

    let { x, y, w, h } = proposed;

    let guideX = null;
    let guideY = null;

    if (mode === 'drag') {
        // Test left, centerX, right of dragged tile against all xTargets.
        const candidatesX = [
            { val: x,           apply: (v) => { x = v; } },                  // left
            { val: x + w / 2,   apply: (v) => { x = v - w / 2; } },          // center
            { val: x + w,       apply: (v) => { x = v - w; } },              // right
        ];
        const candidatesY = [
            { val: y,           apply: (v) => { y = v; } },
            { val: y + h / 2,   apply: (v) => { y = v - h / 2; } },
            { val: y + h,       apply: (v) => { y = v - h; } },
        ];

        const bestX = pickBestSnap(candidatesX, xTargets, threshold);
        if (bestX) { bestX.candidate.apply(bestX.target); guideX = bestX.target; }
        const bestY = pickBestSnap(candidatesY, yTargets, threshold);
        if (bestY) { bestY.candidate.apply(bestY.target); guideY = bestY.target; }

    } else if (mode.startsWith('resize-')) {
        const handle = mode.slice('resize-'.length);

        // Determine which edges are moving.
        const moveLeft  = handle.includes('w');
        const moveRight = handle.includes('e');
        const moveTop   = handle.includes('n');
        const moveBot   = handle.includes('s');

        if (moveLeft) {
            const candidates = [{ val: x, apply: (v) => { const dx = v - x; x = v; w -= dx; } }];
            const best = pickBestSnap(candidates, xTargets, threshold);
            if (best) { best.candidate.apply(best.target); guideX = best.target; }
        }
        if (moveRight) {
            const right = x + w;
            const candidates = [{ val: right, apply: (v) => { w = v - x; } }];
            const best = pickBestSnap(candidates, xTargets, threshold);
            if (best) { best.candidate.apply(best.target); guideX = best.target; }
        }
        if (moveTop) {
            const candidates = [{ val: y, apply: (v) => { const dy = v - y; y = v; h -= dy; } }];
            const best = pickBestSnap(candidates, yTargets, threshold);
            if (best) { best.candidate.apply(best.target); guideY = best.target; }
        }
        if (moveBot) {
            const bottom = y + h;
            const candidates = [{ val: bottom, apply: (v) => { h = v - y; } }];
            const best = pickBestSnap(candidates, yTargets, threshold);
            if (best) { best.candidate.apply(best.target); guideY = best.target; }
        }
    }

    // Aspect-ratio lock (for resize on cameras).
    if (opts.aspectLocked && mode.startsWith('resize-') && opts.nativeAspect > 0) {
        const ratio = opts.nativeAspect;  // w / h
        const handle = mode.slice('resize-'.length);

        if (handle === 'n' || handle === 's') {
            // Vertical edge moved → recompute width from new height.
            const newW = h * ratio;
            // Re-center horizontally so the tile expands/contracts symmetrically.
            x = x + (w - newW) / 2;
            w = newW;
        } else if (handle === 'e' || handle === 'w') {
            const newH = w / ratio;
            y = y + (h - newH) / 2;
            h = newH;
        } else {
            // Corner — pick driver based on which delta is larger.
            const origW = opts.proposed.w;
            const origH = opts.proposed.h;
            const wDelta = Math.abs(w - origW) / Math.max(1, origW);
            const hDelta = Math.abs(h - origH) / Math.max(1, origH);
            if (wDelta >= hDelta) {
                const newH = w / ratio;
                if (handle.includes('n')) y = (y + h) - newH;
                h = newH;
            } else {
                const newW = h * ratio;
                if (handle.includes('w')) x = (x + w) - newW;
                w = newW;
            }
        }
    }

    // Final clamp to canvas.
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (mode === 'drag') {
        // For drag, the tile moves as a whole — clamp position only,
        // never shrink w/h. (Resizing past an edge is a separate concern
        // handled in the resize branch below.)
        if (x < 0) x = 0;
        if (y < 0) y = 0;
        if (x + w > canvasW) x = canvasW - w;
        if (y + h > canvasH) y = canvasH - h;
    } else {
        // Resize: edges may need to shrink to fit inside the canvas.
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > canvasW) w = canvasW - x;
        if (y + h > canvasH) h = canvasH - y;
        if (w < 1) w = 1;
        if (h < 1) h = 1;
    }

    return { x, y, w, h, guides: { x: guideX, y: guideY } };
}

function pickBestSnap(candidates, targets, threshold) {
    let best = null;
    for (const c of candidates) {
        for (const t of targets) {
            const d = Math.abs(c.val - t);
            if (d <= threshold && (best === null || d < best.dist)) {
                best = { dist: d, candidate: c, target: t };
            }
        }
    }
    return best;
}

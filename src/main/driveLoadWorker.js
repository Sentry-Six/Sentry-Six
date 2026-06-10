/**
 * Worker thread: stream-parse the routes array out of a SentryUSB
 * drive-data.json and group it into drives.
 *
 * This runs OFF the Electron main process for a reason: the token loop is
 * CPU-bound for ~2 minutes on a 400MB file, and a busy main process can't
 * pump OS window messages — dragging the window stuttered the whole time
 * the parse ran on the main thread.
 *
 * Drive tags are parsed concurrently by driveTagsWorker.js; the main process
 * forwards the result here via postMessage, and grouping waits for it.
 *
 * Per-drive GPS points are returned as transferable Float64Arrays —
 * structured-cloning ~2M small JS arrays into the main process would block
 * it for seconds, while transferring ArrayBuffers is zero-copy.
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { pathToFileURL } = require('url');

let driveTags = {};
let tagsResolve;
const tagsReceived = new Promise((resolve) => { tagsResolve = resolve; });
const onParentMessage = (msg) => {
  if (msg && msg.type === 'driveTags') {
    driveTags = msg.driveTags || {};
    tagsResolve();
  }
};
parentPort.on('message', onParentMessage);

(async () => {
  try {
    const { parser } = require('stream-json');
    const { pick } = require('stream-json/filters/pick.js');
    const { streamArray } = require('stream-json/streamers/stream-array.js');
    const chainMod = require('stream-chain');
    const chain = chainMod.chain ?? chainMod.default;
    // driveGrouper is an ESM module — dynamic import works from CJS.
    const grouperUrl = new URL('../renderer/scripts/core/driveGrouper.js', pathToFileURL(__filename));
    const { groupStoreDataIntoDrives } = await import(grouperUrl.href);

    const t0 = Date.now();
    const routes = [];
    const pipeline = chain([
      fs.createReadStream(workerData.filePath),
      parser(),
      pick({ filter: /^routes$/i }),
      streamArray(),
    ]);
    let lastLog = Date.now();
    for await (const d of pipeline) {
      routes.push(d.value);
      if (routes.length % 1000 === 0 || Date.now() - lastLog > 2000) {
        parentPort.postMessage({ type: 'progress', count: routes.length, elapsedMs: Date.now() - t0 });
        lastLog = Date.now();
      }
    }
    parentPort.postMessage({ type: 'routesDone', count: routes.length, elapsedMs: Date.now() - t0 });

    await tagsReceived;

    const tGroup = Date.now();
    const { drives, driveCount, routeCount } = groupStoreDataIntoDrives({
      Routes: routes,
      DriveTags: driveTags,
    });

    // Flatten each drive's points ([lat,lng,0,speed,ap] tuples) into a
    // Float64Array and transfer the underlying buffers.
    const transfers = [];
    for (const d of drives) {
      const pts = d.points || [];
      const flat = new Float64Array(pts.length * 5);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const o = i * 5;
        flat[o] = p[0];
        flat[o + 1] = p[1];
        flat[o + 2] = p[2] || 0;
        flat[o + 3] = p[3] || 0;
        flat[o + 4] = p[4] || 0;
      }
      d.pointsBuf = flat;
      delete d.points;
      transfers.push(flat.buffer);
    }

    parentPort.postMessage({
      type: 'done',
      drives,
      driveCount,
      routeCount,
      routesLen: routes.length,
      groupMs: Date.now() - tGroup,
    }, transfers);
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  } finally {
    // The permanent 'message' listener pins the worker's event loop; remove
    // it so the thread exits instead of leaking a live isolate per load.
    parentPort.removeListener('message', onParentMessage);
  }
})();

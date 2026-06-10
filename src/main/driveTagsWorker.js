/**
 * Worker thread: stream-parse the drive-tags object out of a SentryUSB
 * drive-data.json. Runs concurrently with the main-process routes pass —
 * JSON tokenizing is CPU-bound, so doing this on another core hides the
 * cost of the second pass entirely (it used to add ~90s on a 400MB file).
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

(async () => {
  try {
    const { parser } = require('stream-json');
    const { pick } = require('stream-json/filters/pick.js');
    const { streamObject } = require('stream-json/streamers/stream-object.js');
    const chainMod = require('stream-chain');
    const chain = chainMod.chain ?? chainMod.default;

    const driveTags = {};
    const pipeline = chain([
      fs.createReadStream(workerData.filePath),
      parser(),
      pick({ filter: /^drive[_]?tags$/i }),
      streamObject(),
    ]);
    for await (const d of pipeline) {
      driveTags[d.key] = d.value;
    }
    parentPort.postMessage({ ok: true, driveTags });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.message || String(err) });
  }
})();

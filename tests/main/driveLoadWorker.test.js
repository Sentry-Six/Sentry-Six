// The drive-load worker must exit once it has posted its result.
// Its permanent parentPort 'message' listener (used to receive drive tags)
// pins the worker's event loop — without cleanup, every drive-data load
// leaks a live worker thread (a whole V8 isolate) for the session.

const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('drive load worker thread exits on its own after posting done', async () => {
  const tmp = path.join(os.tmpdir(), `dlw-test-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ routes: [] }));

  const worker = new Worker(
    path.resolve(__dirname, '../../src/main/driveLoadWorker.js'),
    { workerData: { filePath: tmp } }
  );

  // Listen for 'exit' from the start. When the main thread is busy, the worker
  // can post 'done' and exit before either event is handled; Node then
  // delivers the message and 'exit' in the same turn, so a listener added
  // after `await done` would miss the exit.
  const exited = new Promise((resolve) => worker.once('exit', () => resolve(true)));

  try {
    const done = new Promise((resolve, reject) => {
      worker.on('message', (m) => {
        if (m?.type === 'done') resolve(m);
        if (m?.type === 'error') reject(new Error(m.error));
      });
      worker.on('error', reject);
    });
    worker.postMessage({ type: 'driveTags', driveTags: {} });
    const result = await done;
    expect(result.driveCount).toBe(0);

    let timer;
    const exitedInTime = await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10000); }),
    ]);
    clearTimeout(timer);
    expect(exitedInTime).toBe(true);
  } finally {
    await worker.terminate();
    fs.unlinkSync(tmp);
  }
}, 15000);

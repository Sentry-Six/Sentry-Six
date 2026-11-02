// Sentry USB drive-data.json is stream-parsed with stream-json in two workers:
// driveLoadWorker.js picks the top-level routes array, and driveTagsWorker.js
// picks the top-level drive tags object. These tests pin the parts of the
// stream-json API those workers rely on (parser, pick with a RegExp filter,
// streamArray, streamObject, and stream-chain's chain).

const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '../../src/main');

const SAMPLE = {
  version: 3,
  // A nested "routes" key must not be picked: only the top-level one counts.
  meta: { routes: [{ File: 'nested' }], drive_tags: { nested: ['no'] } },
  Routes: [
    { File: '2026-01-02_10-00-00-front.mp4', Points: [[53.5, -113.5, 0, 50, 0]] },
    { File: '2026-01-02_10-01-00-front.mp4', Points: [] },
    { File: '2026-01-02_10-02-00-front.mp4', Points: [] },
  ],
  DriveTags: {
    'drive-a': ['Commute'],
    'drive-b': { label: 'Road trip', color: '#ff8800' },
  },
};

function writeSample(label) {
  const file = path.join(os.tmpdir(), `drive-data-${label}-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(SAMPLE));
  return file;
}

test('drive tags worker picks only the top-level drive tags object', async () => {
  const file = writeSample('tags');
  const worker = new Worker(path.join(SRC, 'driveTagsWorker.js'), { workerData: { filePath: file } });
  try {
    const msg = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(msg).toEqual({ ok: true, driveTags: SAMPLE.DriveTags });
  } finally {
    await worker.terminate();
    fs.unlinkSync(file);
  }
}, 15000);

test('drive load worker streams every element of the top-level routes array', async () => {
  const file = writeSample('routes');
  const worker = new Worker(path.join(SRC, 'driveLoadWorker.js'), { workerData: { filePath: file } });
  try {
    const routesDone = await new Promise((resolve, reject) => {
      worker.on('message', (m) => {
        if (m?.type === 'routesDone') resolve(m);
        if (m?.type === 'error') reject(new Error(m.error));
      });
      worker.once('error', reject);
    });
    expect(routesDone.count).toBe(SAMPLE.Routes.length);

    const done = await new Promise((resolve, reject) => {
      worker.on('message', (m) => {
        if (m?.type === 'done') resolve(m);
        if (m?.type === 'error') reject(new Error(m.error));
      });
      worker.postMessage({ type: 'driveTags', driveTags: SAMPLE.DriveTags });
    });
    expect(done.routesLen).toBe(SAMPLE.Routes.length);
  } finally {
    await worker.terminate();
    fs.unlinkSync(file);
  }
}, 15000);

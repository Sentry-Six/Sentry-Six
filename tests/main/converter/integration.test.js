'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createConverterRuntime } = require('../../../src/main/converter/runtime');
const { createEncoderPlanner } = require('../../../src/main/converter/encoderPlanner');
const { createConverterAdapters } = require('../../../src/main/converter/converterAdapters');
const { createConverterJobService } = require('../../../src/main/converter/jobService');
const { extractH264TelemetryTimeline } = require('../../../src/main/converter/telemetryTimeline');
const { injectH265Telemetry, inspectH265Telemetry } = require('../../../src/main/converter/h265Telemetry');
const { inspectAv1Telemetry } = require('../../../src/main/converter/av1Telemetry');
const { isWithinProfile } = require('../../../src/main/converter/contracts');
const { createFileTransaction } = require('../../../src/main/converter/staging');
const { parseMp4, findBoxes } = require('../../../src/main/converter/mp4');
const { assertFullDecode, createTeslaH264Fixture, locateBundledTools,
  measureQuality, probeFramePts, probeRequiredEncodersSync, probeVideo, runProcess } = require('./ffmpegFixtures');
const { h265Mp4, hevcNal, lengthPrefixedSample } = require('./fixtureBuilders');

jest.setTimeout(180_000);
const encoderGate = probeRequiredEncodersSync();
const describeRealEncoders = encoderGate.available ? describe : describe.skip;

function ownedFileRemover() {
  return { atomicOwnershipCheck: true, guardedRemoval: true, async remove({ target }) {
    try { await fs.promises.unlink(target); return { removed: true, missing: false }; }
    catch (error) {
      if (error?.code === 'ENOENT') return { removed: false, missing: true };
      throw error;
    }
  } };
}

function noReplacePromoter() {
  return { atomicNoReplace: true, async promote({ from, to, removeSource }) {
    if (removeSource) throw new Error('The integration adapter does not implement replacement');
    const temporary = `${to}.integration-promote-${process.pid}-${Date.now()}`;
    await fs.promises.copyFile(from, temporary, fs.constants.COPYFILE_EXCL);
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'r+');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.link(temporary, to);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
    }
    return { atomicNoReplace: true, sourceRemoved: false };
  } };
}

function telemetryPattern(name, count = 48) {
  const event = (index) => Buffer.from([0x20, index]);
  if (name === 'driving') return Array.from({ length: count }, (_, index) => event(index));
  if (name === 'parked') return Array(count).fill(null);
  if (name === 'parked-to-driving') return Array.from({ length: count }, (_, index) => index < count / 2 ? null : event(index));
  if (name === 'driving-to-parked') return Array.from({ length: count }, (_, index) => index < count / 2 ? event(index) : null);
  if (name === 'multiple-gaps') return Array.from({ length: count }, (_, index) => (
    (index >= Math.floor(count / 6) && index < Math.floor(count / 3))
      || (index >= Math.floor(count / 2) && index < Math.floor(count * 3 / 4)) ? null : event(index)
  ));
  throw new Error(`Unknown telemetry pattern: ${name}`);
}

function expectedFingerprints(timeline) {
  return timeline.samples.map((sample) => sample.seiNals.map((nal) => nal.fingerprint));
}

function inspectOutput(codec, bytes) {
  const inspected = codec === 'h265' ? inspectH265Telemetry(bytes) : inspectAv1Telemetry(bytes);
  return {
    samples: inspected.samples,
    fingerprints: inspected.samples.map((sample) => sample.telemetryFingerprints),
    markers: inspected.samples.map((sample) => sample.pictureMarkerCount)
  };
}

describe('converter bundled-FFmpeg integration', () => {
  test('locates the bundled FFmpeg and FFprobe pair', async () => {
    await expect(locateBundledTools()).resolves.toEqual(expect.objectContaining({ ffmpegPath: expect.any(String), ffprobePath: expect.any(String) }));
  });

  test('reports an explicit environment reason when real encoder coverage is skipped', () => {
    if (!encoderGate.available) console.warn(`SKIP converter integration: ${encoderGate.reason}`);
    expect(encoderGate.reason === null || encoderGate.reason.startsWith('required encoder probe failed')).toBe(true);
  });
});

describeRealEncoders(`real pipeline (${encoderGate.reason || 'required CPU encoders proven'})`, () => {
  let root;
  let tools;
  beforeAll(async () => {
    tools = await locateBundledTools();
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-converter-integration-'));
  });
  afterAll(async () => { if (root) await fs.promises.rm(root, { recursive: true, force: true }); });

  test('records real platform hardware candidates and proven selections', async () => {
    const attempts = [];
    const planner = createEncoderPlanner({ platform: process.platform, ffmpegPath: tools.ffmpegPath,
      runProbe: async (command, args, options) => {
        const codecIndex = args.indexOf('-c:v');
        if (codecIndex >= 0) attempts.push(args[codecIndex + 1]);
        return runProcess(command, args, options);
      } });
    const selected = { h265: await planner.select('h265'), av1: await planner.select('av1') };
    expect(selected.h265.codec).toEqual(expect.any(String));
    expect(selected.av1.codec).toEqual(expect.any(String));
    console.info(`ENCODER_LADDER attempted=${[...new Set(attempts)].join(',')} selected=h265:${selected.h265.codec},av1:${selected.av1.codec} `
      + `matrixCpu=h265:${encoderGate.selected.h265},av1:${encoderGate.selected.av1}`);
  });

  const cases = [
    ['h265', 'conservative', 'driving', null],
    ['h265', 'balanced', 'parked-to-driving', null],
    ['h265', 'aggressive', 'multiple-gaps', null],
    ['av1', 'conservative', 'parked', null],
    ['av1', 'balanced', 'driving-to-parked', null],
    ['av1', 'aggressive', 'multiple-gaps', null],
    ['h265', 'aggressive', 'multiple-gaps', 'default-success'],
    ['av1', 'aggressive', 'multiple-gaps', 'default-success'],
    ['h265', 'balanced', 'parked-to-driving', 'default-refusal']
  ];

  test.each(cases)('%s/%s preserves %s telemetry through the real runtime (%s)', async (codec, profileId, patternName, filesystemMode) => {
    const caseRoot = path.join(root, `${codec}-${profileId}-${filesystemMode || 'injected'}`);
    const sourceRoot = path.join(caseRoot, 'source');
    const sourceFolder = path.join(sourceRoot, 'RecentClips');
    const destinationRoot = path.join(caseRoot, 'destination');
    const userDataPath = path.join(caseRoot, 'user-data');
    await Promise.all([fs.promises.mkdir(sourceFolder, { recursive: true }),
      fs.promises.mkdir(destinationRoot, { recursive: true }), fs.promises.mkdir(userDataPath, { recursive: true })]);
    const filename = '2026-08-30_12-00-00-front.mp4';
    const sourcePath = path.join(sourceFolder, filename);
    const durationSeconds = filesystemMode === 'default-success' ? 32 : 16;
    const frameCount = durationSeconds * 12;
    const fixture = await createTeslaH264Fixture({ ffmpegPath: tools.ffmpegPath, outputPath: sourcePath,
      telemetryPattern: telemetryPattern(patternName, frameCount), durationSeconds,
      spatialNoise: 16 });
    const originalBytes = await fs.promises.readFile(sourcePath);
    const sourceTimeline = extractH264TelemetryTimeline(originalBytes);
    const selections = [];
    const mediaDiagnostics = [];
    const spawnCalls = [];
    const recordingSpawn = (command, args, options) => {
      spawnCalls.push({ command, args: [...args] });
      return spawn(command, args, options);
    };
    const runtime = await createConverterRuntime({
      userDataPath, tempPath: caseRoot, ffmpegPath: tools.ffmpegPath, ffprobePath: tools.ffprobePath,
      spawn: recordingSpawn, processTimeoutMs: 120_000,
      // The broad codec/profile matrix exercises retries through test-only
      // transaction capabilities. Separate default-adapter cases below prove
      // the stock no-replace publication and fail-closed cleanup behavior.
      ...(!filesystemMode ? { removeOwned: ownedFileRemover(), renameExclusive: noReplacePromoter() } : {}),
      ...(filesystemMode === 'default-refusal' ? { removeOwned: { atomicOwnershipCheck: false, async remove() { return { failed: true }; } } } : {}),
      factories: { createEncoderPlanner(options) {
        const real = createEncoderPlanner(options);
        return { async select(selectedCodec) {
          const selected = await real.selectCpuFallback(selectedCodec);
          selections.push(selected);
          return selected;
        }, selectCpuFallback: real.selectCpuFallback };
      }, createConverterAdapters(options) {
        const real = createConverterAdapters(options);
        return { ...real, writers: { ...real.writers,
          async av1(operation) {
            const before = (await fs.promises.stat(operation.candidatePath)).size;
            const result = await real.writers.av1(operation);
            mediaDiagnostics.push({ stage: 'av1-writer', before, after: (await fs.promises.stat(operation.candidatePath)).size });
            return result;
          }
        }, async verifier(operation) {
          const result = await real.verifier(operation);
          mediaDiagnostics.push({ stage: 'verifier', ok: result.ok, reason: result.reason,
            sourceBytes: result.sourceBytes, outputBytes: result.outputBytes, details: result.details });
          return result;
        } };
      } }
    });
    const jobId = await runtime.service.start({ sourceRoot, destinationRoot, codec, profileId, networkMode: 'direct',
      outputMode: 'separate', replacementConfirmed: false, includedGroups: ['RecentClips'] });
    await runtime.service.whenIdle(jobId);
    const job = await runtime.service.get(jobId);
    const outputPath = path.join(destinationRoot, 'RecentClips', filename);
    const nativeCleanup = process.platform === 'win32' && filesystemMode !== 'default-refusal';
    if (filesystemMode) {
      expect(runtime.capabilities).toEqual(expect.objectContaining({
        separatePublication: nativeCleanup ? 'native-atomic' : 'hardlink-cleanup-pending',
        ownershipCleanup: nativeCleanup ? 'atomic-expected-ownership' : 'unavailable', replacement: nativeCleanup ? 'available' : 'unavailable'
      }));
      if (!nativeCleanup) {
      const callsBeforeReplacement = spawnCalls.length;
      const replaceId = await runtime.service.start({ sourceRoot, destinationRoot: null, codec, profileId,
        networkMode: 'direct', outputMode: 'replace', replacementConfirmed: true, includedGroups: ['RecentClips'] });
      await runtime.service.whenIdle(replaceId);
      const refused = await runtime.service.get(replaceId);
      expect(refused.items).toEqual([expect.objectContaining({ state: 'failed',
        failure: expect.objectContaining({ code: 'atomic-promotion-unsupported' }) })]);
      expect(spawnCalls.slice(callsBeforeReplacement).every(({ command }) => command === tools.ffprobePath)).toBe(true);
      expect(await fs.promises.readFile(sourcePath)).toEqual(originalBytes);
      }
    }
    if (filesystemMode === 'default-refusal') {
      expect(mediaDiagnostics).toEqual([expect.objectContaining({ ok: false, reason: 'profile-size' })]);
      expect(job.items).toEqual([expect.objectContaining({ state: 'failed', attempts: 1, resultCode: 'cleanup-pending',
        failure: expect.objectContaining({ code: 'profile-size' }) })]);
      expect(job.summary.files).toBe(0);
      await expect(fs.promises.lstat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const persisted = await runtime.store.load(jobId);
      const retainedPath = persisted.items[0].ownedPaths.encodedCandidate;
      expect((await fs.promises.stat(retainedPath)).size).toBeGreaterThan(0);
      await expect(runtime.service.retryFailed(jobId)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect((await runtime.store.load(jobId)).items[0].ownedPaths.encodedCandidate).toBe(retainedPath);
      expect(await fs.promises.readFile(sourcePath)).toEqual(originalBytes);
      await runtime.shutdown();
      return;
    }
    if (job.items[0]?.state !== 'completed') {
      const sourceProbe = await runProcess(tools.ffprobePath, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=bit_rate,width,height,r_frame_rate,nb_frames:format=bit_rate,duration,size', '-of', 'json', sourcePath]);
      const encodeCall = spawnCalls.find(({ args }) => args.includes('-progress'));
      console.error(JSON.stringify({ codec, profileId, job, mediaDiagnostics, encodeArgs: encodeCall?.args,
        sourceProbe: JSON.parse(sourceProbe.stdout) }, null, 2));
    }
    expect(job.items).toEqual([expect.objectContaining({ state: 'completed',
      resultCode: filesystemMode && !nativeCleanup ? 'completed-cleanup-pending' : 'converted', encoder: encoderGate.selected[codec], outputPath })]);
    expect(await fs.promises.readFile(sourcePath)).toEqual(originalBytes);
    if (filesystemMode && !nativeCleanup) {
      expect(job.items[0].attempts).toBe(1);
      const persisted = await runtime.store.load(jobId);
      expect(persisted.items[0].ownedPaths.publicationSnapshot).toEqual(expect.any(String));
      expect(path.dirname(path.dirname(persisted.items[0].ownedPaths.publicationSnapshot))).toBe(caseRoot);
      const [partialStat, finalStat] = await Promise.all([
        fs.promises.lstat(persisted.items[0].ownedPaths.destinationPartial, { bigint: true }),
        fs.promises.lstat(outputPath, { bigint: true })
      ]);
      expect([partialStat.dev, partialStat.ino]).toEqual([finalStat.dev, finalStat.ino]);
    }
    expect(selections).toEqual([expect.objectContaining({ codec: encoderGate.selected[codec], hardware: false })]);

    const metadata = await probeVideo(tools.ffprobePath, outputPath);
    const stream = metadata.streams[0];
    expect([stream.codec_name, stream.codec_tag_string]).toEqual(codec === 'h265' ? ['hevc', 'hvc1'] : ['av1', 'av01']);
    expect(Number(stream.nb_read_frames)).toBe(fixture.frameCount);
    expect(Number(stream.duration)).toBeCloseTo(fixture.durationSeconds, 3);
    expect([stream.width, stream.height]).toEqual([320, 180]);
    const [sourcePts, outputPts] = await Promise.all([
      probeFramePts(tools.ffprobePath, sourcePath),
      probeFramePts(tools.ffprobePath, outputPath)
    ]);
    expect(sourcePts).toHaveLength(fixture.frameCount);
    expect(outputPts).toHaveLength(fixture.frameCount);
    expect(sourcePts[0]).toBeCloseTo(0, 6);
    expect(outputPts[0]).toBeCloseTo(0, 6);
    for (let index = 0; index < fixture.frameCount; index += 1) {
      expect(outputPts[index]).toBeCloseTo(sourcePts[index], 5);
      if (index > 0) expect(outputPts[index] - outputPts[index - 1]).toBeCloseTo(1 / 12, 5);
    }
    await assertFullDecode(tools.ffmpegPath, outputPath);
    const outputBytes = await fs.promises.readFile(outputPath);
    const inspected = inspectOutput(codec, outputBytes);
    expect(inspected.samples).toHaveLength(fixture.frameCount);
    expect(inspected.markers.every((count) => count === 1)).toBe(true);
    expect(inspected.fingerprints).toEqual(expectedFingerprints(sourceTimeline));
    expect(isWithinProfile(fixture.sourceBytes, outputBytes.length, profileId)).toBe(true);
    const events = inspected.fingerprints.reduce((sum, entries) => sum + entries.length, 0);
    const savings = ((fixture.sourceBytes - outputBytes.length) / fixture.sourceBytes * 100).toFixed(2);
    let quality = '';
    if (profileId === 'balanced') {
      const metrics = await measureQuality(tools.ffmpegPath, sourcePath, outputPath);
      // 45 dB PSNR with SSIM >= 0.99 is a deliberately strict transparent-quality
      // floor for this deterministic moving/detail fixture, not merely command success.
      expect(metrics.ssim).toBeGreaterThanOrEqual(0.99);
      expect(metrics.psnr).toBeGreaterThanOrEqual(45);
      quality = `SSIM=${metrics.ssim.toFixed(6)} PSNR=${metrics.psnr.toFixed(6)}`;
    }
    const writerDiagnostic = mediaDiagnostics.find((entry) => entry.stage === 'av1-writer');
    console.info(`REAL_MATRIX ${codec}/${profileId} pattern=${patternName} encoder=${job.items[0].encoder} `
      + `attempts=${job.items[0].attempts} sourceBytes=${fixture.sourceBytes} outputBytes=${outputBytes.length} `
      + `savings=${savings}% codec=${stream.codec_name}/${stream.codec_tag_string} frames=${stream.nb_read_frames} `
      + `duration=${stream.duration}s pts=start:${outputPts[0].toFixed(6)},step:${(outputPts[1] - outputPts[0]).toFixed(6)} `
      + `events=${events} markers=${inspected.markers.length} strictDecode=pass `
      + `rawBytes=${writerDiagnostic?.before || outputBytes.length} telemetryOverhead=${writerDiagnostic ? writerDiagnostic.after - writerDiagnostic.before : 0} ${quality}`);

    if (filesystemMode === 'default-success' && process.platform === 'win32') {
      const replaceId = await runtime.service.start({ sourceRoot, destinationRoot: null, codec, profileId,
        networkMode: 'direct', outputMode: 'replace', replacementConfirmed: true, includedGroups: ['RecentClips'] });
      await runtime.service.whenIdle(replaceId);
      const replaced = await runtime.service.get(replaceId);
      expect(replaced.items).toEqual([expect.objectContaining({ state: 'completed', resultCode: 'converted' })]);
      const installed = await fs.promises.readFile(sourcePath);
      expect(inspectOutput(codec, installed).fingerprints).toEqual(expectedFingerprints(sourceTimeline));
      await assertFullDecode(tools.ffmpegPath, sourcePath);
      expect((await fs.promises.readdir(sourceFolder)).filter(name => /^(TEMP-|BACKUP-)/.test(name))).toEqual([]);
    }
    await runtime.shutdown();
  });

  test('copies event assets, skips real H265/AV1 inputs, and resumes after a simulated share reconnect', async () => {
    const caseRoot = path.join(root, 'assets-skips-reconnect');
    const sourceRoot = path.join(caseRoot, 'source');
    const eventRoot = path.join(sourceRoot, 'SentryClips', '2026-08-30_12-00-00');
    const destinationRoot = path.join(caseRoot, 'destination');
    const userDataPath = path.join(caseRoot, 'user-data');
    await Promise.all([fs.promises.mkdir(eventRoot, { recursive: true }), fs.promises.mkdir(destinationRoot, { recursive: true }),
      fs.promises.mkdir(userDataPath, { recursive: true })]);
    const eventBytes = Buffer.from('{"reason":"integration"}');
    const thumbnailBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await fs.promises.writeFile(path.join(eventRoot, 'event.json'), eventBytes);
    await fs.promises.writeFile(path.join(eventRoot, 'thumb.png'), thumbnailBytes);
    const h265Path = path.join(eventRoot, '2026-08-30_12-00-00-front.mp4');
    const av1Path = path.join(eventRoot, '2026-08-30_12-00-00-back.mp4');
    const h265Encode = await runProcess(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=96x64:rate=4', '-frames:v', '4', '-an',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-bf', '0', '-tag:v', 'hvc1', h265Path]);
    const av1Encode = await runProcess(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=96x64:rate=4', '-frames:v', '4', '-an',
      '-c:v', encoderGate.selected.av1, ...(encoderGate.selected.av1 === 'libaom-av1' ? ['-cpu-used', '8'] : ['-preset', '12']),
      '-tag:v', 'av01', av1Path]);
    expect([h265Encode.status, av1Encode.status]).toEqual([0, 0]);

    let disconnectOnce = true;
    const checks = [];
    const checkOptions = [];
    const events = [];
    const runtime = await createConverterRuntime({
      userDataPath, tempPath: os.tmpdir(), ffmpegPath: tools.ffmpegPath, ffprobePath: tools.ffprobePath, spawn,
      removeOwned: ownedFileRemover(), renameExclusive: noReplacePromoter(),
      network: { isRetryable: (error) => error?.code === 'ENETDOWN', checkPath: async (target, options) => {
        checks.push(target);
        checkOptions.push(options);
        return checks.length > 1;
      } },
      factories: {
        createFileTransaction(options) {
          const real = createFileTransaction(options);
          return { ...real, async copyAsset(operation) {
            if (disconnectOnce) {
              disconnectOnce = false;
              throw Object.assign(new Error('simulated share disconnect'), { code: 'ENETDOWN' });
            }
            return real.copyAsset(operation);
          } };
        },
        createConverterJobService(options) {
          return createConverterJobService({ ...options, clock: { now: Date.now, sleep: async () => {} },
            networkBackoff: { initialMs: 1, maximumMs: 2 } });
        }
      }
    });
    runtime.service.subscribe((event) => events.push(event.type));
    const id = await runtime.service.start({ sourceRoot, destinationRoot, codec: 'h265', profileId: 'balanced',
      networkMode: 'direct', outputMode: 'separate', replacementConfirmed: false, includedGroups: ['SentryClips'] });
    await runtime.service.whenIdle(id);
    const job = await runtime.service.get(id);
    expect(job.items.filter((item) => item.kind === 'video').map(({ state, resultCode }) => [state, resultCode]))
      .toEqual([['skipped', 'already-converted'], ['skipped', 'already-converted']]);
    expect(job.items.filter((item) => item.kind === 'asset').every((item) => item.state === 'completed')).toBe(true);
    expect(await fs.promises.readFile(path.join(destinationRoot, 'SentryClips', '2026-08-30_12-00-00', 'event.json'))).toEqual(eventBytes);
    expect(await fs.promises.readFile(path.join(destinationRoot, 'SentryClips', '2026-08-30_12-00-00', 'thumb.png'))).toEqual(thumbnailBytes);
    expect(events).toEqual(expect.arrayContaining(['paused_network', 'network_reconnected']));
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(checks)).toEqual(new Set([destinationRoot]));
    for (const options of checkOptions) expect(options).toEqual({ allowAncestor: true, signal: expect.any(AbortSignal) });
  });
});

describe('converter transaction integration', () => {
  let root;
  beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-converter-transactions-')); });
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

  function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
  async function metadata(target, nonce, state = 'owned', journal) {
    const stat = await fs.promises.lstat(target, { bigint: true });
    const bytes = await fs.promises.readFile(target);
    return { path: target, nonce, state, size: bytes.length, sha256: digest(bytes), device: String(stat.dev), inode: String(stat.ino),
      ...(journal ? { journal } : {}) };
  }

  test('never overwrites a destination collision', async () => {
    const tempRoot = path.join(root, 'temp');
    const destination = path.join(root, 'destination', 'clip.mp4');
    const artifactPath = path.join(root, 'snapshot.mp4');
    await Promise.all([fs.promises.mkdir(tempRoot), fs.promises.mkdir(path.dirname(destination), { recursive: true })]);
    await fs.promises.writeFile(destination, Buffer.from('existing destination'));
    const bytes = Buffer.from('verified candidate');
    await fs.promises.writeFile(artifactPath, bytes);
    const artifact = { path: artifactPath, token: 'collision-token', size: bytes.length, sha256: digest(bytes) };
    const tx = createFileTransaction({ fs, pathApi: path, tempRoot, removeOwned: ownedFileRemover(),
      renameExclusive: noReplacePromoter(), validatePublicationArtifact: async () => true,
      persistTransaction: async () => {} });
    await expect(tx.publishSeparate({ publicationArtifact: artifact, destination, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_COLLISION' });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('existing destination');
  });

  test('resumes an interrupted destination copy from its exact committed boundary', async () => {
    const tempRoot = path.join(root, 'temp');
    const destination = path.join(root, 'destination', 'clip.mp4');
    await Promise.all([fs.promises.mkdir(tempRoot), fs.promises.mkdir(path.dirname(destination), { recursive: true })]);
    const bytes = Buffer.alloc(1_250_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const artifactPath = path.join(root, 'snapshot.mp4');
    await fs.promises.writeFile(artifactPath, bytes);
    const artifact = { path: artifactPath, token: 'resume-token', size: bytes.length, sha256: digest(bytes) };
    const nonce = 'resume-nonce';
    const partial = `${destination}.sentry-six-job-1-item-1-${nonce}.partial`;
    const committedBytes = bytes.subarray(0, 333_333);
    await fs.promises.writeFile(partial, committedBytes);
    const committed = { size: committedBytes.length, sha256: digest(committedBytes) };
    const ownedPaths = { publicationSnapshot: artifactPath, destinationPartial: partial };
    const ownedArtifacts = {
      publicationSnapshot: await metadata(artifactPath, 'snapshot-nonce'),
      destinationPartial: await metadata(partial, nonce, 'writing', { committed, pending: null })
    };
    const steps = [];
    const resumedWrites = [];
    const instrumentedPromises = new Proxy(fs.promises, { get(target, property) {
      if (property !== 'open') {
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (targetPath, flags, ...rest) => {
        const handle = await target.open(targetPath, flags, ...rest);
        if (targetPath !== partial || flags !== 'r+') return handle;
        return new Proxy(handle, { get(handleTarget, handleProperty) {
          if (handleProperty !== 'write') {
            const value = handleTarget[handleProperty];
            return typeof value === 'function' ? value.bind(handleTarget) : value;
          }
          return async (...writeArgs) => {
            const result = await handleTarget.write(...writeArgs);
            resumedWrites.push({ position: writeArgs[3], bytesWritten: result.bytesWritten });
            return result;
          };
        } });
      };
    } });
    const instrumentedFs = new Proxy(fs, { get(target, property) {
      if (property === 'promises') return instrumentedPromises;
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const tx = createFileTransaction({ fs: instrumentedFs, pathApi: path, tempRoot, removeOwned: ownedFileRemover(),
      renameExclusive: noReplacePromoter(), validatePublicationArtifact: async () => true,
      persistTransaction: async (snapshot) => steps.push(snapshot.step) });
    const result = await tx.recoverCopy({ action: 'resume-copy', destination, jobId: 'job-1', itemId: 'item-1',
      ownedPaths, ownedArtifacts, publicationArtifact: artifact });
    expect(digest(await fs.promises.readFile(destination))).toBe(artifact.sha256);
    expect(result.finalPath).toBe(destination);
    expect((await fs.promises.stat(destination)).size).toBe(bytes.length);
    expect(resumedWrites.length).toBeGreaterThan(0);
    expect(resumedWrites[0].position).toBe(committedBytes.length);
    expect(resumedWrites.every(({ position }) => position >= committedBytes.length)).toBe(true);
    expect(resumedWrites.reduce((sum, { bytesWritten }) => sum + bytesWritten, 0))
      .toBe(bytes.length - committedBytes.length);
    expect(steps).toEqual(expect.arrayContaining(['copy-recovery-partial-chunk-committed', 'copy-recovery-promotion-intent']));
  });

  test('exercises synthetic co64 telemetry rewriting without a huge allocation', () => {
    const source = h265Mp4({ samples: [lengthPrefixedSample([hevcNal(19, [0x41])], 4)], co64: true,
      extendedMoov: true, extendedMdat: true });
    const output = injectH265Telemetry(source, [{ ptsUs: 0, pictureMarker: true, seiNals: [] }]);
    expect(findBoxes(parseMp4(output), 'co64')).toHaveLength(1);
    expect(output.length).toBeLessThan(10_000);
    expect(inspectH265Telemetry(output).samples[0].pictureMarkerCount).toBe(1);
  });
});

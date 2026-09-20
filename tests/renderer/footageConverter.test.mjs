import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createFootageConverterController,
  createSidebarPanelSwitcher,
  formatBytes
} from '../../src/renderer/scripts/features/footageConverter.js';

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  constructor({ value = '', checked = false, dataset = {} } = {}) {
    this.value = value;
    this.checked = checked;
    this.dataset = dataset;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.ownerDocument = {
      createElement: () => new FakeElement()
    };
  }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  async dispatch(type) {
    const overrides = arguments[1] || {};
    for (const listener of this.listeners.get(type) || []) {
      await listener({ currentTarget: this, target: this, preventDefault() {}, ...overrides });
    }
  }
  async click() { await this.dispatch('click'); }
  focus() { this.focused = true; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
}

function option(dataset, checked = false) {
  return new FakeElement({ dataset, checked });
}

function makeElements() {
  const orderRows = ['SavedClips', 'SentryClips', 'RecentClips'].map((group) => ({
    group,
    row: new FakeElement({ dataset: { converterOrderGroup: group } }),
    rank: new FakeElement(),
    up: new FakeElement({ dataset: { converterOrderMove: 'up', converterOrderGroup: group } }),
    down: new FakeElement({ dataset: { converterOrderMove: 'down', converterOrderGroup: group } })
  }));
  return {
    sourcePath: new FakeElement(),
    destinationPath: new FakeElement(),
    sourceButton: new FakeElement(),
    destinationButton: new FakeElement(),
    groupOptions: [
      option({ converterGroup: 'RecentClips' }, true),
      option({ converterGroup: 'SavedClips' }, true),
      option({ converterGroup: 'SentryClips' }, true)
    ],
    orderRows,
    codecOptions: [option({ converterCodec: 'h265' }, true), option({ converterCodec: 'av1' })],
    profileOptions: [
      option({ converterProfile: 'conservative' }),
      option({ converterProfile: 'balanced' }, true),
      option({ converterProfile: 'aggressive' })
    ],
    outputOptions: [option({ converterOutput: 'separate' }, true), option({ converterOutput: 'replace' })],
    replaceOption: new FakeElement(),
    replaceInput: new FakeElement({ value: 'replace' }),
    replaceCapability: new FakeElement(),
    replacementConfirmation: new FakeElement(),
    replacementWarning: new FakeElement(),
    replacementConfirmationRow: new FakeElement(),
    estimate: new FakeElement(),
    startButton: new FakeElement(),
    pauseButton: new FakeElement(),
    resumeButton: new FakeElement(),
    cancelButton: new FakeElement(),
    retryButton: new FakeElement(),
    dismissButton: new FakeElement(),
    status: new FakeElement(),
    currentFile: new FakeElement(),
    currentProgress: new FakeElement(),
    currentProgressFill: new FakeElement(),
    elapsed: new FakeElement(),
    countDiscovered: new FakeElement(),
    countCompleted: new FakeElement(),
    countSkipped: new FakeElement(),
    countFailed: new FakeElement(),
    countWaiting: new FakeElement(),
    processedBytes: new FakeElement(),
    reconnectBanner: new FakeElement(),
    cleanupBanner: new FakeElement(),
    errorRows: new FakeElement(),
    pipeline: new FakeElement(),
    pipelineStages: [
      new FakeElement({ dataset: { phase: 'discover' } }),
      new FakeElement({ dataset: { phase: 'encode' } }),
      new FakeElement({ dataset: { phase: 'verify' } }),
      new FakeElement({ dataset: { phase: 'save' } })
    ],
    summary: new FakeElement(),
    summaryRetention: new FakeElement(),
    summaryFiles: new FakeElement(),
    summarySkipped: new FakeElement(),
    summaryFailed: new FakeElement(),
    summarySource: new FakeElement(),
    summaryOutput: new FakeElement(),
    summarySaved: new FakeElement(),
    summaryPercent: new FakeElement(),
    summaryAssets: new FakeElement(),
    summaryElapsed: new FakeElement(),
    summaryGroups: new FakeElement()
  };
}

function emptyCounters() {
  return {
    files: 0,
    sourceVideoBytes: 0,
    outputVideoBytes: 0,
    savedBytes: 0,
    copiedAssetBytes: 0,
    groups: {
      RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
      SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
      SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
    }
  };
}

function activeSnapshot(overrides = {}) {
  return {
    id: 'job-1',
    state: 'encoding',
    revision: 4,
    createdAt: 1_000,
    updatedAt: 6_000,
    activeItemId: 'item-2',
    config: {
      sourceRoot: 'D:\\TeslaCam',
      destinationRoot: 'E:\\Converted',
      codec: 'h265',
      profileId: 'balanced',
      networkMode: 'auto',
      outputMode: 'separate',
      includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
      replacementConfirmed: false
    },
    items: [
      { id: 'item-1', state: 'completed', relativePath: 'RecentClips/first-front.mp4', sourceBytes: 1_000, outputBytes: 800 },
      { id: 'item-2', state: 'processing', relativePath: 'SentryClips/event/front.mp4', sourceBytes: 2_000 },
      { id: 'item-3', state: 'queued', relativePath: 'SavedClips/next-front.mp4', sourceBytes: 3_000 },
      { id: 'item-4', state: 'skipped', relativePath: 'RecentClips/already-hevc.mp4', sourceBytes: 4_000 },
      { id: 'item-5', state: 'failed', relativePath: 'SentryClips/bad.mp4', sourceBytes: 5_000, failure: { code: 'unsupported-codec', retryable: false } }
    ],
    counters: {
      ...emptyCounters(),
      files: 1,
      sourceVideoBytes: 1_000,
      outputVideoBytes: 800,
      savedBytes: 200,
      groups: {
        ...emptyCounters().groups,
        RecentClips: { files: 1, sourceBytes: 1_000, outputBytes: 800, savedBytes: 200 }
      }
    },
    summary: null,
    ...overrides
  };
}

function fakeApi({ current = null, replacement = 'available' } = {}) {
  const listeners = new Set();
  const calls = [];
  const ok = (value) => ({ ok: true, value });
  return {
    calls,
    listeners,
    emit(payload) { listeners.forEach((listener) => listener(payload)); },
    async chooseConverterFolder(purpose) {
      calls.push(['choose', purpose]);
      return ok(purpose === 'source' ? 'D:\\TeslaCam' : 'E:\\Converted');
    },
    async getConverterCapabilities() {
      return ok({
        separatePublication: 'hardlink-cleanup-pending',
        ownershipCleanup: 'unavailable',
        replacement
      });
    },
    async getCurrentConverterJob() { return ok(current); },
    async startConverter(config) { calls.push(['start', config]); return ok({ jobId: 'job-new' }); },
    async pauseConverter(id) { calls.push(['pause', id]); return ok(activeSnapshot({ id, state: 'paused', revision: 5 })); },
    async resumeConverter(id) { calls.push(['resume', id]); return ok(activeSnapshot({ id, state: 'waiting', revision: 6 })); },
    async cancelConverter(id) { calls.push(['cancel', id]); return ok(activeSnapshot({ id, state: 'cancelled', revision: 7 })); },
    async retryFailedConverter(id) { calls.push(['retry', id]); return ok(activeSnapshot({ id, state: 'waiting', revision: 8 })); },
    async dismissConverterSummary(id) { calls.push(['dismiss', id]); return ok(activeSnapshot({ id, state: 'completed', revision: 99, summary: null, summaryDismissed: true })); },
    onConverterProgress(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

test('defaults to H.265, Balanced, separate output, all groups, and no estimate', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const controller = createFootageConverterController({ api, elements });

  await controller.init();

  assert.equal(elements.codecOptions[0].checked, true);
  assert.equal(elements.profileOptions[1].checked, true);
  assert.equal(elements.outputOptions[0].checked, true);
  assert.deepEqual(elements.groupOptions.map((entry) => entry.checked), [true, true, true]);
  assert.equal(elements.estimate.textContent, '');
});

test('picks source and destination only through the narrow converter API', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const controller = createFootageConverterController({ api, elements });
  await controller.init();

  await elements.sourceButton.click();
  await elements.destinationButton.click();

  assert.equal(elements.sourcePath.value, 'D:\\TeslaCam');
  assert.equal(elements.destinationPath.value, 'E:\\Converted');
  assert.deepEqual(api.calls.slice(0, 2), [['choose', 'source'], ['choose', 'destination']]);
});

test('validates required paths and group selection before starting', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const notices = [];
  const controller = createFootageConverterController({ api, elements, notify: (message) => notices.push(message) });
  await controller.init();

  await elements.startButton.click();
  assert.match(notices.at(-1), /source/i);
  elements.sourcePath.value = 'D:\\TeslaCam';
  elements.destinationPath.value = 'E:\\Converted';
  elements.groupOptions.forEach((entry) => { entry.checked = false; });
  await elements.startButton.click();

  assert.match(notices.at(-1), /group/i);
  assert.equal(api.calls.some(([name]) => name === 'start'), false);
});

test('builds the exact start DTO from selected controls', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const controller = createFootageConverterController({ api, elements });
  await controller.init();
  elements.sourcePath.value = 'D:\\TeslaCam';
  elements.destinationPath.value = 'E:\\Converted';
  elements.codecOptions[0].checked = false;
  elements.codecOptions[1].checked = true;
  elements.profileOptions[1].checked = false;
  elements.profileOptions[2].checked = true;
  elements.groupOptions[1].checked = false;

  await elements.startButton.click();

  assert.deepEqual(api.calls.find(([name]) => name === 'start')[1], {
    sourceRoot: 'D:\\TeslaCam',
    destinationRoot: 'E:\\Converted',
    codec: 'av1',
    profileId: 'aggressive',
    networkMode: 'auto',
    outputMode: 'separate',
    includedGroups: ['RecentClips', 'SentryClips'],
    groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: false
  });
});

test('reorders processing groups independently and submits the new order', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const controller = createFootageConverterController({ api, elements });
  await controller.init();
  elements.sourcePath.value = 'D:\\TeslaCam';
  elements.destinationPath.value = 'E:\\Converted';
  elements.groupOptions[2].checked = false;

  await elements.orderRows[2].up.click();
  await elements.orderRows[2].up.click();
  await elements.startButton.click();

  assert.deepEqual(api.calls.find(([name]) => name === 'start')[1].groupOrder,
    ['RecentClips', 'SavedClips', 'SentryClips']);
  assert.deepEqual(api.calls.find(([name]) => name === 'start')[1].includedGroups,
    ['RecentClips', 'SavedClips']);
  assert.deepEqual(elements.orderRows.map(({ rank }) => rank.textContent), ['2', '3', '1']);
});

test('restores processing order and disables reorder controls during an active run', async () => {
  const elements = makeElements();
  const current = activeSnapshot({
    config: { ...activeSnapshot().config, groupOrder: ['SentryClips', 'RecentClips', 'SavedClips'] }
  });
  const controller = createFootageConverterController({ api: fakeApi({ current }), elements });
  await controller.init();

  assert.deepEqual(elements.orderRows.map(({ rank }) => rank.textContent), ['3', '1', '2']);
  assert.ok(elements.orderRows.every(({ up, down }) => up.disabled && down.disabled));
});

test('visibly disables replace-original when the runtime capability is unavailable', async () => {
  const elements = makeElements();
  const controller = createFootageConverterController({ api: fakeApi({ replacement: 'unavailable' }), elements });

  await controller.init();

  assert.equal(elements.replaceInput.disabled, true);
  assert.equal(elements.replaceOption.getAttribute('aria-disabled'), 'true');
  assert.match(elements.replaceCapability.textContent, /unavailable|not available/i);
});

test('requires both explicit replacement acknowledgement and confirmation', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const notices = [];
  let confirmations = 0;
  const controller = createFootageConverterController({
    api,
    elements,
    notify: (message) => notices.push(message),
    confirm: () => { confirmations += 1; return true; }
  });
  await controller.init();
  elements.sourcePath.value = 'D:\\TeslaCam';
  elements.outputOptions[0].checked = false;
  elements.outputOptions[1].checked = true;
  await elements.outputOptions[1].dispatch('change');

  await elements.startButton.click();
  assert.match(notices.at(-1), /confirm|acknowledge/i);
  elements.replacementConfirmation.checked = true;
  await elements.startButton.click();

  assert.equal(confirmations, 1);
  assert.deepEqual(api.calls.find(([name]) => name === 'start')[1], {
    sourceRoot: 'D:\\TeslaCam',
    destinationRoot: null,
    codec: 'h265',
    profileId: 'balanced',
    networkMode: 'auto',
    outputMode: 'replace',
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
    groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: true
  });
});

test('routes pause, resume, cancel, and retry to the restored job', async () => {
  const elements = makeElements();
  const api = fakeApi({ current: activeSnapshot() });
  const controller = createFootageConverterController({ api, elements, confirm: () => true });
  await controller.init();

  await elements.pauseButton.click();
  await elements.resumeButton.click();
  await elements.cancelButton.click();
  api.emit({ jobId: 'job-1', revision: 10, snapshot: activeSnapshot({ state: 'completed', revision: 10 }) });
  await elements.retryButton.click();

  assert.deepEqual(api.calls.filter(([name]) => ['pause', 'resume', 'cancel', 'retry'].includes(name)), [
    ['pause', 'job-1'], ['resume', 'job-1'], ['cancel', 'job-1'], ['retry', 'job-1']
  ]);
});

test('starts a new revision-zero job after a completed job with a higher revision', async () => {
  const elements = makeElements();
  const previous = activeSnapshot({ state: 'completed', revision: 42, summary: null });
  const controller = createFootageConverterController({ api: fakeApi({ current: previous }), elements });
  await controller.init();

  await elements.startButton.click();

  assert.equal(controller.snapshot.id, 'job-new');
  assert.equal(controller.snapshot.revision, 0);
  assert.equal(elements.status.textContent, 'Discovering footage');
});

test('preserves a fast completion event that arrives before start resolves', async () => {
  const elements = makeElements();
  const previous = activeSnapshot({ state: 'completed', revision: 42, summary: null });
  const api = fakeApi({ current: previous });
  api.startConverter = async (config) => {
    api.calls.push(['start', config]);
    api.emit({
      jobId: 'job-new',
      revision: 7,
      snapshot: activeSnapshot({ id: 'job-new', state: 'completed', revision: 7, summary: null })
    });
    return { ok: true, value: { jobId: 'job-new' } };
  };
  const controller = createFootageConverterController({ api, elements });
  await controller.init();

  await elements.startButton.click();

  assert.equal(controller.snapshot.id, 'job-new');
  assert.equal(controller.snapshot.revision, 7);
  assert.equal(controller.snapshot.state, 'completed');
  assert.equal(elements.status.textContent, 'Conversion complete');
});

test('preserves a fast event on the first start when no prior snapshot exists', async () => {
  const elements = makeElements();
  const api = fakeApi();
  api.startConverter = async (config) => {
    api.calls.push(['start', config]);
    api.emit({
      jobId: 'job-new',
      revision: 7,
      snapshot: activeSnapshot({ id: 'job-new', state: 'verifying', revision: 7 })
    });
    return { ok: true, value: { jobId: 'job-new' } };
  };
  const controller = createFootageConverterController({ api, elements });
  await controller.init();
  elements.sourcePath.value = 'D:\\TeslaCam';
  elements.destinationPath.value = 'E:\\Converted';

  await elements.startButton.click();

  assert.equal(controller.snapshot.id, 'job-new');
  assert.equal(controller.snapshot.revision, 7);
  assert.equal(controller.snapshot.state, 'verifying');
  assert.equal(elements.status.textContent, 'Verifying telemetry');
});

test('rejects stale revisions while rendering live phase, counters, failures, reconnect, and cleanup-pending', async () => {
  const elements = makeElements();
  const api = fakeApi({ current: activeSnapshot() });
  const controller = createFootageConverterController({ api, elements });
  await controller.init();

  api.emit({
    jobId: 'job-1', revision: 4,
    snapshot: { id: 'job-1', revision: 4, progress: { outTimeUs: 5_000_000, phase: 'continue' } }
  });
  assert.match(elements.currentProgress.textContent, /00:05/);
  assert.equal(elements.countDiscovered.textContent, '5');
  assert.equal(elements.countCompleted.textContent, '1');
  assert.equal(elements.countSkipped.textContent, '1');
  assert.equal(elements.countFailed.textContent, '1');
  assert.equal(elements.countWaiting.textContent, '1');
  assert.equal(elements.processedBytes.textContent, '1,000 B');
  assert.match(elements.errorRows.textContent, /bad\.mp4.*unsupported-codec/i);
  assert.equal(elements.pipelineStages[1].classList.contains('is-active'), true);
  assert.equal(elements.pipeline.dataset.currentPhase, 'encode');

  api.emit({ jobId: 'job-1', revision: 5, snapshot: activeSnapshot({
    state: 'paused_network', revision: 5,
    items: activeSnapshot().items.map((item, index) => index === 0
      ? { ...item, resultCode: 'completed-cleanup-pending' }
      : item)
  }) });
  assert.equal(elements.reconnectBanner.hidden, false);
  assert.equal(elements.cleanupBanner.hidden, false);

  api.emit({ jobId: 'job-1', revision: 3, snapshot: activeSnapshot({ state: 'completed', revision: 3 }) });
  assert.equal(elements.status.textContent, 'Waiting for connection');
});

test('uses the existing translator contract without passing fallback text as interpolation data', async () => {
  const calls = [];
  const controller = createFootageConverterController({
    api: fakeApi({ replacement: 'unavailable' }),
    elements: makeElements(),
    t: (...args) => {
      calls.push(args);
      return args[0];
    }
  });

  await controller.init();

  assert.ok(calls.length > 0);
  assert.ok(calls.every((args) => args.length === 1 || (args.length === 2 && typeof args[1] === 'object')));
  assert.ok(calls.every((args) => args[1] === undefined || !Object.values(args[1]).some((value) => /Available on|not available/i.test(value))));
});

test('separate summary explains video size reduction and retained originals and cleanup space in every locale', async () => {
  const source = await readFile(new URL('../../src/renderer/scripts/data/translations.js', import.meta.url), 'utf8');
  const { translations } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const locale of Object.values(translations)) {
    const elements = makeElements();
    const current = activeSnapshot({ state: 'completed', cleanupPendingCount: 2,
      summary: { ...emptyCounters(), files: 1, sourceVideoBytes: 1000, outputVideoBytes: 800, savedBytes: 200 } });
    const controller = createFootageConverterController({ api: fakeApi({ current }), elements,
      t: (key, params) => {
        const copy = locale.ui.converter[key.replace('ui.converter.', '')];
        assert.equal(typeof copy, 'string', `Missing converter translation: ${key}`);
        return copy.replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
      } });
    await controller.init();
    assert.equal(elements.summarySaved.textContent, '200 B');
    assert.match(elements.summaryGroups.textContent, /video size reduction/);
    assert.match(elements.summaryRetention.textContent, /originals.*retained/i);
    assert.match(elements.summaryRetention.textContent, /not.*storage reclaimed/i);
    assert.match(elements.cleanupBanner.textContent, /consume.*space/i);
    controller.destroy();
  }
});

test('localizes dynamic status, progress, cleanup, and summary copy through ui.converter keys', async () => {
  const elements = makeElements();
  const calls = [];
  const localized = {
    'ui.converter.statusWaitingForConnection': 'LOC_STATUS',
    'ui.converter.progressWorking': 'LOC_WORKING',
    'ui.converter.cleanupPending': 'LOC_CLEANUP',
    'ui.converter.summaryGroup': 'LOC_GROUP',
    'ui.converter.summarySeparateRetention': 'LOC_RETENTION'
  };
  const current = activeSnapshot({
    state: 'paused_network',
    items: activeSnapshot().items.map((item, index) => index === 0
      ? { ...item, resultCode: 'completed-cleanup-pending' }
      : item),
    summary: {
      files: 1, sourceVideoBytes: 1000, outputVideoBytes: 900, savedBytes: 100,
      copiedAssetBytes: 0, copiedAssets: '0 B', groups: {}
    }
  });
  const controller = createFootageConverterController({
    api: fakeApi({ current }), elements,
    t: (key, params) => { calls.push([key, params]); return localized[key] || key; }
  });

  await controller.init();

  assert.equal(elements.status.textContent, 'LOC_STATUS');
  assert.equal(elements.cleanupBanner.textContent, 'LOC_CLEANUP');
  assert.match(elements.summaryGroups.textContent, /LOC_GROUP/);
  assert.equal(elements.summaryRetention.textContent, 'LOC_RETENTION');
  assert.ok(calls.every(([key]) => key.startsWith('ui.converter.')));
});

test('localizes byte units without changing integer byte input semantics', () => {
  assert.equal(formatBytes(1_234_567, 'de'), '1,18 MiB');
  assert.equal(formatBytes(1_234_567, 'en'), '1.18 MiB');
  assert.equal(formatBytes(1.5, 'en'), '0 B');
});

test('rerenders dynamic copy and byte totals on language change without leaking subscriptions', async () => {
  const elements = makeElements();
  const listeners = new Set();
  let locale = 'en';
  const current = activeSnapshot({
    state: 'paused_network',
    counters: { sourceVideoBytes: 1_234_567 },
    config: { ...activeSnapshot().config, sourceRoot: 'D:\\TeslaCam' },
    summary: {
      files: 1, sourceVideoBytes: 1_234_567, outputVideoBytes: 1_000_000,
      savedBytes: 234_567, copiedAssetBytes: 0,
      source: 'stale source', output: 'stale output', saved: 'stale saved', copiedAssets: 'stale assets',
      groups: {}
    }
  });
  const translate = (key, params = {}) => {
    if (key === 'ui.converter.statusWaitingForConnection') return locale === 'de' ? 'DE_STATUS' : 'EN_STATUS';
    if (key === 'ui.converter.replacementWarning') return `${locale.toUpperCase()} ${params.sourceRoot}`;
    return key;
  };
  const controller = createFootageConverterController({
    api: fakeApi({ current }), elements, t: translate,
    getLocale: () => locale,
    onLanguageChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });

  await controller.init();
  await controller.init();
  assert.equal(listeners.size, 1);
  assert.equal(elements.status.textContent, 'EN_STATUS');
  assert.equal(elements.processedBytes.textContent, '1.18 MiB');
  assert.equal(elements.summarySource.textContent, '1.18 MiB');

  locale = 'de';
  listeners.forEach((listener) => listener(locale));

  assert.equal(elements.status.textContent, 'DE_STATUS');
  assert.equal(elements.processedBytes.textContent, '1,18 MiB');
  assert.equal(elements.summarySource.textContent, '1,18 MiB');
  assert.equal(elements.replacementWarning.textContent, 'DE D:\\TeslaCam');

  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('names the source root and backup rollback behavior in both replacement confirmations', async () => {
  const elements = makeElements();
  const api = fakeApi();
  const confirmations = [];
  const controller = createFootageConverterController({
    api,
    elements,
    confirm: (message) => { confirmations.push(message); return true; }
  });
  await controller.init();
  elements.sourcePath.value = 'D:\\TeslaCam';
  elements.outputOptions[0].checked = false;
  elements.outputOptions[1].checked = true;
  await elements.outputOptions[1].dispatch('change');

  assert.match(elements.replacementWarning.textContent, /D:\\TeslaCam/);
  assert.match(elements.replacementWarning.textContent, /backup/i);
  assert.match(elements.replacementWarning.textContent, /restore|roll back/i);

  elements.replacementConfirmation.checked = true;
  await elements.startButton.click();
  assert.match(confirmations[0], /D:\\TeslaCam/);
  assert.match(confirmations[0], /backup/i);
  assert.match(confirmations[0], /restore|roll back/i);
});

test('ships complete explicit converter fallback keys for every supported locale', async () => {
  const testDir = fileURLToPath(new URL('.', import.meta.url));
  const source = await readFile(`${testDir}../../src/renderer/scripts/data/translations.js`, 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { translations } = await import(moduleUrl);
  const english = translations.en.ui.converter;
  assert.ok(english && Object.keys(english).length >= 50);
  assert.deepEqual(Object.keys(translations), ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'pt', 'ru', 'it', 'nl', 'pl', 'tr']);
  for (const [locale, values] of Object.entries(translations)) {
    assert.deepEqual(Object.keys(values.ui.converter).sort(), Object.keys(english).sort(), `${locale} converter keys`);
    assert.ok(Object.values(values.ui.converter).every((value) => typeof value === 'string' && value.length > 0));
  }
});

test('marks converter navigation and disclosure copy for translation and accessibility', async () => {
  const testDir = fileURLToPath(new URL('.', import.meta.url));
  const html = await readFile(`${testDir}../../src/renderer/index.html`, 'utf8');
  const css = await readFile(`${testDir}../../src/renderer/styles/footageConverter.css`, 'utf8');
  assert.match(html, /id="clipDriveTabBar"[^>]*role="tablist"/);
  assert.match(html, /id="clipList"[^>]*role="tabpanel"[^>]*aria-labelledby="clipsTabBtn"/);
  assert.match(html, /id="driveList"[^>]*role="tabpanel"[^>]*aria-labelledby="drivesTabBtn"/);
  assert.match(html, /id="converterTabBtn"[^>]*role="tab"[^>]*aria-controls="converterWorkspace"/);
  assert.match(html, /id="converterWorkspace"[^>]*role="tabpanel"/);
  assert.match(html, /class="converter-live-state"(?![^>]*aria-live)/);
  assert.match(html, /id="converterStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /data-i18n="ui\.converter\.lossyDisclosure"[^>]*>[^<]*(lossy|re-encode)/i);
  assert.match(html, /data-i18n="ui\.converter\.highQualityDetail"[^>]*>[^<]*approximately 5% smaller/i);
  assert.doesNotMatch(html, /ui\.converter[^\n]*(lossless)/i);
  assert.equal((html.match(/name="converterCodec"[^>]*data-converter-codec=/g) || []).length, 2);
  assert.equal((html.match(/name="converterProfile"[^>]*data-converter-profile=/g) || []).length, 3);
  assert.doesNotMatch(html, /name="converterNetwork"|ui\.converter\.networkHandling/);
  assert.match(css, /\.converter-segments input:focus-visible \+ span[\s\S]*outline:/);
});

test('renders exact aggregate counts from a bounded snapshot whose item list was truncated', async () => {
  const elements = makeElements();
  const current = activeSnapshot({
    itemCount: 1_000,
    itemsTruncated: true,
    itemStateCounts: { queued: 641, processing: 1, completed: 300, skipped: 40, failed: 18, cancelled: 0 },
    cleanupPendingCount: 2
  });
  const controller = createFootageConverterController({ api: fakeApi({ current }), elements });

  await controller.init();

  assert.equal(elements.countDiscovered.textContent, '1000');
  assert.equal(elements.countCompleted.textContent, '300');
  assert.equal(elements.countSkipped.textContent, '40');
  assert.equal(elements.countFailed.textContent, '18');
  assert.equal(elements.countWaiting.textContent, '641');
  assert.equal(elements.cleanupBanner.hidden, false);
  assert.match(elements.cleanupBanner.textContent, /^2 files with cleanup pending/);
});

test('translated cleanup notice counts source files even when one file retains several artifacts', async () => {
  const source = await readFile(new URL('../../src/renderer/scripts/data/translations.js', import.meta.url), 'utf8');
  const { translations } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const count of [1, 2]) {
    const elements = makeElements();
    const current = activeSnapshot({ cleanupPendingCount: count,
      items: [{ id: 'item-1', state: 'completed', resultCode: 'completed-cleanup-pending',
        ownedPaths: { encodedCandidate: 'candidate.mp4', publicationSnapshot: 'snapshot.mp4', destinationPartial: 'partial.mp4' } }] });
    const controller = createFootageConverterController({ api: fakeApi({ current }), elements,
      t: (key, params) => String(key.split('.').reduce((value, part) => value?.[part], translations.en) ?? key)
        .replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match) });
    await controller.init();
    assert.match(elements.cleanupBanner.textContent, new RegExp(`^${count} ${count === 1 ? 'file' : 'files'} with cleanup pending`));
    assert.doesNotMatch(elements.cleanupBanner.textContent, /owned artifacts retained/);
    controller.destroy();
  }
});

test('keeps the job subscription live while the Converter workspace is hidden', async () => {
  const elements = makeElements();
  const api = fakeApi({ current: activeSnapshot() });
  const controller = createFootageConverterController({ api, elements });
  await controller.init();

  controller.setVisible(false);
  api.emit({ jobId: 'job-1', revision: 6, snapshot: activeSnapshot({ state: 'verifying', revision: 6 }) });

  assert.equal(api.listeners.size, 1);
  assert.equal(elements.status.textContent, 'Verifying telemetry');
  assert.equal(elements.pipelineStages[2].classList.contains('is-active'), true);
});

test('restores and dismisses an actual persisted completion summary', async () => {
  const summary = {
    files: 2,
    sourceVideoBytes: 2_000,
    outputVideoBytes: 1_500,
    savedBytes: 500,
    copiedAssetBytes: 128,
    source: '1.95 KiB',
    output: '1.46 KiB',
    saved: '500 B',
    copiedAssets: '128 B',
    groups: {
      RecentClips: { files: 1, sourceBytes: 1_000, outputBytes: 800, savedBytes: 200 },
      SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
      SentryClips: { files: 1, sourceBytes: 1_000, outputBytes: 700, savedBytes: 300 }
    }
  };
  const completed = activeSnapshot({
    state: 'completed',
    revision: 12,
    updatedAt: 11_000,
    summary,
    itemCount: 1_000,
    itemsTruncated: true,
    itemStateCounts: { queued: 642, completed: 300, skipped: 40, failed: 18 }
  });
  const elements = makeElements();
  const api = fakeApi({ current: completed });
  const controller = createFootageConverterController({ api, elements });
  await controller.init();

  assert.equal(elements.summary.hidden, false);
  assert.equal(elements.summaryFiles.textContent, '2');
  assert.equal(elements.summarySkipped.textContent, '40');
  assert.equal(elements.summaryFailed.textContent, '18');
  assert.equal(elements.summarySource.textContent, '1.95 KiB');
  assert.equal(elements.summaryOutput.textContent, '1.46 KiB');
  assert.equal(elements.summarySaved.textContent, '500 B');
  assert.equal(elements.summaryPercent.textContent, '25%');
  assert.match(elements.summaryGroups.textContent, /RecentClips.*200 B.*SentryClips.*300 B/s);

  await elements.dismissButton.click();
  assert.deepEqual(api.calls.at(-1), ['dismiss', 'job-1']);
  assert.equal(elements.summary.hidden, true);
});

test('switches Clips, Drives, and Converter through one panel function and initializes once', async () => {
  const body = new FakeElement();
  const clipList = new FakeElement();
  const driveList = new FakeElement();
  const workspace = new FakeElement();
  const tabs = ['clips', 'drives', 'converter'].map((panel) => new FakeElement({ dataset: { panel } }));
  let converterInitializations = 0;
  let driveRenders = 0;
  const switchPanel = createSidebarPanelSwitcher({
    body, clipList, driveList, workspace, tabs,
    onConverterOpen: async () => { converterInitializations += 1; },
    onDrivesOpen: () => { driveRenders += 1; }
  });

  await switchPanel('converter');
  await switchPanel('clips');
  await switchPanel('converter');
  await switchPanel('drives');

  assert.equal(converterInitializations, 1);
  assert.equal(driveRenders, 1);
  assert.equal(clipList.style.display, 'none');
  assert.equal(driveList.style.display, '');
  assert.equal(workspace.hidden, true);
  assert.equal(body.classList.contains('converter-mode'), false);
  assert.equal(tabs[1].classList.contains('active'), true);
});

test('moves and selects sidebar tabs with horizontal arrow keys', async () => {
  const tabs = ['clips', 'drives', 'converter'].map((panel) => new FakeElement({ dataset: { panel } }));
  const switchPanel = createSidebarPanelSwitcher({
    body: new FakeElement(), clipList: new FakeElement(), driveList: new FakeElement(),
    workspace: new FakeElement(), tabs
  });
  await switchPanel('clips');
  let prevented = false;

  await tabs[0].dispatch('keydown', { key: 'ArrowRight', preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(tabs[1].focused, true);
  assert.equal(tabs[1].classList.contains('active'), true);
  assert.equal(tabs[1].getAttribute('tabindex'), '0');
  assert.equal(tabs[0].getAttribute('tabindex'), '-1');
});

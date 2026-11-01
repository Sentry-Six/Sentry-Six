const {
  PROFILES,
  CODECS,
  NETWORK_MODES,
  OUTPUT_MODES,
  ITEM_STATES,
  createEmptyCounters,
  targetOutputBytes,
  isWithinProfile,
  addCompletedFile,
  formatBytes,
  serializeSummary,
  isTerminalState
} = require('../../../src/main/converter/contracts');

describe('converter contracts', () => {
  test('exposes frozen profiles with the three savings targets and tolerance', () => {
    expect(Object.isFrozen(PROFILES)).toBe(true);
    expect(PROFILES).toEqual({
      conservative: { savings: 0.05, tolerance: 0.02 },
      balanced: { savings: 0.20, tolerance: 0.02 },
      aggressive: { savings: 0.50, tolerance: 0.02 }
    });
  });

  test('calculates target bytes and checks the inclusive target boundary', () => {
    expect(targetOutputBytes(1_000_000, 'balanced')).toBe(800_000);
    expect(isWithinProfile(1_000_000, 820_000, 'balanced')).toBe(true);
    expect(isWithinProfile(1_000_000, 821_000, 'balanced')).toBe(false);
    expect(isWithinProfile(1_000_000, 780_000, 'balanced')).toBe(true);
    expect(isWithinProfile(1_000_000, 779_999, 'balanced')).toBe(false);
  });

  test('provides frozen enum-like contract values', () => {
    expect(Object.isFrozen(CODECS)).toBe(true);
    expect(Object.isFrozen(NETWORK_MODES)).toBe(true);
    expect(Object.isFrozen(OUTPUT_MODES)).toBe(true);
    expect(Object.isFrozen(ITEM_STATES)).toBe(true);
    expect(ITEM_STATES).toEqual(expect.objectContaining({ queued: expect.any(String), completed: expect.any(String), failed: expect.any(String) }));
  });

  test('accumulates completed eligible video by clip group without mutating counters', () => {
    const before = createEmptyCounters();
    const after = addCompletedFile(before, { state: ITEM_STATES.completed, kind: 'video', group: 'SentryClips', sourceBytes: 1_000, outputBytes: 500 });
    expect(after.savedBytes).toBe(500);
    expect(after.sourceVideoBytes).toBe(1_000);
    expect(after.outputVideoBytes).toBe(500);
    expect(after.groups.SentryClips).toEqual({ files: 1, sourceBytes: 1_000, outputBytes: 500, savedBytes: 500 });
    expect(before).toEqual(createEmptyCounters());
  });

  test('counts ungrouped video overall but excludes it from named group breakdown', () => {
    const counters = addCompletedFile(createEmptyCounters(), { state: ITEM_STATES.completed, kind: 'video', group: null, sourceBytes: 2_000, outputBytes: 1_000 });
    expect(counters.savedBytes).toBe(1_000);
    expect(counters.groups).toEqual({ RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }, SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }, SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 } });
  });

  test('tracks copied non-video asset bytes separately', () => {
    const counters = addCompletedFile(createEmptyCounters(), { state: ITEM_STATES.completed, kind: 'asset', sourceBytes: 123, outputBytes: 123 });
    expect(counters.copiedAssetBytes).toBe(123);
    expect(counters.savedBytes).toBe(0);
    expect(counters.sourceVideoBytes).toBe(0);
  });

  test('identifies terminal states and formats IEC byte units automatically', () => {
    expect(isTerminalState(ITEM_STATES.completed)).toBe(true);
    expect(isTerminalState(ITEM_STATES.failed)).toBe(true);
    expect(isTerminalState(ITEM_STATES.queued)).toBe(false);
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1_048_576)).toBe('1 MiB');
    expect(formatBytes(1_073_741_824)).toBe('1 GiB');
    expect(formatBytes(1_099_511_627_776)).toBe('1 TiB');
  });

  test('serializes a stable summary with formatted totals', () => {
    const summary = serializeSummary(addCompletedFile(createEmptyCounters(), { state: ITEM_STATES.completed, kind: 'video', group: 'RecentClips', sourceBytes: 1_000_000, outputBytes: 800_000 }));
    expect(summary).toEqual(expect.objectContaining({ sourceVideoBytes: 1_000_000, outputVideoBytes: 800_000, savedBytes: 200_000, copiedAssetBytes: 0, saved: '195.31 KiB' }));
  });

  test('does not count failed video as completed output', () => {
    const counters = addCompletedFile(createEmptyCounters(), { state: ITEM_STATES.failed, kind: 'video', sourceBytes: 1_000, outputBytes: 500 });
    expect(counters).toEqual(createEmptyCounters());
  });

  test('does not count untyped records as eligible video', () => {
    const counters = addCompletedFile(createEmptyCounters(), { state: ITEM_STATES.completed, sourceBytes: 1_000, outputBytes: 500 });
    expect(counters).toEqual(createEmptyCounters());
  });
});

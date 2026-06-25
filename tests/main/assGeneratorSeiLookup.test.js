// Tests for the SEI telemetry lookup used by the ASS dashboard generators.
//
// seiData is sorted by timestampMs (frames are parsed in order) and the
// frame loops call the lookup once per output frame with monotonically
// increasing times. The lookup must return the *nearest* sample (earlier
// sample wins ties) and must not degrade to O(n) per call — a linear
// scan from index 0 made hour-long exports take minutes of blocked
// main-process time.

const { findSeiAtTime } = require('../../src/assGenerator');

function makeSeiData(timestamps) {
  return timestamps.map((t, i) => ({ timestampMs: t, sei: { idx: i } }));
}

describe('findSeiAtTime semantics', () => {
  test('returns null for empty or missing data', () => {
    expect(findSeiAtTime([], 100)).toBeNull();
    expect(findSeiAtTime(null, 100)).toBeNull();
  });

  test('returns exact match', () => {
    const data = makeSeiData([0, 100, 200, 300]);
    expect(findSeiAtTime(data, 200).idx).toBe(2);
  });

  test('returns nearest sample on either side', () => {
    const data = makeSeiData([0, 100, 200, 300]);
    expect(findSeiAtTime(data, 130).idx).toBe(1); // closer to 100
    expect(findSeiAtTime(data, 170).idx).toBe(2); // closer to 200
  });

  test('earlier sample wins on an exact midpoint tie', () => {
    const data = makeSeiData([0, 100, 200]);
    expect(findSeiAtTime(data, 150).idx).toBe(1); // 100 and 200 equidistant
  });

  test('clamps to the nearest endpoint just outside the range, within the staleness window', () => {
    const data = makeSeiData([100, 200, 300]);
    expect(findSeiAtTime(data, -50).idx).toBe(0);   // 150ms before first sample
    expect(findSeiAtTime(data, 1500).idx).toBe(2);  // 1200ms after last sample
  });

  test('returns null when the nearest sample is staler than the threshold (parked / no telemetry)', () => {
    // A parked Tesla records video but no telemetry, so lookups land far from
    // any sample. Past maxStaleMs (default 3s) the lookup must report "no data"
    // (null) rather than clamping to a stale driving value — that drove the
    // dashboard showing PARKED instead of a frozen gear/speed.
    const data = makeSeiData([100, 200, 300]);
    expect(findSeiAtTime(data, 9999)).toBeNull();       // 9.7s past the last sample
    expect(findSeiAtTime(data, -100000)).toBeNull();    // long before the first sample
    // The threshold is configurable; a generous window still clamps to nearest.
    expect(findSeiAtTime(data, 9999, 60000).idx).toBe(2);
  });

  test('handles a single sample', () => {
    const data = makeSeiData([500]);
    expect(findSeiAtTime(data, 0).idx).toBe(0);
    expect(findSeiAtTime(data, 1000).idx).toBe(0);
  });
});

describe('findSeiAtTime performance', () => {
  test('a long export worth of sequential lookups completes quickly', () => {
    // ~35 minutes of telemetry at 36Hz, looked up for every output frame.
    // The old linear-scan-from-zero implementation needs ~2.8 billion
    // element visits for this and takes many seconds; nearest-binary-search
    // takes milliseconds.
    const n = 75000;
    const data = makeSeiData(Array.from({ length: n }, (_, i) => i * 27.78));
    const start = Date.now();
    let acc = 0;
    for (let frame = 0; frame < n; frame++) {
      const sei = findSeiAtTime(data, frame * 27.78 + 3);
      acc += sei.idx;
    }
    const elapsed = Date.now() - start;
    expect(acc).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

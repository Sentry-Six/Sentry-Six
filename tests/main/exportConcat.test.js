const { prepareConcatFiles, concatFileList } = require('../../src/main/exportConcat');

function harness(bases) {
  const run = jest.fn(async (tool) => tool === 'probe' ? JSON.stringify({ streams: [{ time_base: bases.shift() }] }) : '');
  return { ffmpegPath: 'ffmpeg', ffprobePath: 'probe', run, tempFiles: [] };
}
test('matching time bases use original inputs without remuxing', async () => {
  const options = harness(['1/90000', '1/90000']);
  expect(await prepareConcatFiles(['a.mp4', 'b.mp4'], options)).toEqual(['a.mp4', 'b.mp4']);
  expect(options.tempFiles).toEqual([]);
});
test('mixed converted VFR time bases are stream copied into a common timescale', async () => {
  const options = harness(['1/18432', '1/1075000']);
  const files = await prepareConcatFiles(['a.mp4', 'b.mp4'], options);
  expect(files).toEqual(options.tempFiles);
  expect(new Set(files).size).toBe(2);
  for (const call of options.run.mock.calls.slice(2)) {
    expect(call[1]).toEqual(expect.arrayContaining(['-c:v', 'copy', '-video_track_timescale', '1000000', '-n']));
  }
});
test('cancelled preparation never starts media work', async () => {
  const options = { ...harness([]), isCancelled: () => true };
  await expect(prepareConcatFiles(['a.mp4'], options)).rejects.toThrow('Export cancelled');
  expect(options.run).not.toHaveBeenCalled();
});
test('probe failure aborts export instead of concatenating unknown timing', async () => {
  await expect(prepareConcatFiles(['a.mp4'], harness(['0/0']))).rejects.toThrow('time base');
});
test('concat filenames escape apostrophes and Windows separators', () => {
  expect(concatFileList(["C:\\clips\\driver's.mp4"])).toBe("file 'C:/clips/driver'\\''s.mp4'");
});

test('failed remux remains tracked for cleanup and never returns partial inputs', async () => {
  const options = harness(['1/18432', '1/1075000']);
  options.run.mockImplementationOnce(async () => JSON.stringify({ streams: [{ time_base: '1/18432' }] }))
    .mockImplementationOnce(async () => JSON.stringify({ streams: [{ time_base: '1/1075000' }] }))
    .mockImplementationOnce(async () => { throw new Error('disk full'); });
  await expect(prepareConcatFiles(['a.mp4', 'b.mp4'], options)).rejects.toThrow('disk full');
  expect(options.tempFiles).toHaveLength(1);
});

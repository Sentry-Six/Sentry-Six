'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveContainedPath,
  scanTeslaFootage
} = require('../../../src/main/converter/scanner');

const CLIP = '2026-08-30_12-34-56-front.mp4';
const SECOND_CLIP = '2026-08-30_12-34-57-left_repeater.mp4';

const temporaryRoots = [];

async function makeTemporaryRoot(label = 'scanner') {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sentry-six-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function writeFile(root, relativePath, contents = 'clip') {
  const filePath = path.join(root, ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, contents);
  return filePath;
}

async function collectScan(config, adapters) {
  const items = [];
  for await (const item of scanTeslaFootage(config, withTeslaFilenameParser(adapters))) items.push(item);
  return items;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe('Tesla footage discovery', () => {
  test('walks groups and nested date/event folders in deterministic processing order', async () => {
    const parent = await makeTemporaryRoot('ordered');
    const sourceRoot = path.join(parent, 'TeslaCam');
    await writeFile(sourceRoot, `RecentClips/2026-09-03/${CLIP}`);
    await writeFile(sourceRoot, `SavedClips/2026-09-02/z-event/${SECOND_CLIP}`);
    await writeFile(sourceRoot, `SavedClips/2026-09-01/b-event/${SECOND_CLIP}`);
    await writeFile(sourceRoot, `SavedClips/2026-09-01/a-event/${CLIP}`);
    await writeFile(sourceRoot, `SentryClips/2026-09-01/${CLIP}`);
    await writeFile(sourceRoot, `SavedClips/2026-09-01/a-event/TEMP-H265-${CLIP}`);
    await writeFile(sourceRoot, `SavedClips/2026-09-01/a-event/BACKUP-${CLIP}`);

    const items = (await collectScan({ sourceRoot })).filter((item) => item.kind === 'video');
    expect(items.map((item) => item.group)).toEqual([
      'SavedClips', 'SavedClips', 'SavedClips', 'SentryClips', 'RecentClips'
    ]);
    expect(items.map((item) => item.relativePath)).toEqual([
      `SavedClips/2026-09-01/a-event/${CLIP}`,
      `SavedClips/2026-09-01/b-event/${SECOND_CLIP}`,
      `SavedClips/2026-09-02/z-event/${SECOND_CLIP}`,
      `SentryClips/2026-09-01/${CLIP}`,
      `RecentClips/2026-09-03/${CLIP}`
    ]);

    const custom = (await collectScan({
      sourceRoot,
      groupOrder: ['RecentClips', 'SavedClips', 'SentryClips']
    })).filter((item) => item.kind === 'video');
    expect(custom.map((item) => item.group)).toEqual([
      'RecentClips', 'SavedClips', 'SavedClips', 'SavedClips', 'SentryClips'
    ]);
  });

  test('scans a TeslaCam root and classifies each canonical clip group', async () => {
    const parent = await makeTemporaryRoot('root');
    const sourceRoot = path.join(parent, 'TeslaCam');
    await writeFile(sourceRoot, `RecentClips/${CLIP}`, 'recent');
    await writeFile(sourceRoot, `SavedClips/2026-08-30_12-34-00/${SECOND_CLIP}`, 'saved');
    await writeFile(sourceRoot, `SentryClips/2026-08-30_12-35-00/${CLIP}`, 'sentry');
    await writeFile(sourceRoot, 'RecentClips/not-a-tesla-name.mp4', 'ignored');

    const items = await collectScan({ sourceRoot });

    expect(items.map(({ kind, group, relativePath, sourceBytes }) => ({
      kind,
      group,
      relativePath,
      sourceBytes
    }))).toEqual(expect.arrayContaining([
      { kind: 'video', group: 'RecentClips', relativePath: `RecentClips/${CLIP}`, sourceBytes: 6 },
      { kind: 'video', group: 'SavedClips', relativePath: `SavedClips/2026-08-30_12-34-00/${SECOND_CLIP}`, sourceBytes: 5 },
      { kind: 'video', group: 'SentryClips', relativePath: `SentryClips/2026-08-30_12-35-00/${CLIP}`, sourceBytes: 6 }
    ]));
    expect(items).toHaveLength(3);
    expect(items.every(({ sourcePath, mtimeMs }) => path.isAbsolute(sourcePath) && Number.isFinite(mtimeMs))).toBe(true);
  });

  test.each(['RecentClips', 'SavedClips', 'SentryClips'])(
    'infers %s when that group folder is selected directly',
    async (group) => {
      const parent = await makeTemporaryRoot('direct');
      const sourceRoot = path.join(parent, group.toLowerCase());
      const relativePath = group === 'RecentClips' ? CLIP : `event-folder/${CLIP}`;
      await writeFile(sourceRoot, relativePath);

      const items = await collectScan({ sourceRoot });

      expect(items).toEqual([
        expect.objectContaining({ kind: 'video', group, relativePath })
      ]);
    }
  );

  test('discovers Tesla-named loose clips without adding them to a group breakdown', async () => {
    const sourceRoot = await makeTemporaryRoot('loose');
    await writeFile(sourceRoot, `archive/day/${CLIP}`);
    await writeFile(sourceRoot, 'archive/day/ordinary-video.mp4');

    await expect(collectScan({ sourceRoot })).resolves.toEqual([
      expect.objectContaining({
        kind: 'video',
        group: null,
        relativePath: `archive/day/${CLIP}`
      })
    ]);
  });

  test('honors included-group toggles and does not enumerate excluded group trees', async () => {
    const sourceRoot = path.resolve('virtual-TeslaCam');
    const opened = [];
    const entries = new Map([
      [sourceRoot, [directoryEntry('RecentClips'), directoryEntry('SentryClips')]],
      [path.join(sourceRoot, 'RecentClips'), [fileEntry(CLIP)]],
      [path.join(sourceRoot, 'SentryClips'), [fileEntry(SECOND_CLIP)]]
    ]);
    const adapters = fakeFilesystem(entries, { opened });

    const items = await collectScan({ sourceRoot, includedGroups: ['SentryClips'] }, adapters);

    expect(items).toEqual([
      expect.objectContaining({ group: 'SentryClips', relativePath: `SentryClips/${SECOND_CLIP}` })
    ]);
    expect(opened).not.toContain(path.join(sourceRoot, 'RecentClips'));
  });

  test('yields event metadata and thumbnail assets only from included Saved/Sentry event directories', async () => {
    const parent = await makeTemporaryRoot('assets');
    const sourceRoot = path.join(parent, 'TeslaCam');
    const event = '2026-08-30_12-35-00';
    await writeFile(sourceRoot, `SentryClips/${event}/${CLIP}`);
    await writeFile(sourceRoot, `SentryClips/${event}/event.json`, '{}');
    await writeFile(sourceRoot, `SentryClips/${event}/event.png`, 'png');
    await writeFile(sourceRoot, `SentryClips/${event}/event.mp4`, 'preview');
    await writeFile(sourceRoot, 'RecentClips/event.json', 'not-an-event-asset');
    await writeFile(sourceRoot, `SavedClips/excluded/event.json`, '{}');

    const items = await collectScan({ sourceRoot, includedGroups: ['SentryClips'] });

    expect(items.map(({ kind, assetType, eventId, relativePath }) => ({
      kind,
      assetType,
      eventId,
      relativePath
    }))).toEqual(expect.arrayContaining([
      { kind: 'video', assetType: undefined, eventId: event, relativePath: `SentryClips/${event}/${CLIP}` },
      { kind: 'asset', assetType: 'event-json', eventId: event, relativePath: `SentryClips/${event}/event.json` },
      { kind: 'asset', assetType: 'thumbnail', eventId: event, relativePath: `SentryClips/${event}/event.png` },
      { kind: 'asset', assetType: 'event-video', eventId: event, relativePath: `SentryClips/${event}/event.mp4` }
    ]));
    expect(items).toHaveLength(4);
  });

  test('never descends into a separate destination located inside the source', async () => {
    const sourceRoot = await makeTemporaryRoot('destination');
    const destinationRoot = path.join(sourceRoot, 'converted');
    await writeFile(sourceRoot, `RecentClips/${CLIP}`);
    await writeFile(destinationRoot, `RecentClips/${SECOND_CLIP}`);

    const items = await collectScan({ sourceRoot, destinationRoot });

    expect(items.map(({ relativePath }) => relativePath)).toEqual([`RecentClips/${CLIP}`]);
  });

  test('prunes a destination created behind a junction after its leaf was canonicalized as missing', async () => {
    const parent = await makeTemporaryRoot('destination-alias');
    const sourceRoot = path.join(parent, 'source');
    const convertedParent = path.join(sourceRoot, 'converted-parent');
    const destinationAlias = path.join(parent, 'destination-alias');
    const destinationRoot = path.join(destinationAlias, 'new-output');
    const createdOutput = path.join(destinationRoot, 'RecentClips', SECOND_CLIP);
    await writeFile(sourceRoot, `RecentClips/${CLIP}`);
    await fs.promises.mkdir(convertedParent, { recursive: true });
    await fs.promises.symlink(
      convertedParent,
      destinationAlias,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    let outputCreated = false;
    const adapters = {
      async opendir(directoryPath) {
        if (!outputCreated && directoryPath === sourceRoot) {
          outputCreated = true;
          await writeFile(destinationRoot, `RecentClips/${SECOND_CLIP}`, 'converted');
        }
        return fs.promises.opendir(directoryPath);
      }
    };

    const items = await collectScan({ sourceRoot, destinationRoot }, adapters);

    await expect(fs.promises.stat(createdOutput)).resolves.toEqual(expect.objectContaining({ size: 9 }));
    expect(items.map(({ relativePath }) => relativePath)).toEqual([`RecentClips/${CLIP}`]);
  });

  test('allows a destination ancestor when its output remains outside the source tree', async () => {
    const parent = await makeTemporaryRoot('destination-ancestor');
    const destinationRoot = path.join(parent, 'archive');
    const sourceRoot = path.join(destinationRoot, 'TeslaCam');
    await writeFile(sourceRoot, `RecentClips/${CLIP}`);

    const items = await collectScan({ sourceRoot, destinationRoot });

    expect(items.map(({ relativePath }) => relativePath)).toEqual([`RecentClips/${CLIP}`]);
  });

  test('propagates directory permission failures without misclassifying the archive as empty', async () => {
    const sourceRoot = path.resolve('permission-denied');
    const permissionError = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const adapters = {
      realpath: jest.fn(async (candidate) => path.resolve(candidate)),
      opendir: jest.fn(async () => { throw permissionError; })
    };

    await expect(collectScan({ sourceRoot }, adapters)).rejects.toBe(permissionError);
  });

  test('retries a mid-directory network read on the same iterator without reopening the root', async () => {
    const sourceRoot = path.resolve('retry-mid-read');
    let index = 0;
    let failed = false;
    const entries = [fileEntry(CLIP), fileEntry(SECOND_CLIP)];
    const iterator = {
      async next() {
        if (index === 1 && !failed) {
          failed = true;
          throw Object.assign(new Error('share dropped'), { code: 'ENETDOWN', path: sourceRoot });
        }
        if (index >= entries.length) return { done: true };
        return { done: false, value: entries[index++] };
      }
    };
    const opendir = jest.fn(async () => ({ [Symbol.asyncIterator]: () => iterator }));
    const retryOperation = jest.fn(async ({ path: affectedPath, operation }) => {
      expect(affectedPath).toBe(sourceRoot);
      try { return await operation(); } catch (error) {
        expect(error.code).toBe('ENETDOWN');
        return operation();
      }
    });

    const items = await collectScan({ sourceRoot }, {
      opendir,
      retryOperation,
      realpath: async (candidate) => path.resolve(candidate),
      stat: async () => ({ isFile: () => true, size: 4, mtimeMs: 1234 })
    });

    expect(items.map((item) => item.relativePath)).toEqual([CLIP, SECOND_CLIP]);
    expect(opendir).toHaveBeenCalledTimes(1);
    expect(retryOperation).toHaveBeenCalledTimes(4);
  });

  test('lists only the current directory before yielding and does not pre-scan later directories', async () => {
    const sourceRoot = path.resolve('slow-enumeration');
    const laterDirectory = path.join(sourceRoot, 'later');
    const opened = [];
    const statCalls = [];
    const entries = new Map([
      [sourceRoot, [fileEntry(CLIP), directoryEntry('later')]],
      [laterDirectory, [fileEntry(SECOND_CLIP)]]
    ]);
    const adapters = fakeFilesystem(entries, { opened, statCalls });

    const iterator = scanTeslaFootage({ sourceRoot }, withTeslaFilenameParser(adapters));
    const first = await iterator.next();

    expect(first.value).toEqual(expect.objectContaining({
      kind: 'video',
      group: null,
      relativePath: CLIP,
      sourceBytes: 4
    }));
    expect(opened).toEqual([sourceRoot]);
    expect(statCalls).toEqual([path.join(sourceRoot, CLIP)]);
    await iterator.return();
  });
});

describe('path containment and directory links', () => {
  test('resolves a contained link target but rejects traversal, sibling-prefix, and escaping links', async () => {
    const parent = await makeTemporaryRoot('containment');
    const sourceRoot = path.join(parent, 'source');
    const insideDirectory = path.join(sourceRoot, 'inside');
    const outsideDirectory = path.join(parent, 'source-copy');
    const inside = await writeFile(insideDirectory, CLIP);
    await writeFile(outsideDirectory, SECOND_CLIP);
    await fs.promises.symlink(
      insideDirectory,
      path.join(sourceRoot, 'inside-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await fs.promises.symlink(
      outsideDirectory,
      path.join(sourceRoot, 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await expect(resolveContainedPath(sourceRoot, `inside-link/${CLIP}`)).resolves.toBe(await fs.promises.realpath(inside));
    await expect(resolveContainedPath(sourceRoot, '../source-copy/' + SECOND_CLIP)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
    await expect(resolveContainedPath(sourceRoot, `outside-link/${SECOND_CLIP}`)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  });

  test('uses Windows-aware case rules while still rejecting a lookalike prefix', async () => {
    const pathApi = path.win32;
    const root = 'C:\\TeslaCam';
    const mappings = new Map([
      [pathApi.resolve(root), 'C:\\TESLACAM'],
      [pathApi.resolve(root, 'SentryClips\\clip.mp4'), 'c:\\teslacam\\SentryClips\\clip.mp4'],
      [pathApi.resolve(root, 'escape.mp4'), 'C:\\TeslaCam-old\\escape.mp4']
    ]);
    const adapters = {
      path: pathApi,
      platform: 'win32',
      realpath: jest.fn(async (candidate) => mappings.get(pathApi.resolve(candidate)))
    };

    await expect(resolveContainedPath(root, 'SentryClips\\clip.mp4', adapters))
      .resolves.toBe('c:\\teslacam\\SentryClips\\clip.mp4');
    await expect(resolveContainedPath(root, 'escape.mp4', adapters))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  });

  test('does not follow a directory symlink or junction that escapes the source root', async () => {
    const parent = await makeTemporaryRoot('junction');
    const sourceRoot = path.join(parent, 'source');
    const outsideRoot = path.join(parent, 'outside');
    await writeFile(sourceRoot, `RecentClips/${CLIP}`);
    await writeFile(outsideRoot, `SentryClips/${SECOND_CLIP}`);
    await fs.promises.symlink(
      outsideRoot,
      path.join(sourceRoot, 'escaped'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const items = await collectScan({ sourceRoot });

    expect(items.map(({ relativePath }) => relativePath)).toEqual([`RecentClips/${CLIP}`]);
  });
});

function fileEntry(name) {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false
  };
}

function directoryEntry(name) {
  return {
    name,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false
  };
}

function fakeDirectory(entries, delayAfterFirstEntry = false) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (delayAfterFirstEntry && index > 0) {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
          }
          if (index >= entries.length) return { done: true, value: undefined };
          return { done: false, value: entries[index++] };
        },
        async return() {
          return { done: true, value: undefined };
        }
      };
    }
  };
}

function fakeFilesystem(entries, options = {}) {
  const { opened = [], statCalls = [], delayAfterFirstEntry = false } = options;
  return {
    opendir: jest.fn(async (directoryPath) => {
      opened.push(directoryPath);
      const directoryEntries = entries.get(directoryPath);
      if (!directoryEntries) throw Object.assign(new Error(`missing fake directory ${directoryPath}`), { code: 'ENOENT' });
      return fakeDirectory(directoryEntries, delayAfterFirstEntry && directoryPath === path.resolve('slow-enumeration'));
    }),
    realpath: jest.fn(async (candidate) => path.resolve(candidate)),
    stat: jest.fn(async (candidate) => {
      statCalls.push(candidate);
      return { isFile: () => true, size: 4, mtimeMs: 1234 };
    })
  };
}

function withTeslaFilenameParser(adapters = {}) {
  const parsedFixtures = new Map([
    [CLIP.toLowerCase(), {
      profileId: 'tesla',
      timestampKey: '2026-08-30_12-34-56',
      date: '2026-08-30',
      camera: 'front'
    }],
    [SECOND_CLIP.toLowerCase(), {
      profileId: 'tesla',
      timestampKey: '2026-08-30_12-34-57',
      date: '2026-08-30',
      camera: 'left_repeater'
    }]
  ]);
  return {
    loadTeslaFilenameModule: async () => ({
      parseTeslaFilename(filename) {
        return parsedFixtures.get(String(filename || '').toLowerCase()) || null;
      }
    }),
    ...adapters
  };
}

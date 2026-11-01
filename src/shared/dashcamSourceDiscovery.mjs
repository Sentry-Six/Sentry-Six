import {
  GMC_PROFILE_ID,
  getDashcamProfile,
  parseDashcamFilename
} from './dashcamProfiles.mjs';

const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GMC_SOURCE_RULES = getDashcamProfile(GMC_PROFILE_ID).sourceRules;
const RAW_ANDROID_PATH = GMC_SOURCE_RULES.rawAndroidPath;

function nodeName(node, adapter) {
  return String(adapter.name(node) || '');
}

async function list(node, adapter) {
  try {
    return await adapter.list(node);
  } catch {
    return [];
  }
}

async function findDirectory(node, wantedName, adapter) {
  const wanted = wantedName.toLowerCase();
  const entries = await list(node, adapter);
  return entries.find(entry =>
    entry.kind === 'directory' &&
    nodeName(entry, adapter).toLowerCase() === wanted
  ) || null;
}

async function followPath(rootNode, pathParts, adapter) {
  let node = rootNode;
  let index = 0;
  if (nodeName(node, adapter).toLowerCase() === pathParts[0].toLowerCase()) {
    index = 1;
  }

  for (; index < pathParts.length; index++) {
    node = await findDirectory(node, pathParts[index], adapter);
    if (!node) return null;
  }
  return node;
}

async function parsedDashcamFiles(node, adapter) {
  const entries = await list(node, adapter);
  return entries
    .filter(entry => entry.kind === 'file')
    .map(entry => ({
      entry,
      parsed: parseDashcamFilename(nodeName(entry, adapter))
    }))
    .filter(({ parsed }) => parsed);
}

function gmcFiles(parsedFiles) {
  return parsedFiles.filter(({ parsed }) => parsed.profileId === GMC_PROFILE_ID);
}

function containsOtherProfile(parsedFiles) {
  return parsedFiles.some(({ parsed }) => parsed.profileId !== GMC_PROFILE_ID);
}

function buildManifest(sourceKind, sourceNode, dateEntries, mixedProfiles = false) {
  const dates = new Map(
    dateEntries
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(item => [item.date, item])
  );

  return {
    profileId: GMC_PROFILE_ID,
    sourceKind,
    sourceNode,
    dates,
    mixedProfiles
  };
}

async function manifestFromContinuous(continuousNode, adapter) {
  const entries = await list(continuousNode, adapter);
  const dates = [];
  let mixedProfiles = false;

  for (const entry of entries) {
    if (entry.kind !== 'directory') continue;
    const date = nodeName(entry, adapter);
    if (!DATE_FOLDER_PATTERN.test(date)) continue;

    const parsedFiles = await parsedDashcamFiles(entry, adapter);
    mixedProfiles ||= containsOtherProfile(parsedFiles);
    const clips = gmcFiles(parsedFiles);
    if (!clips.some(({ parsed }) => parsed.date === date)) continue;

    dates.push({
      date,
      node: entry,
      deletionAllowed: true,
      deletionNode: entry
    });
  }

  if (!dates.length) return null;
  return buildManifest(
    'gmc-continuous',
    continuousNode,
    dates,
    mixedProfiles
  );
}

async function findContinuous(rootNode, adapter) {
  const rootName = nodeName(rootNode, adapter).toLowerCase();
  const continuousFolder = GMC_SOURCE_RULES.continuousFolder;
  if (rootName === continuousFolder.toLowerCase()) return rootNode;

  const direct = await findDirectory(rootNode, continuousFolder, adapter);
  if (direct) return direct;

  const recordings = rootName === 'recordings'
    ? rootNode
    : await findDirectory(rootNode, 'Recordings', adapter);
  if (recordings) {
    return findDirectory(recordings, continuousFolder, adapter);
  }

  return null;
}

async function findRawRecorder(rootNode, adapter) {
  if (nodeName(rootNode, adapter).toLowerCase() === 'surroundvisionrecorder') {
    return rootNode;
  }

  const direct = await findDirectory(rootNode, 'SurroundVisionRecorder', adapter);
  if (direct) return direct;

  return followPath(rootNode, RAW_ANDROID_PATH, adapter);
}

async function manifestFromRawRecorder(recorderNode, adapter) {
  const parsedFiles = await parsedDashcamFiles(recorderNode, adapter);
  const clips = gmcFiles(parsedFiles);
  const uniqueDates = Array.from(new Set(clips.map(({ parsed }) => parsed.date)));
  if (!uniqueDates.length) return null;

  return buildManifest(
    'gmc-raw-flat',
    recorderNode,
    uniqueDates.map(date => ({
      date,
      node: recorderNode,
      deletionAllowed: false,
      deletionNode: null
    })),
    containsOtherProfile(parsedFiles)
  );
}

export async function discoverGmcSource(rootNode, adapter) {
  if (!rootNode || !adapter?.name || !adapter?.list) return null;

  const rootParsedFiles = await parsedDashcamFiles(rootNode, adapter);
  const rootContainsOtherProfile = containsOtherProfile(rootParsedFiles);
  const selectedName = nodeName(rootNode, adapter);
  if (DATE_FOLDER_PATTERN.test(selectedName)) {
    const clips = gmcFiles(rootParsedFiles);
    if (clips.some(({ parsed }) => parsed.date === selectedName)) {
      return buildManifest('gmc-continuous-date', rootNode, [{
        date: selectedName,
        node: rootNode,
        deletionAllowed: true,
        deletionNode: rootNode
      }], rootContainsOtherProfile);
    }
  }

  const continuousNode = await findContinuous(rootNode, adapter);
  if (continuousNode) {
    const continuousManifest = await manifestFromContinuous(continuousNode, adapter);
    if (continuousManifest) {
      continuousManifest.mixedProfiles ||= rootContainsOtherProfile;
      return continuousManifest;
    }
  }

  const recorderNode = await findRawRecorder(rootNode, adapter);
  if (recorderNode) {
    const manifest = await manifestFromRawRecorder(recorderNode, adapter);
    if (manifest) manifest.mixedProfiles ||= rootContainsOtherProfile;
    return manifest;
  }

  return null;
}

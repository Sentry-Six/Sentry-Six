import { getDashcamProfile } from './dashcamProfiles.mjs';

function timestampKeyToEpochMs(timestampKey) {
  const match = String(timestampKey || '').match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0
  ).getTime();
}

function collectionDeletion(day, options) {
  const explicit = options.deletionByDate?.get(day);
  if (explicit) {
    return {
      allowed: explicit.allowed === true,
      path: explicit.allowed === true ? explicit.path || null : null
    };
  }
  if (options.sourceKind === 'gmc-raw-flat') {
    return { allowed: false, path: null };
  }
  return undefined;
}

function buildCollection(id, day, clipType, groups, options) {
  const profile = getDashcamProfile(options.profileId);
  const startEpochMs = timestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
  const lastStart = timestampKeyToEpochMs(
    groups[groups.length - 1]?.timestampKey
  ) ?? startEpochMs;
  const endEpochMs =
    lastStart + profile.defaultSegmentDurationSeconds * 1000;
  const deletion = collectionDeletion(day, options);

  const collection = {
    id,
    key: id,
    day,
    profileId: profile.id,
    clipType,
    tag: clipType === 'Custom'
      ? profile.customCollectionLabel
      : clipType,
    groups,
    meta: null,
    durationMs: Math.max(1, endEpochMs - startEpochMs),
    segmentStartsMs: groups.map(group => {
      const timestamp = timestampKeyToEpochMs(group.timestampKey) ?? startEpochMs;
      return Math.max(0, timestamp - startEpochMs);
    }),
    anchorMs: 0,
    anchorGroupId: groups[0]?.id || null,
    sortEpoch: endEpochMs
  };

  if (deletion) collection.deletion = deletion;
  return collection;
}

export function buildDashcamCollections(groups, options = {}) {
  const normalizedOptions = {
    ...options,
    profileId: options.profileId || groups?.[0]?.profileId || 'tesla'
  };
  const byDay = new Map();
  const allDates = new Set();

  for (const group of groups || []) {
    const day = String(group.timestampKey || '').split('_')[0] || 'Unknown';
    const type = String(group.tag || '').toLowerCase();
    allDates.add(day);

    if (!byDay.has(day)) {
      byDay.set(day, {
        recent: [],
        sentry: new Map(),
        saved: new Map(),
        custom: []
      });
    }
    const dayData = byDay.get(day);

    if (type === 'recentclips') {
      dayData.recent.push(group);
    } else if (type === 'sentryclips' && group.eventId) {
      if (!dayData.sentry.has(group.eventId)) {
        dayData.sentry.set(group.eventId, []);
      }
      dayData.sentry.get(group.eventId).push(group);
    } else if (type === 'savedclips' && group.eventId) {
      if (!dayData.saved.has(group.eventId)) {
        dayData.saved.set(group.eventId, []);
      }
      dayData.saved.get(group.eventId).push(group);
    } else {
      dayData.custom.push(group);
    }
  }

  const collections = new Map();
  const sortGroups = list => list.sort((a, b) =>
    String(a.timestampKey || '').localeCompare(String(b.timestampKey || ''))
  );

  for (const [day, dayData] of byDay) {
    if (dayData.recent.length) {
      const id = `recent:${day}`;
      collections.set(id, buildCollection(
        id,
        day,
        'RecentClips',
        sortGroups(dayData.recent),
        normalizedOptions
      ));
    }

    for (const [eventId, eventGroups] of dayData.sentry) {
      const id = `sentry:${day}:${eventId}`;
      const collection = buildCollection(
        id,
        day,
        'SentryClips',
        sortGroups(eventGroups),
        normalizedOptions
      );
      collection.eventId = eventId;
      collection.eventTime = eventId.split('_')[1]?.replace(/-/g, ':') || '';
      collections.set(id, collection);
    }

    for (const [eventId, eventGroups] of dayData.saved) {
      const id = `saved:${day}:${eventId}`;
      const collection = buildCollection(
        id,
        day,
        'SavedClips',
        sortGroups(eventGroups),
        normalizedOptions
      );
      collection.eventId = eventId;
      collection.eventTime = eventId.split('_')[1]?.replace(/-/g, ':') || '';
      collections.set(id, collection);
    }

    if (dayData.custom.length) {
      const id = `custom:${day}`;
      const collection = buildCollection(
        id,
        day,
        'Custom',
        sortGroups(dayData.custom),
        normalizedOptions
      );
      collection.isCustomStructure = true;
      collections.set(id, collection);
    }
  }

  return {
    collections,
    allDates: Array.from(allDates).sort().reverse(),
    dayData: byDay
  };
}

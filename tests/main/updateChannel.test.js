/**
 * Tests for the update channel in src/main/autoUpdate.js.
 *
 * The channel decides two things that must never disagree: which GitHub branch
 * the raw-file paths read (version.json, changelog, dev-install zip) and which
 * release feed electron-updater points at. It also has to keep faith with the
 * legacy `updateBranch` setting written by the dropdown that shipped until the
 * 2026.6.11 UI overhaul removed it.
 */

jest.mock('electron');
jest.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: jest.fn(),
    allowPrerelease: false,
    allowDowngrade: false
  }
}));

const { autoUpdater } = require('electron-updater');
const {
  UPDATE_CONFIG,
  UPDATE_CHANNELS,
  applyUpdateChannel,
  resolveUpdateChannel
} = require('../../src/main/autoUpdate');

beforeEach(() => {
  autoUpdater.setFeedURL.mockClear();
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
});

describe('resolveUpdateChannel', () => {
  test('defaults to stable when nothing is configured', () => {
    expect(resolveUpdateChannel({}).id).toBe('stable');
    expect(resolveUpdateChannel(undefined).id).toBe('stable');
  });

  test('honours an explicit channel', () => {
    const channel = resolveUpdateChannel({ updateChannel: 'prerelease' });

    expect(channel.id).toBe('prerelease');
    expect(channel.branch).toBe('Dev-SEI');
    expect(channel.releaseType).toBe('prerelease');
  });

  test('stable channel tracks the default branch', () => {
    const channel = resolveUpdateChannel({ updateChannel: 'stable' });

    expect(channel.branch).toBe(UPDATE_CONFIG.defaultBranch);
    expect(channel.releaseType).toBe('release');
  });

  test('falls back to stable for an unknown channel id', () => {
    expect(resolveUpdateChannel({ updateChannel: 'nightly' }).id).toBe('stable');
  });

  // Anyone who picked Dev-SEI in the old dropdown still has updateBranch set and
  // no updateChannel — they must stay on pre-releases, not be moved to stable.
  test('migrates a legacy non-default updateBranch to the prerelease channel', () => {
    expect(resolveUpdateChannel({ updateBranch: 'Dev-SEI' }).id).toBe('prerelease');
  });

  test('treats a legacy main updateBranch as stable', () => {
    expect(resolveUpdateChannel({ updateBranch: 'main' }).id).toBe('stable');
  });

  test('an explicit channel wins over a stale legacy branch', () => {
    const settings = { updateChannel: 'stable', updateBranch: 'Dev-SEI' };

    expect(resolveUpdateChannel(settings).id).toBe('stable');
  });
});

describe('applyUpdateChannel', () => {
  test('points the feed at published releases on stable', () => {
    applyUpdateChannel(UPDATE_CHANNELS.stable);

    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: UPDATE_CONFIG.owner,
      repo: UPDATE_CONFIG.repo,
      releaseType: 'release'
    });
  });

  test('points the feed at prereleases and opts in to them', () => {
    applyUpdateChannel(UPDATE_CHANNELS.prerelease);

    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: UPDATE_CONFIG.owner,
      repo: UPDATE_CONFIG.repo,
      releaseType: 'prerelease'
    });
  });

  // Regression: turning the toggle off has to be able to walk BACK to stable.
  //
  // Sentry Studio ships betas under ordinary version numbers ("Sentry Studio
  // Beta Release v2026.26.34"), flagged prerelease on the GitHub release rather
  // than carrying an -rc/-beta suffix. So a beta's version is usually higher
  // than the newest stable and the revert is a downgrade. An earlier revision
  // gated allowDowngrade on a '-' in the version — which never matches here —
  // and left users stuck on the beta with no way back.
  test('grants a downgrade when one is explicitly requested', () => {
    applyUpdateChannel(UPDATE_CHANNELS.stable, { allowDowngrade: true });

    expect(autoUpdater.allowDowngrade).toBe(true);
  });

  // Ordinary channel application must NOT hand out the permission, or a
  // republished older release could roll stable users backwards.
  test.each([
    ['stable', UPDATE_CHANNELS.stable],
    ['prerelease', UPDATE_CHANNELS.prerelease]
  ])('does not grant a downgrade on a plain %s application', (_name, channel) => {
    applyUpdateChannel(channel);

    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // The flag is written on EVERY application, not only when granting. A
  // one-way guard would make it impossible to withdraw — including from the
  // dev pre-release cleanup, whose whole job is to undo what the attempt
  // changed. Continuity across sessions comes from the persisted
  // pendingDowngrade flag being passed back in, not from stickiness here.
  test('withdraws the permission when a later application does not ask for it', () => {
    applyUpdateChannel(UPDATE_CHANNELS.stable, { allowDowngrade: true });
    applyUpdateChannel(UPDATE_CHANNELS.stable);

    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // Switching channels invalidates whatever the previous one resolved.
  // checkForUpdates() returns an in-flight promise rather than starting a fresh
  // check, and electron-updater never clears updateInfoAndProvider on the
  // not-available branch — so a stale offer would otherwise stay installable
  // through the old provider after a switch.
  test('drops state left over from the previous channel', () => {
    autoUpdater.checkForUpdatesPromise = Promise.resolve('stale');
    autoUpdater.updateInfoAndProvider = { info: { version: '9999.1.1' } };

    applyUpdateChannel(UPDATE_CHANNELS.prerelease);

    expect(autoUpdater.checkForUpdatesPromise).toBeNull();
    expect(autoUpdater.updateInfoAndProvider).toBeNull();
  });

  test('returns the channel it applied', () => {
    expect(applyUpdateChannel(UPDATE_CHANNELS.prerelease))
      .toBe(UPDATE_CHANNELS.prerelease);
  });
});

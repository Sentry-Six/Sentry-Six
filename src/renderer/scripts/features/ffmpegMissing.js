/**
 * Turns the main process's ffmpegMissingInfo() (sent by the ffmpeg:check IPC
 * as `missing`) into the translated export-modal status. The main process
 * decides which case applies and supplies the command, folder and URL, so
 * this module only picks the matching translation.
 */

const MISSING_KEYS = Object.freeze({
    packaged: 'ui.export.ffmpegMissingPackaged',
    'source-macos': 'ui.export.ffmpegMissingSourceMac',
    'source-linux': 'ui.export.ffmpegMissingSourceLinux',
    'source-windows': 'ui.export.ffmpegMissingSourceWin'
});

export const FFMPEG_RELEASES_URL = 'https://github.com/Sentry-Six/Sentry-Six/releases/latest';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function ffmpegMissingKey(missing) {
    return MISSING_KEYS[missing?.reason] || MISSING_KEYS.packaged;
}

/**
 * Returns status HTML. The link carries data-external-url; the caller opens
 * it through electronAPI.openExternal.
 */
export function ffmpegMissingHtml(missing, translate) {
    const key = ffmpegMissingKey(missing);
    const url = key === MISSING_KEYS.packaged ? (missing?.url || FFMPEG_RELEASES_URL) : null;
    const params = {};
    if (url) {
        const label = url.replace(/^https:\/\//, '').replace(/\/latest$/, '');
        params.url = `<a href="#" data-external-url="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    }
    if (missing?.command) params.command = `<code>${escapeHtml(missing.command)}</code>`;
    if (missing?.folder) params.folder = `<code>${escapeHtml(missing.folder)}</code>`;
    return translate(key, params);
}

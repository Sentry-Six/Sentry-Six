export function cssEscape(s) {
  if (window.CSS?.escape) return window.CSS.escape(String(s));
  // minimal escape for attribute selector usage
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * Encode a file path for use in a file:// URL.
 * Unlike encodeURI(), this also encodes # and ? characters which are valid URI
 * characters but have special meaning (fragment/query) and break file paths.
 * @param {string} filePath - The file path to encode
 * @returns {string} The encoded file:// URL
 */
export function filePathToUrl(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  // encodeURI handles most characters but NOT # and ? which have special URL meaning
  // We need to encode those separately after encodeURI
  const encoded = encodeURI(normalizedPath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  return normalizedPath.startsWith('/')
    ? `file://${encoded}`
    : `file:///${encoded}`;
}

const MEDIA_ERROR_TEXT = {
  1: 'playback aborted',
  2: 'network error while loading the file',
  3: 'the file could not be decoded (corrupt or unsupported codec)',
  4: 'the file is missing or its format is not supported'
};

/**
 * Describe the failure on a <video>/<audio> element.
 * A media `error` event carries no message of its own - the detail lives in
 * element.error (a MediaError), so read it from there.
 * @param {HTMLMediaElement} el
 * @returns {string} Human-readable reason
 */
export function describeMediaError(el) {
  const mediaError = el?.error;
  if (!mediaError) return 'the video element reported an error with no details';
  const reason = MEDIA_ERROR_TEXT[mediaError.code] || `media error code ${mediaError.code}`;
  // Chromium usually fills in a decoder-specific note here; keep it when present.
  return mediaError.message ? `${reason} (${mediaError.message})` : reason;
}

/**
 * Turn anything thrown or rejected into a readable string.
 * Plain String() on a DOM Event yields "[object Event]", which is what users
 * were shown when a video failed to load, so unwrap those explicitly.
 * @param {unknown} err
 * @returns {string} Human-readable message
 */
export function formatError(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  // ErrorEvent is itself an Event, so check it first - it has a real message.
  if (typeof ErrorEvent !== 'undefined' && err instanceof ErrorEvent && err.message) return err.message;
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const target = err.target;
    if (target instanceof HTMLMediaElement) return describeMediaError(target);
    return `${err.type} event on ${target?.tagName?.toLowerCase() || 'unknown element'}`;
  }
  if (err.message) return String(err.message);
  const text = String(err);
  return text === '[object Object]' ? 'unknown error' : text;
}


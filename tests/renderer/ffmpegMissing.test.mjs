import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ffmpegMissingHtml, ffmpegMissingKey } from '../../src/renderer/scripts/features/ffmpegMissing.js';

const source = await readFile(new URL('../../src/renderer/scripts/data/translations.js', import.meta.url), 'utf8');
const { translations } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const PLACEHOLDERS = {
  ffmpegMissingPackaged: ['{url}'],
  ffmpegMissingSourceMac: ['{command}', '{folder}'],
  ffmpegMissingSourceLinux: ['{command}'],
  ffmpegMissingSourceWin: ['{command}']
};

function translator(locale) {
  return (key, params = {}) => {
    let value = key.split('.').reduce((node, part) => node?.[part], translations[locale]);
    assert.equal(typeof value, 'string', `${locale} is missing ${key}`);
    for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, replacement);
    return value;
  };
}

test('every locale has each FFmpeg-missing message with its placeholders and no Homebrew advice', () => {
  for (const [locale, values] of Object.entries(translations)) {
    const exportKeys = values.ui.export;
    assert.equal(exportKeys.ffmpegRequiredMac, undefined, `${locale} still has ffmpegRequiredMac`);
    assert.equal(exportKeys.ffmpegRequiredWin, undefined, `${locale} still has ffmpegRequiredWin`);
    for (const [key, placeholders] of Object.entries(PLACEHOLDERS)) {
      const text = exportKeys[key];
      assert.equal(typeof text, 'string', `${locale} ui.export.${key}`);
      for (const placeholder of placeholders) assert.ok(text.includes(placeholder), `${locale} ${key} lacks ${placeholder}`);
      assert.doesNotMatch(text, /brew/i, `${locale} ${key}`);
    }
  }
});

test('picks the message for the case the main process reports', () => {
  assert.equal(ffmpegMissingKey({ reason: 'packaged' }), 'ui.export.ffmpegMissingPackaged');
  assert.equal(ffmpegMissingKey({ reason: 'source-macos' }), 'ui.export.ffmpegMissingSourceMac');
  assert.equal(ffmpegMissingKey({ reason: 'source-linux' }), 'ui.export.ffmpegMissingSourceLinux');
  assert.equal(ffmpegMissingKey({ reason: 'source-windows' }), 'ui.export.ffmpegMissingSourceWin');
  // An unknown or absent case falls back to the reinstall guidance.
  assert.equal(ffmpegMissingKey(undefined), 'ui.export.ffmpegMissingPackaged');
});

test('renders every locale with the command, folder and releases link filled in', () => {
  for (const locale of Object.keys(translations)) {
    const t = translator(locale);
    const packaged = ffmpegMissingHtml({ reason: 'packaged', url: 'https://github.com/Sentry-Six/Sentry-Six/releases/latest' }, t);
    assert.match(packaged, /<a href="#" data-external-url="https:\/\/github\.com\/Sentry-Six\/Sentry-Six\/releases\/latest">github\.com\/Sentry-Six\/Sentry-Six\/releases<\/a>/);
    const mac = ffmpegMissingHtml({ reason: 'source-macos', command: 'node scripts/prepare-macos-ffmpeg.js', folder: 'ffmpeg_bin/macos/arm64' }, t);
    assert.ok(mac.includes('<code>node scripts/prepare-macos-ffmpeg.js</code>'), locale);
    assert.ok(mac.includes('<code>ffmpeg_bin/macos/arm64</code>'), locale);
    for (const html of [packaged, mac]) assert.doesNotMatch(html, /\{(url|command|folder)\}/, locale);
  }
});

test('escapes values from the main process', () => {
  const html = ffmpegMissingHtml({ reason: 'source-linux', command: '<b>x</b>' }, translator('en'));
  assert.ok(html.includes('<code>&lt;b&gt;x&lt;/b&gt;</code>'));
});

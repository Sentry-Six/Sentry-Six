import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../src/renderer/scripts/data/translations.js', import.meta.url), 'utf8');
const { translations } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('every locale says when the map is temporarily unavailable', () => {
  assert.equal(Object.keys(translations).length, 13);
  for (const [locale, values] of Object.entries(translations)) {
    const text = values.ui.settings.mapUnavailableNotice;
    assert.equal(typeof text, 'string', `${locale} ui.settings.mapUnavailableNotice`);
    assert.ok(text.length > 10, locale);
    assert.equal(values.ui.settings.mapProviderFallbackNotice, undefined, `${locale} still has mapProviderFallbackNotice`);
    assert.doesNotMatch(text, /OpenStreetMap/, locale);
  }
});

test('the privacy notice names tiles.sentryusb.com as the only map tile source', () => {
  for (const [locale, values] of Object.entries(translations)) {
    for (const key of ['privacyMessage', 'returningMessage']) {
      const text = values.welcomeScreen[key];
      assert.match(text, /tiles\.sentryusb\.com/, `${locale} ${key}`);
      // OpenStreetMap is named only for the opt-in Nominatim place lookups.
      assert.doesNotMatch(text.replaceAll('OpenStreetMap Nominatim', ''), /OpenStreetMap/, `${locale} ${key}`);
    }
  }
});

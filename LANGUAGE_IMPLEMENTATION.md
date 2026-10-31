# Multi-Language Support Implementation

## Overview
This document describes the multi-language (internationalization/i18n) system implemented for Sentry Studio.

## Features
- **13 Languages Supported**: English, Spanish, French, German, Chinese (Simplified), Japanese, Korean, Portuguese, Russian, Italian, Dutch, Polish, Turkish
- **Dynamic Language Switching**: Change language without restarting the application - 95%+ of UI updates instantly
- **Persistent Settings**: Language preference is saved and restored on app restart
- **Export Compatibility**: All export functionality works correctly in any language without breaking layout
- **Notification Translations**: Success/error messages appear in the selected language
- **Welcome Guide Integration**: First-run experience includes language selector with instant translation
- **Cross-Component Sync**: Language changes in Welcome Guide sync with Settings modal and vice versa
- **Comprehensive Coverage**: Settings, Export modal, Dashboard, Cameras, Clip Browser, Map, Welcome Guide all translate instantly

## Key Files

### Core Modules
1. **`src/renderer/scripts/lib/i18n.js`**
   - Core internationalization module
   - Functions: `initI18n()`, `t()`, `setLanguage()`, `getCurrentLanguage()`, `getAvailableLanguages()`, `translatePage()`
   - Handles translation key lookup with fallback to English
   - Supports parameter interpolation (e.g., `{count}` in strings)

2. **`src/renderer/scripts/data/translations.js`**
   - Translation strings for all 13 supported languages
   - Organized by category: `ui.dropOverlay`, `ui.startup`, `ui.loading`, `ui.clipBrowser`, `ui.changelog`, `ui.eventTypes`, `ui.map`, `ui.playback`, `ui.export`, `ui.settings`, `ui.cameras`, `ui.dashboard`, `ui.notifications`, `ui.supportChat`, `ui.sharedClips`, plus top-level `welcome` (Welcome Guide) and `welcomeScreen` (privacy notice)
   - Export keys include: position options, blur zone editor, FFmpeg status, warnings
   - Compact format to minimize file size while maintaining readability

### Integration Points
1. **`src/renderer/index.html`**
   - Added language selector dropdown in Settings modal
   - Added `data-i18n` attributes to Settings modal elements
   - Added `data-i18n` attributes to Export modal elements
   - Added `data-i18n` attributes to camera labels in multi-cam view
   - Added `data-i18n` attributes to clip browser elements
   - Added `data-i18n` attributes to map controls
   - Added `data-i18n` attributes to Welcome Guide (all 9 steps)
   - Added language selector in Welcome Guide step 1

2. **`src/renderer/scripts/ui/settingsModal.js`**
   - Imported i18n functions
   - Added language selector initialization and change handler
   - Loads saved language preference on modal open
   - Added `onLanguageChange` listener to sync dropdown when language changes from other sources (e.g., Welcome Guide)

3. **`src/renderer/script.js`**
   - Imported i18n module
   - Calls `initI18n()` at application startup
   - Language system initializes before any UI rendering
   - Added `onLanguageChange` listener to update dashboard labels dynamically
   - Added `onLanguageChange` listener to re-render clip list when language changes
   - Updated `formatEventReason()` to use `t()` function for event type translations

4. **`src/renderer/scripts/features/exportVideo.js`**
   - Imported `t()` function for translations
   - Updated notification messages to use translation keys:
     - `t('ui.notifications.loadCollectionFirst')`
     - `t('ui.notifications.startMarkerSet')`
     - `t('ui.notifications.endMarkerSet')`
   - Updated FFmpeg status messages to use translations
   - Updated blur zone camera names and status messages
   - Updated output banner text

5. **`src/renderer/scripts/ui/layoutLab.js`**
   - Imported `t()` function for translations
   - Added `getCameraLabel()` helper function for translated camera names
   - Camera labels on export layout canvas now translate dynamically

6. **`src/renderer/scripts/ui/supportChat.js`**
   - Imported `t()` function for translations
   - All Support Chat UI elements use `data-i18n` attributes and `t()` calls
   - Includes: title, welcome message, buttons, placeholders, privacy note, ticket status

7. **`src/renderer/scripts/ui/welcomeGuide.js`**
   - Imported i18n functions (`getCurrentLanguage`, `setLanguage`, `getAvailableLanguages`, `onLanguageChange`, `translatePage`)
   - Added language dropdown population in `initWelcomeGuide()`
   - Added language change handler that updates all welcome guide text instantly
   - Added `onLanguageChange` listener to update button text when language changes
   - Made `updateStep()` function async to support dynamic button text translation

8. **`src/renderer/scripts/core/clipBrowser.js`**
   - Imported `t()` function
   - Updated clip titles to use translations: `t('ui.clipBrowser.recent')`, `t('ui.clipBrowser.sentry')`, `t('ui.clipBrowser.saved')`
   - Updated segment count text to use singular/plural translations
   - Exposed `renderClipList()` globally for language change updates

## Usage

### For Users
1. Open Settings (gear icon in playback controls)
2. Go to the Display section
3. Find "Language" dropdown
4. Select desired language
5. UI updates immediately - no restart required

### For Developers

#### Adding a New Translation Key
```javascript
// In translations.js, add to all language objects:
export const translations = {
    en: {
        ui: {
            newFeature: {
                title: "New Feature",
                description: "This is a new feature"
            }
        }
    },
    es: {
        ui: {
            newFeature: {
                title: "Nueva Función",
                description: "Esta es una nueva función"
            }
        }
    }
    // ... repeat for all languages
};
```

#### Using Translations in Code
```javascript
import { t } from './scripts/lib/i18n.js';

// Simple translation
const title = t('ui.newFeature.title');

// With parameters
const message = t('ui.loading.filesFound', { count: 42 });
// Returns: "42 files found" (or translated equivalent)
```

#### Using Translations in HTML
```html
<!-- Add data-i18n attribute to elements -->
<button data-i18n="ui.playback.play">Play</button>

<!-- For attributes like title/placeholder -->
<input data-i18n-placeholder="ui.search.placeholder" />
<button data-i18n-title="ui.tooltip.save">💾</button>

<!-- Call translatePage() after language change to update all elements -->
```

## Translation Coverage

### Currently Translated (95%+ Complete)
- **Settings Modal** - All labels, descriptions, buttons, dropdown options across all sections
- **Export Modal** - All sections, labels, buttons, descriptions, toggles
- **Export Modal Position Dropdowns** - Bottom Center, Top Left, Top Right, etc.
- **Export Modal Blur Zone Editor** - Title, instructions, Cancel/Save buttons, blur type options
- **Export Modal Warnings/Banners** - FFmpeg status, GPU warning, front camera warning, dashboard prerendered
- **Dashboard** - Speed units, autopilot states (Manual, No Data, Self Driving, Autosteer, TACC)
- **Camera Labels** - All 6 cameras (Front, Back, Left/Right Pillar, Left/Right Repeater)
- **Camera Layout Canvas** - Camera labels in export layout preview
- **Clip Browser** - Event type labels (Recent, Sentry, Saved), segment counts
- **Event Types** - Manual Save, Honk, Object Detected, Emergency Braking, Acceleration Detected, Collision Detected
- **Map Controls** - Re-center button, hint text
- **Welcome Guide** - All 9 steps, navigation buttons, language selector
- **Support Chat** - Title, welcome message, buttons, placeholders, privacy note, ticket status
- **Notification Messages** - Export markers, completion, errors
- **Drop Overlay** - Folder selection messages
- **Loading Indicators** - Scanning, file count messages

### Not Yet Translated (5% Remaining)
Only a small number of UI elements remain:
- **Playback Controls** - Play/Pause button in main controls bar (skip buttons and speed selector are translated)
- **Welcome Guide Preview Text** - Some static example text in preview mockups

These can be easily added by:
1. Adding `data-i18n` attributes to the remaining HTML elements
2. Adding corresponding translation keys to `translations.js`
3. The `translatePage()` function will automatically handle them

## Language-Specific Considerations

### Layout Preservation
- All translations are designed to fit within existing UI constraints
- Longer languages (German, Russian) use appropriate abbreviations where needed
- Camera labels use short forms (e.g., "L Pillar" vs "Left Pillar") in compact views

### Right-to-Left (RTL) Languages
Currently not supported. To add RTL support (Arabic, Hebrew):
1. Add `dir="rtl"` attribute handling in `setLanguage()`
2. Update CSS with RTL-specific styles
3. Mirror UI elements appropriately

### Date/Time Formatting
Date format setting is separate from language setting, allowing users to choose:
- MM/DD/YYYY (US)
- DD/MM/YYYY (International)
- YYYY-MM-DD (ISO)

This works independently of the selected language.

## Technical Details

### Translation Key Structure
```
ui.{section}.{element}
```

Examples:
- `ui.playback.play` → "Play"
- `ui.export.title` → "Export Video"
- `ui.cameras.front` → "Front"

### Fallback Mechanism
If a translation key is missing in the selected language:
1. System attempts to use English translation
2. If English is also missing, returns the key itself
3. Logs warning to console for debugging

### Performance
- Translations are loaded once at startup
- Language switching is instant (no file loading)
- Translation lookup is O(1) using object property access
- All languages live in a single `translations.js` file (~320KB)

## Future Enhancements

1. **Complete Remaining 5%**: Add a translated tooltip to the Play/Pause button
2. **Pluralization Support**: Handle singular/plural forms properly (e.g., "1 file" vs "2 files") - Partially implemented for segments
3. **Number/Currency Formatting**: Locale-specific number formatting
4. **RTL Language Support**: Add Arabic, Hebrew, etc.
5. **Translation Validation**: Tool to check for missing keys across languages
6. **Community Translations**: Allow users to contribute translations via GitHub
7. **Context-Aware Translations**: Different translations based on UI context

## Testing Checklist

- [x] Language selector appears in Settings
- [x] Language selector appears in Welcome Guide (step 1)
- [x] Language changes persist across app restarts
- [x] Language syncs between Welcome Guide and Settings modal
- [x] Export notifications appear in selected language
- [x] No layout breaking with longer translations
- [x] All 13 languages load without errors
- [x] Settings modal translates instantly without restart
- [x] Export modal translates instantly without restart
- [x] Dashboard labels update dynamically
- [x] Camera labels translate in multi-cam view
- [x] Clip browser updates when language changes
- [x] Event types translate correctly
- [x] Map controls translate instantly
- [x] Welcome Guide translates all 9 steps instantly
- [x] Autopilot states translate (Self Driving, Autosteer, TACC)
- [x] Skip buttons and speed selector tooltips translate
- [ ] Play/Pause button translates (remaining 5%)

## Support

For translation issues or to contribute new languages:
1. Check `src/renderer/scripts/data/translations.js` for existing structure
2. Follow the same key hierarchy for consistency
3. Test with actual UI to ensure translations fit properly
4. Submit pull request with new language or corrections

---

**Implementation Date**: January 2026  
**Version**: 2026.3.1+  
**Status**: 95%+ Complete - Fully functional multi-language system with instant translation

/**
 * Internationalization (i18n) Module
 * Handles multi-language support for the application
 */

import { translations } from '../data/translations.js';

// Current language (default: English)
let currentLanguage = 'en';

// Language change listeners
const languageChangeListeners = [];

/**
 * Initialize i18n system
 * Loads saved language preference or auto-detects from system
 */
export async function initI18n() {
    let savedLang = null;
    
    if (window.electronAPI?.getSetting) {
        savedLang = await window.electronAPI.getSetting('language');
    }
    
    if (savedLang && translations[savedLang]) {
        // Use saved language preference
        currentLanguage = savedLang;
    } else {
        // First launch or no saved preference - detect system language
        currentLanguage = detectSystemLanguage();
        
        // Save the detected language so it persists
        if (window.electronAPI?.setSetting) {
            await window.electronAPI.setSetting('language', currentLanguage);
        }
    }
    
    // Apply language to HTML
    document.documentElement.lang = currentLanguage;
    
    // Translate all elements with data-i18n attribute
    translatePage();
    
    // Also translate option elements inside selects
    translateSelectOptions();
    
    // Notify listeners so dropdowns can sync with detected language
    languageChangeListeners.forEach(listener => listener(currentLanguage));
}

/**
 * Detect the system/browser language and match to supported languages
 * Works cross-platform: Windows, macOS, Linux via navigator.language
 * @returns {string} Language code (defaults to 'en' if no match)
 */
function detectSystemLanguage() {
    // navigator.language returns the browser's UI language (follows OS settings)
    // navigator.languages returns a list of preferred languages in order
    // This works cross-platform: Windows, macOS, Linux
    const languages = navigator.languages || [navigator.language || 'en'];
    
    // Get list of our supported language codes
    const supportedLanguages = Object.keys(translations);
    
    // Try to find a match from the user's preferred languages
    for (const browserLang of languages) {
        // Extract the base language code (e.g., "en-US" -> "en", "zh-CN" -> "zh")
        const baseLang = browserLang.split('-')[0].toLowerCase();
        
        // Check for exact match with our supported languages
        if (supportedLanguages.includes(baseLang)) {
            console.log(`Auto-detected language: ${baseLang} (from ${browserLang})`);
            return baseLang;
        }
    }
    
    // Default to English if no match found
    console.log('No matching language found, defaulting to English');
    return 'en';
}

/**
 * Get translated string for a key
 * @param {string} key - Translation key (e.g., 'ui.playback.play')
 * @param {Object} params - Optional parameters for string interpolation
 * @returns {string} Translated string
 */
export function t(key, params = {}) {
    const keys = key.split('.');
    let value = translations[currentLanguage];
    
    // Navigate through nested keys
    for (const k of keys) {
        if (value && typeof value === 'object') {
            value = value[k];
        } else {
            // Fallback to English if key not found
            value = translations['en'];
            for (const fallbackKey of keys) {
                if (value && typeof value === 'object') {
                    value = value[fallbackKey];
                } else {
                    break;
                }
            }
            break;
        }
    }
    
    // If still not found, return the key itself
    if (typeof value !== 'string') {
        console.warn(`Translation key not found: ${key}`);
        return key;
    }
    
    // Replace parameters in string (e.g., {name} -> John)
    let result = value;
    for (const [param, val] of Object.entries(params)) {
        result = result.replace(new RegExp(`\\{${param}\\}`, 'g'), val);
    }
    
    return result;
}

/**
 * Get current language code
 * @returns {string} Current language code (e.g., 'en', 'es', 'zh')
 */
export function getCurrentLanguage() {
    return currentLanguage;
}

/**
 * Set current language
 * @param {string} lang - Language code
 */
export async function setLanguage(lang) {
    if (!translations[lang]) {
        console.error(`Language not supported: ${lang}`);
        return;
    }
    
    currentLanguage = lang;
    document.documentElement.lang = lang;
    
    // Save to settings
    if (window.electronAPI?.setSetting) {
        await window.electronAPI.setSetting('language', lang);
    }
    
    // Translate all elements with data-i18n attributes
    translatePage();
    
    // Also translate option elements inside selects
    translateSelectOptions();
    
    // Notify listeners (for dynamic dashboard updates)
    languageChangeListeners.forEach(listener => listener(lang));
}

/**
 * Get list of available languages
 * @returns {Array} Array of {code, name, nativeName}
 */
export function getAvailableLanguages() {
    return [
        { code: 'en', name: 'English', nativeName: 'English' },
        { code: 'es', name: 'Spanish', nativeName: 'Español' },
        { code: 'fr', name: 'French', nativeName: 'Français' },
        { code: 'de', name: 'German', nativeName: 'Deutsch' },
        { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文' },
        { code: 'ja', name: 'Japanese', nativeName: '日本語' },
        { code: 'ko', name: 'Korean', nativeName: '한국어' },
        { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
        { code: 'ru', name: 'Russian', nativeName: 'Русский' },
        { code: 'it', name: 'Italian', nativeName: 'Italiano' },
        { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
        { code: 'pl', name: 'Polish', nativeName: 'Polski' },
        { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' }
    ];
}

/**
 * Register a listener for language changes
 * @param {Function} callback - Callback function(lang)
 */
export function onLanguageChange(callback) {
    languageChangeListeners.push(callback);
    return () => {
        const index = languageChangeListeners.indexOf(callback);
        if (index !== -1) languageChangeListeners.splice(index, 1);
    };
}

/**
 * Translate all elements with data-i18n attribute
 */
export function translatePage() {
    // Translate elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        // Support parameterized translations via data-i18n-params attribute (JSON)
        let params = {};
        const paramsAttr = el.getAttribute('data-i18n-params');
        if (paramsAttr) {
            try { params = JSON.parse(paramsAttr); } catch (e) { /* ignore parse errors */ }
        }
        const translation = t(key, params);

        // Check if element has data-i18n-attr to translate attributes
        const attrToTranslate = el.getAttribute('data-i18n-attr');
        if (attrToTranslate) {
            el.setAttribute(attrToTranslate, translation);
        } else if (el.hasAttribute('data-i18n-html')) {
            // Use innerHTML for elements that contain HTML tags in translations
            el.innerHTML = translation;
        } else {
            // Default: translate text content
            el.textContent = translation;
        }
    });
    
    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
    });
    
    // Translate titles/tooltips
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const translated = t(key);
        el.title = translated;
        // Sync fast tooltip
        el.setAttribute('data-tip', translated);
    });
}

/**
 * Translate select option elements
 */
function translateSelectOptions() {
    document.querySelectorAll('select option[data-i18n]').forEach(option => {
        const key = option.getAttribute('data-i18n');
        option.textContent = t(key);
    });
}

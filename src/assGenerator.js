/**
 * ASS Subtitle Generator for Compact Dashboard Export
 * Generates .ass subtitle files from SEI telemetry data for high-speed FFmpeg rendering
 * 
 * This replaces the BrowserWindow capture loop for compact dashboard style,
 * enabling GPU-accelerated exports that run at maximum encoder speed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Constants
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
const FPS = 36; // Tesla cameras record at ~36fps

// ASS color format: &HAABBGGRR (alpha, blue, green, red)
const COLORS = {
  white: '&H00FFFFFF',
  whiteTransparent: '&H80FFFFFF',
  dimWhite: '&H00808080',
  green: '&H0022C55E',      // #22c55e (blinker active)
  blue: '&H00FF4800',       // #0048ff (autopilot active) - BGR format
  red: '&H000000FF',        // Brake active
  dimGray: '&H00404040',
  transparent: '&HFF000000'
};

// Dashboard text translations for all supported languages
// These are kept compact to preserve layout in exported videos
const DASHBOARD_TRANSLATIONS = {
  en: {
    gear: { 0: 'PARK', 1: 'DRIVE', 2: 'REVERSE', 3: 'NEUTRAL' },
    ap: { 0: 'Manual', 1: 'Self Driving', 2: 'Autosteer', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'No Data',
    labels: { speed: 'Speed', gear: 'Gear', steering: 'Steering', accelerator: 'Accelerator', brake: 'Brake', blinkers: 'Blinkers', autopilot: 'Autopilot', gps: 'GPS', heading: 'Heading', gForce: 'G-Force', lateral: 'Lateral', longitudinal: 'Longitudinal' , dateTime: 'Date/Time'},
    brakeStates: { on: 'ON', off: 'OFF' },
    apStates: { off: 'OFF', fsd: 'FSD Supervised', autopilot: 'Autopilot', tacc: 'TACC' }
  },
  es: {
    gear: { 0: 'PARK', 1: 'CONDUCIR', 2: 'REVERSA', 3: 'NEUTRAL' },
    ap: { 0: 'Manual', 1: 'Autónomo', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Sin Datos',
    labels: { speed: 'Velocidad', gear: 'Marcha', steering: 'Dirección', accelerator: 'Acelerador', brake: 'Freno', blinkers: 'Intermitentes', autopilot: 'Piloto Auto', gps: 'GPS', heading: 'Rumbo', gForce: 'Fuerza G', lateral: 'Lateral', longitudinal: 'Longitudinal' , dateTime: 'Fecha/Hora'},
    brakeStates: { on: 'SÍ', off: 'NO' },
    apStates: { off: 'OFF', fsd: 'FSD Superv.', autopilot: 'Autopiloto', tacc: 'TACC' }
  },
  fr: {
    gear: { 0: 'PARK', 1: 'MARCHE', 2: 'MARCHE AR', 3: 'NEUTRE' },
    ap: { 0: 'Manuel', 1: 'Autonome', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Pas de Données',
    labels: { speed: 'Vitesse', gear: 'Rapport', steering: 'Direction', accelerator: 'Accélérateur', brake: 'Frein', blinkers: 'Clignotants', autopilot: 'Pilote Auto', gps: 'GPS', heading: 'Cap', gForce: 'Force G', lateral: 'Latéral', longitudinal: 'Longitudinal' , dateTime: 'Date/Heure'},
    brakeStates: { on: 'ACT', off: 'DÉSACT' },
    apStates: { off: 'OFF', fsd: 'FSD Supervisé', autopilot: 'Autopilote', tacc: 'TACC' }
  },
  de: {
    gear: { 0: 'PARK', 1: 'FAHREN', 2: 'RÜCKWÄRTS', 3: 'NEUTRAL' },
    ap: { 0: 'Manuell', 1: 'Autonom', 2: 'Autosteer', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Keine Daten',
    labels: { speed: 'Geschw.', gear: 'Gang', steering: 'Lenkung', accelerator: 'Gaspedal', brake: 'Bremse', blinkers: 'Blinker', autopilot: 'Autopilot', gps: 'GPS', heading: 'Richtung', gForce: 'G-Kraft', lateral: 'Lateral', longitudinal: 'Längs' , dateTime: 'Datum/Zeit'},
    brakeStates: { on: 'EIN', off: 'AUS' },
    apStates: { off: 'AUS', fsd: 'FSD Auto.', autopilot: 'Autopilot', tacc: 'TACC' }
  },
  zh: {
    gear: { 0: '驻车', 1: '行驶', 2: '倒车', 3: '空档' },
    ap: { 0: '手动', 1: '自动驾驶', 2: '自动转向', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: '无数据',
    labels: { speed: '速度', gear: '挡位', steering: '转向', accelerator: '油门', brake: '刹车', blinkers: '转向灯', autopilot: '自动驾驶', gps: 'GPS', heading: '航向', gForce: 'G力', lateral: '侧向', longitudinal: '纵向' , dateTime: '日期/时间'},
    brakeStates: { on: '开', off: '关' },
    apStates: { off: '关', fsd: 'FSD监督', autopilot: '自动驾驶', tacc: 'TACC' }
  },
  ja: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: '手動', 1: '自動運転', 2: 'オートステア', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'データなし',
    labels: { speed: '速度', gear: 'ギア', steering: '操舵', accelerator: '加速', brake: 'ブレーキ', blinkers: 'ウインカ', autopilot: 'AP', gps: 'GPS', heading: '方位', gForce: 'G値', lateral: '横G', longitudinal: '縦G' , dateTime: '日時'},
    brakeStates: { on: 'ON', off: 'OFF' },
    apStates: { off: 'OFF', fsd: 'FSD監視', autopilot: 'AP', tacc: 'TACC' }
  },
  ko: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: '수동', 1: '자율주행', 2: '자동조향', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: '데이터 없음',
    labels: { speed: '속도', gear: '기어', steering: '조향', accelerator: '가속', brake: '브레이크', blinkers: '방향등', autopilot: 'AP', gps: 'GPS', heading: '방향', gForce: 'G력', lateral: '횡G', longitudinal: '종G' , dateTime: '날짜/시간'},
    brakeStates: { on: '켜짐', off: '꺼짐' },
    apStates: { off: 'OFF', fsd: 'FSD', autopilot: 'AP', tacc: 'TACC' }
  },
  pt: {
    gear: { 0: 'PARK', 1: 'CONDUZIR', 2: 'RÉ', 3: 'NEUTRO' },
    ap: { 0: 'Manual', 1: 'Autônomo', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Sem Dados',
    labels: { speed: 'Velocidade', gear: 'Marcha', steering: 'Direção', accelerator: 'Acelerador', brake: 'Freio', blinkers: 'Pisca', autopilot: 'Piloto Auto', gps: 'GPS', heading: 'Direção', gForce: 'Força G', lateral: 'Lateral', longitudinal: 'Longitudinal' , dateTime: 'Data/Hora'},
    brakeStates: { on: 'LIGADO', off: 'DESL.' },
    apStates: { off: 'OFF', fsd: 'FSD Superv.', autopilot: 'Autopiloto', tacc: 'TACC' }
  },
  ru: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: 'Ручной', 1: 'Автопилот', 2: 'Автоулр.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Нет данных',
    labels: { speed: 'Скорость', gear: 'Передача', steering: 'Руль', accelerator: 'Акселер.', brake: 'Тормоз', blinkers: 'Поворот.', autopilot: 'Автопилот', gps: 'GPS', heading: 'Направ.', gForce: 'Перегрузка', lateral: 'Боковая', longitudinal: 'Продольная' , dateTime: 'Дата/Время'},
    brakeStates: { on: 'ВКЛ', off: 'ВЫКЛ' },
    apStates: { off: 'ВЫКЛ', fsd: 'FSD Надзор', autopilot: 'Автопилот', tacc: 'TACC' }
  },
  it: {
    gear: { 0: 'PARK', 1: 'GUIDA', 2: 'RETROMARCIA', 3: 'FOLLE' },
    ap: { 0: 'Manuale', 1: 'Autonomo', 2: 'Autodir.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Nessun Dato',
    labels: { speed: 'Velocità', gear: 'Marcia', steering: 'Sterzo', accelerator: 'Acceleratore', brake: 'Freno', blinkers: 'Frecce', autopilot: 'Autopilota', gps: 'GPS', heading: 'Direzione', gForce: 'Forza G', lateral: 'Laterale', longitudinal: 'Longitudinale' , dateTime: 'Data/Ora'},
    brakeStates: { on: 'SÌ', off: 'NO' },
    apStates: { off: 'OFF', fsd: 'FSD Superv.', autopilot: 'Autopilota', tacc: 'TACC' }
  },
  nl: {
    gear: { 0: 'PARK', 1: 'RIJDEN', 2: 'ACHTERUIT', 3: 'NEUTRAAL' },
    ap: { 0: 'Handmatig', 1: 'Zelfrijdend', 2: 'Autostuur', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Geen Data',
    labels: { speed: 'Snelheid', gear: 'Versnelling', steering: 'Stuur', accelerator: 'Gas', brake: 'Rem', blinkers: 'Richting', autopilot: 'Autopiloot', gps: 'GPS', heading: 'Koers', gForce: 'G-Kracht', lateral: 'Lateraal', longitudinal: 'Longitudinaal' , dateTime: 'Datum/Tijd'},
    brakeStates: { on: 'AAN', off: 'UIT' },
    apStates: { off: 'UIT', fsd: 'FSD Beg.', autopilot: 'Autopiloot', tacc: 'TACC' }
  },
  pl: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: 'Ręczny', 1: 'Autonomiczny', 2: 'Autokier.', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Brak Danych',
    labels: { speed: 'Prędkość', gear: 'Bieg', steering: 'Kierow.', accelerator: 'Gaz', brake: 'Hamulec', blinkers: 'Kierunki', autopilot: 'Autopilot', gps: 'GPS', heading: 'Kierunek', gForce: 'Siła G', lateral: 'Boczna', longitudinal: 'Wzdłużna' , dateTime: 'Data/Czas'},
    brakeStates: { on: 'WŁ', off: 'WYŁ' },
    apStates: { off: 'WYŁ', fsd: 'FSD Nadz.', autopilot: 'Autopilot', tacc: 'TACC' }
  },
  tr: {
    gear: { 0: 'P', 1: 'D', 2: 'R', 3: 'N' },
    ap: { 0: 'Manuel', 1: 'Otonom', 2: 'Otomatik', 3: 'TACC' },
    speedUnit: { mph: 'MPH', kmh: 'KM/H' },
    noData: 'Veri Yok',
    labels: { speed: 'Hız', gear: 'Vites', steering: 'Direksiyon', accelerator: 'Gaz', brake: 'Fren', blinkers: 'Sinyal', autopilot: 'Otopilot', gps: 'GPS', heading: 'Yön', gForce: 'G-Kuv.', lateral: 'Yanal', longitudinal: 'Boylamasına' , dateTime: 'Tarih/Saat'},
    brakeStates: { on: 'AÇIK', off: 'KAPALI' },
    apStates: { off: 'KAPALI', fsd: 'FSD Denet.', autopilot: 'Otopilot', tacc: 'TACC' }
  }
};

/**
 * Get translated gear text
 * @param {number} gearState - Gear state (0=PARK, 1=DRIVE, 2=REVERSE, 3=NEUTRAL)
 * @param {string} language - Language code (e.g., 'en', 'es', 'fr')
 * @returns {string} Translated gear text
 */
function getGearText(gearState, language = 'en') {
  const translations = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  return translations.gear[gearState] || '--';
}

/**
 * Get translated autopilot state text
 * @param {number} apState - Autopilot state (0=Manual, 1=Self Driving, 2=Autosteer, 3=TACC)
 * @param {string} language - Language code (e.g., 'en', 'es', 'fr')
 * @returns {string} Translated autopilot text
 */
function getApText(apState, language = 'en') {
  const translations = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  return translations.ap[apState] || translations.ap[0]; // Default to "Manual"
}

/**
 * Get translated speed unit
 * @param {boolean} useMetric - Whether to use metric (KM/H) or imperial (MPH)
 * @param {string} language - Language code (e.g., 'en', 'es', 'fr')
 * @returns {string} Translated speed unit
 */
function getSpeedUnit(useMetric, language = 'en') {
  const translations = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  return useMetric ? translations.speedUnit.kmh : translations.speedUnit.mph;
}

/**
 * Generate ASS header with styles
 * @param {number} playResX - Coordinate space width (e.g., 1920)
 * @param {number} playResY - Coordinate space height (e.g., 1080)
 * @param {number} fontSize - Base font size for dashboard elements
 * @returns {string} ASS header section
 */
function generateAssHeader(playResX, playResY, fontSize) {
  const scaledFontSize = Math.round(fontSize);
  const smallFontSize = Math.round(fontSize * 0.7);
  const largeFontSize = Math.round(fontSize * 1.4);

  return `[Script Info]
Title: Tesla Compact Dashboard
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CompactDash,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Speed,Segoe UI,${largeFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SpeedUnit,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Gear,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,10,10,10,1
Style: GearActive,Segoe UI,${scaledFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,10,10,10,1
Style: Time,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: APLabel,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: APActive,Segoe UI,${smallFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: BlinkerOff,Segoe UI,${scaledFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: BlinkerOn,Segoe UI,${scaledFontSize},${COLORS.green},${COLORS.green},&H00115C2F,&H80000000,1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: BrakeOff,Segoe UI,${smallFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: BrakeOn,Segoe UI,${smallFontSize},${COLORS.red},${COLORS.red},&H00000080,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: AccelOff,Segoe UI,${smallFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: AccelOn,Segoe UI,${smallFontSize},${COLORS.blue},${COLORS.blue},&H00802400,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SteeringWheel,Segoe UI,${largeFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SteeringActive,Segoe UI,${largeFontSize},${COLORS.blue},${COLORS.blue},&H00802400,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Format timestamp for ASS (h:mm:ss.cc format)
 * @param {number} ms - Time in milliseconds
 * @returns {string} Formatted time string
 */
function formatAssTime(ms) {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centiseconds = Math.floor((totalSeconds % 1) * 100);

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

/**
 * Format timestamp for display based on user's time format preference
 * @param {number} timestampMs - Unix timestamp in milliseconds
 * @param {string} timeFormat - Time format: '12h' or '24h'
 * @returns {string} Formatted time string
 */
function formatDisplayTime(timestampMs, timeFormat = '12h') {
  if (!timestampMs) return '--:--';
  const date = new Date(timestampMs);
  let h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();

  if (timeFormat === '24h') {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  } else {
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
  }
}

/**
 * Format date for display based on user's date format preference
 * @param {number} timestampMs - Unix timestamp in milliseconds
 * @param {string} dateFormat - Date format: 'mdy', 'dmy', or 'ymd'
 * @returns {string} Formatted date string
 */
function formatDisplayDate(timestampMs, dateFormat = 'mdy') {
  if (!timestampMs) return '--/--/--';
  const date = new Date(timestampMs);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  switch (dateFormat) {
    case 'dmy':
      return `${d}/${m}/${y}`;
    case 'ymd':
      return `${y}-${m}-${d}`;
    case 'mdy':
    default:
      return `${m}/${d}/${y}`;
  }
}

/**
 * Get SEI value with camelCase/snake_case fallback
 * @param {Object} sei - SEI data object
 * @param {string} camel - camelCase property name
 * @param {string} snake - snake_case property name
 * @returns {*} Property value or undefined
 */
function getSeiValue(sei, camel, snake) {
  return sei?.[camel] ?? sei?.[snake];
}

/**
 * Calculate dashboard position based on user selection
 * @param {string} position - Position string (e.g., 'bottom-center')
 * @param {number} playResX - Coordinate space width
 * @param {number} playResY - Coordinate space height
 * @param {number} dashWidth - Dashboard width
 * @param {number} dashHeight - Dashboard height
 * @returns {{x: number, y: number}} Position coordinates
 */
function calculatePosition(position, playResX, playResY, dashWidth, dashHeight) {
  const margin = 40; // Margin from edges

  const positions = {
    'bottom-center': { x: playResX / 2, y: playResY - margin - dashHeight / 2 },
    'bottom-left': { x: margin + dashWidth / 2, y: playResY - margin - dashHeight / 2 },
    'bottom-right': { x: playResX - margin - dashWidth / 2, y: playResY - margin - dashHeight / 2 },
    'top-center': { x: playResX / 2, y: margin + dashHeight / 2 },
    'top-left': { x: margin + dashWidth / 2, y: margin + dashHeight / 2 },
    'top-right': { x: playResX - margin - dashWidth / 2, y: margin + dashHeight / 2 }
  };

  return positions[position] || positions['bottom-center'];
}

/**
 * Generate a single dialogue line for ASS
 * @param {number} layer - Layer number (higher = on top)
 * @param {string} startTime - Start time in ASS format
 * @param {string} endTime - End time in ASS format
 * @param {string} style - Style name
 * @param {string} text - Text content with override tags
 * @returns {string} ASS dialogue line
 */
function dialogueLine(layer, startTime, endTime, style, text) {
  return `Dialogue: ${layer},${startTime},${endTime},${style},,0,0,0,,${text}`;
}

/**
 * Generate ASS drawing for left arrow (blinker)
 * From Illustrator export, mirrored and centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawLeftArrow(scale = 1) {
  return scaleAssPath(SVG_PATHS.arrow_left, scale);
}

/**
 * Generate ASS drawing for right arrow (blinker)
 * From Illustrator export, centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawRightArrow(scale = 1) {
  return scaleAssPath(SVG_PATHS.arrow_right, scale);
}

// Pre-converted SVG path data (from assets/*.svg, normalized and centered at 0,0)
// Exported from Illustrator ASS export, then centered by subtracting center point
const SVG_PATHS = {
  // From testwheel.svg - outer blue circle, centered at (0,0)
  // Original center was at (539.26, 540.24), radius ~446.5
  testwheel_outer: 'm 446.53 0 b 446.53 246.61 246.61 446.53 0 446.53 b -246.61 446.53 -446.53 246.61 -446.53 0 b -446.53 -246.61 -246.61 -446.53 0 -446.53 b 246.61 -446.53 446.53 -246.61 446.53 0',
  // Inner white ring with grip cutouts, centered at (0,0)
  testwheel_inner: 'm 0 -300.34 b -165.6 -300.34 -300.3 -165.59 -300.3 0 b -300.3 165.6 -165.6 300.3 0 300.3 b 165.59 300.3 300.34 165.6 300.34 0 b 300.34 -165.59 165.59 -300.34 0 -300.34 m 0 -246.73 b 115.88 -246.73 213.3 -166.47 239.67 -58.62 b 240.2 -56.58 240.88 -54.24 241.23 -51.9 l 241.23 -51.85 b 242.39 -42.98 237.96 -34.35 198.15 -43.42 b 147.9 -54.87 74.12 -93.95 5.21 -93.95 b -63.7 -93.95 -145.62 -59.08 -180.27 -47.22 b -214.77 -34.45 -241.33 -38.59 -241.62 -49.9 b -218.48 -162.13 -118.91 -246.73 0 -246.73 m -58.73 239.63 b -149.37 217.4 -220.52 144.99 -240.8 53.61 b -235.39 42.89 -221.35 25.25 -189.04 32.02 b -143.77 41.52 -80.66 96.54 -55.76 144.6 b -31.49 191.48 -39.62 242.5 -57.41 239.92 b -57.85 239.87 -58.29 239.77 -58.73 239.63 m 71.39 236.17 l 71.34 236.17 b 47.02 238.46 42.3 232.61 41.71 209.12 b 41.18 185.68 45.9 124.22 118.27 69.45 b 190.59 14.72 234.06 24.95 240.06 57.07 l 240.06 57.12 b 219.73 142.55 154.82 210.92 71.39 236.17',
  // From Illustrator export - accelerator pedal, centered at (0,0)
  // Original center was at (540, 540), size 1080x1080
  // Main pedal body (white shape)
  pedal_acc: 'm 184.15 -263.81 l 184.15 151.71 b 184.15 176.67 161.74 344.75 154.63 382.21 b 147.53 419.67 114.32 444.66 72.87 444.66 l 12.58 444.66 b -2.5 444.66 -12.58 444.66 -12.58 444.66 l -72.87 444.66 b -114.32 444.66 -147.53 419.67 -154.63 382.21 b -161.74 344.75 -184.15 176.67 -184.15 151.71 l -184.15 -263.81 b -184.15 -288.02 -164.54 -307.63 -140.35 -307.63 l 140.35 -307.63 b 164.54 -307.63 184.15 -288.02 184.15 -263.81',
  // Accelerator pedal top tab
  pedal_acc_tab: 'm -55.64 -443.52 l -121.12 -443.52 l -121.12 -297.03 l -55.64 -297.03 l -55.64 -443.52',
  // From Illustrator export - brake pedal, centered at (0,0)
  // Original center was at (540, 540), size 1080x1080
  // Main pedal body (white shape)
  pedal_brake: 'm 386.05 -10.57 l 386.05 275.73 b 386.05 289.36 384.15 302.92 380.41 316.03 l 361.92 380.73 b 354.9 405.28 332.47 422.2 306.93 422.2 l -307.86 422.2 b -333.25 422.2 -355.6 405.46 -362.74 381.1 l -380.95 318.98 b -384.87 305.58 -386.87 291.69 -386.87 277.73 l -386.87 -10.57 b -386.87 -61.26 -345.77 -102.36 -295.08 -102.36 l 294.27 -102.36 b 344.96 -102.36 386.05 -61.26 386.05 -10.57',
  // Brake pedal top tab
  pedal_brake_tab: 'm 270.2 -90.88 l 385.2 -293.5 l 385.2 -422.44 l 188.28 -83.07 l 270.2 -90.88',
  // From Illustrator export - right arrow blinker, centered at (0,0), SOLID (outer contour only)
  // Original center was at (960, 541), size ~195x168
  arrow_right: 'm 13.11 -33.71 b 15.61 -33.7 16.06 -36.09 15.15 -38.05 9.81 -49.52 5.3 -59.32 1.63 -67.45 -1.42 -74.21 0.76 -78.22 5.55 -83.46 5.8 -83.72 6.07 -83.94 6.38 -84.12 14.17 -88.49 20.03 -84.98 25.77 -79.01 36.67 -67.69 45.88 -58.89 57.03 -47.37 62.85 -41.36 73.29 -30.89 88.34 -15.96 91.84 -12.49 95.74 -8.94 97.13 -4.62 99.07 1.36 96.56 6.15 92.31 10.41 59.34 43.5 38.6 64.39 30.11 73.08 27.75 75.49 26.47 76.81 26.28 77.03 23.64 80 20.08 83.56 16.05 83.93 13.88 84.12 11.77 84.13 9.72 83.94 9.38 83.91 9.05 83.83 8.73 83.7 1.64 80.77 -1.19 75.32 0.25 67.36 0.32 66.99 0.43 66.63 0.58 66.29 5.37 55.61 9.91 45.68 14.2 36.51 15.9 32.89 13.31 31.3 10.28 31.29 -5.65 31.24 -34.48 31.23 -76.21 31.24 -83.28 31.24 -87.73 30.78 -89.56 29.85 -93.33 27.94 -96.02 24.45 -97.65 19.38 -97.74 19.08 -97.79 18.76 -97.79 18.44 l -97.73 -20.92 b -97.73 -21.05 -97.71 -21.18 -97.68 -21.31 -96.46 -26.68 -93.59 -30.44 -89.07 -32.6 -87.14 -33.53 -83.84 -33.99 -79.19 -33.98 -43.76 -33.92 -13 -33.83 13.11 -33.71',
  // Left arrow - mirrored version of right arrow (negate X coordinates), SOLID
  arrow_left: 'm -13.11 -33.71 b -15.61 -33.7 -16.06 -36.09 -15.15 -38.05 -9.81 -49.52 -5.3 -59.32 -1.63 -67.45 1.42 -74.21 -0.76 -78.22 -5.55 -83.46 -5.8 -83.72 -6.07 -83.94 -6.38 -84.12 -14.17 -88.49 -20.03 -84.98 -25.77 -79.01 -36.67 -67.69 -45.88 -58.89 -57.03 -47.37 -62.85 -41.36 -73.29 -30.89 -88.34 -15.96 -91.84 -12.49 -95.74 -8.94 -97.13 -4.62 -99.07 1.36 -96.56 6.15 -92.31 10.41 -59.34 43.5 -38.6 64.39 -30.11 73.08 -27.75 75.49 -26.47 76.81 -26.28 77.03 -23.64 80 -20.08 83.56 -16.05 83.93 -13.88 84.12 -11.77 84.13 -9.72 83.94 -9.38 83.91 -9.05 83.83 -8.73 83.7 -1.64 80.77 1.19 75.32 -0.25 67.36 -0.32 66.99 -0.43 66.63 -0.58 66.29 -5.37 55.61 -9.91 45.68 -14.2 36.51 -15.9 32.89 -13.31 31.3 -10.28 31.29 5.65 31.24 34.48 31.23 76.21 31.24 83.28 31.24 87.73 30.78 89.56 29.85 93.33 27.94 96.02 24.45 97.65 19.38 97.74 19.08 97.79 18.76 97.79 18.44 l 97.73 -20.92 b 97.73 -21.05 97.71 -21.18 97.68 -21.31 96.46 -26.68 93.59 -30.44 89.07 -32.6 87.14 -33.53 83.84 -33.99 79.19 -33.98 43.76 -33.92 13 -33.83 -13.11 -33.71'
};

/**
 * Scale an ASS path string by a factor
 * @param {string} path - ASS path with coordinates
 * @param {number} scale - Scale factor
 * @returns {string} Scaled path
 */
function scaleAssPath(path, scale) {
  if (scale === 1) return path;
  return path.replace(/-?\d+\.?\d*/g, (match) => {
    const num = parseFloat(match);
    return Math.round(num * scale * 100) / 100;
  });
}

/**
 * Generate ASS drawing for steering wheel (from testwheel.svg)
 * Centered at (0,0) for proper rotation around the wheel center
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawSteeringWheelOuter(scale = 1) {
  return scaleAssPath(SVG_PATHS.testwheel_outer, scale);
}

function drawSteeringWheelInner(scale = 1) {
  return scaleAssPath(SVG_PATHS.testwheel_inner, scale);
}

/**
 * Generate ASS drawing for accelerator pedal (main body)
 * From Illustrator export, centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawAcceleratorPedal(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_acc, scale);
}

/**
 * Generate ASS drawing for accelerator pedal tab
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawAcceleratorPedalTab(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_acc_tab, scale);
}

/**
 * Generate ASS drawing for brake pedal (main body)
 * From Illustrator export, centered at (0,0)
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawBrakePedal(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_brake, scale);
}

/**
 * Generate ASS drawing for brake pedal tab
 * @param {number} scale - Scale factor for the icon
 * @returns {string} ASS vector drawing commands (without p1/p0 tags)
 */
function drawBrakePedalTab(scale = 1) {
  return scaleAssPath(SVG_PATHS.pedal_brake_tab, scale);
}

/**
 * Generate ASS drawing for steering wheel (legacy simple version)
 * @returns {string} ASS vector drawing commands
 */
function drawSteeringWheel() {
  // Simplified steering wheel icon
  // Outer circle with spokes
  return '{\\p1}m 20 0 b 31 0 40 9 40 20 b 40 31 31 40 20 40 b 9 40 0 31 0 20 b 0 9 9 0 20 0 m 20 5 b 12 5 5 12 5 20 b 5 28 12 35 20 35 b 28 35 35 28 35 20 b 35 12 28 5 20 5 m 18 20 l 5 20 m 22 20 l 35 20 m 20 18 l 20 5{\\p0}';
}

/**
 * Generate compact dashboard events for a time range
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options
 * @returns {string} ASS events section
 */
function generateCompactDashboardEvents(seiData, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    position = 'bottom-center',
    size = 'medium',
    useMetric = false,
    segments = [],
    cumStarts = [],
    dateFormat = 'mdy',
    timeFormat = '12h',
    language = 'en',
    accelPedMode = 'iconbar',
    customPosition = null,
    // Defaults to 1 so the simple modal (which doesn't send these) is
    // unaffected. The AE sends user-chosen multipliers from the sidebar.
    labelScale = 1,
    valueScale = 1
  } = options;

  // Dashboard dimensions - fixed size based on 1920px reference width.
  // When `customPosition` is supplied (Advanced Editor), use the user's
  // canvas-defined rectangle instead of the size/position presets.
  const sizeMultipliers = {
    'small': 0.25, 'medium': 0.35, 'large': 0.45, 'xlarge': 0.55
  };
  const sizeMultiplier = sizeMultipliers[size] || 0.35;

  let dashWidth, dashHeight, pos;
  if (customPosition) {
    dashWidth = Math.max(80, Math.round(customPosition.w));
    dashHeight = Math.max(20, Math.round(customPosition.h));
    pos = {
      x: Math.round(customPosition.x + dashWidth / 2),
      y: Math.round(customPosition.y + dashHeight / 2)
    };
  } else {
    const refDashWidth = Math.round(1920 * sizeMultiplier * 1.15);
    dashWidth = Math.min(refDashWidth, playResX - 80);
    dashHeight = Math.round(dashWidth / 8.57);
    pos = calculatePosition(position, playResX, playResY, dashWidth, dashHeight);
  }
  // Base sizes — unchanged formula so simple-modal exports stay identical.
  // valueScale multiplies the user-controlled "Value Size" up/down; capped
  // by dashHeight so text/icons can never exceed the bar's vertical bounds.
  const baseFontSize = Math.round(dashHeight * 0.45);
  const fontSize = Math.min(
    Math.max(8, Math.round(baseFontSize * valueScale)),
    Math.round(dashHeight * 0.85)
  );
  const iconSize = Math.min(
    Math.max(8, Math.round(dashHeight * 0.5 * valueScale)),
    Math.round(dashHeight * 0.90)
  );
  const events = [];

  // Calculate element positions - evenly distributed across dashboard width
  // Layout: [Brake] [Date/Time] [<] [Speed+Unit] [Gear/AP] [>] [Steering] [Accel]
  // 8 elements, evenly spaced with extra gap between Speed and Gear/AP
  const numElements = 8;
  const padding = dashWidth * 0.05; // 5% padding on each side
  const usableWidth = dashWidth - (padding * 2);
  const spacing = usableWidth / (numElements - 1);

  // Per-element horizontal width cap so a wide font (high valueScale) can't
  // spill into the neighboring slot. AE-only — simple modal's preset sizing
  // was already tuned for its full-width layout and would be incorrectly
  // shrunk if we capped it here.
  const widthCap = (charCount, available) =>
    Math.max(8, Math.floor(Math.max(10, available) / Math.max(1, charCount * 0.55)));
  const capIfCustom = (size, cap) => customPosition ? Math.min(size, cap) : size;
  const dateTimeFontCap = widthCap(20, spacing * 1.7);
  const speedFontCap    = widthCap(7,  spacing * 1.2);
  const gearApFontCap   = widthCap(10, spacing * 1.2);

  // Hoisted text sizes (used by all state-change events) + per-element
  // width caps so high valueScale never spills text across slot boundaries.
  const speedNumSize = Math.round(fontSize * 0.8);
  const speedUnitSize = Math.round(fontSize * 0.5);
  const dateNumSz    = capIfCustom(speedNumSize,  dateTimeFontCap);
  const dateUnitSz   = capIfCustom(speedUnitSize, dateTimeFontCap);
  const speedNumSz   = capIfCustom(speedNumSize,  speedFontCap);
  const speedUnitSz  = capIfCustom(speedUnitSize, speedFontCap);
  const gearApNumSz  = capIfCustom(speedNumSize,  gearApFontCap);
  const gearApUnitSz = capIfCustom(speedUnitSize, gearApFontCap);
  const startX = pos.x - dashWidth / 2 + padding;

  // Spread blinkers outward to give speed/gearAp more room in center
  const arrowSpread = spacing * 0.35; // Push arrows away from center
  const centerBetweenArrows = startX + spacing * 3.5;
  const positions = {
    brake: startX + spacing * 0,
    dateTime: startX + spacing * 1,              // Date/Time (was Gear)
    leftBlinker: startX + spacing * 2 - arrowSpread * 0.25,
    speed: centerBetweenArrows - spacing * 0.65,
    gearAp: centerBetweenArrows + spacing * 0.65,
    rightBlinker: startX + spacing * 5 + arrowSpread,
    steering: startX + spacing * 6,
    accel: startX + spacing * 7
  };

  const durationMs = endTimeMs - startTimeMs;
  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const frameTimeMs = 1000 / FPS;

  // Blinker animation: Tesla uses 400ms on / 300ms off = 700ms cycle
  // At 36fps: 700ms / (1000/36) ≈ 25 frames per cycle
  const framesPerBlinkerCycle = 25;
  const blinkerOnFrames = 14; // 14/36 ≈ 389ms ≈ 400ms on
  let prevLeftBlinkerOn = false;
  let prevRightBlinkerOn = false;
  let leftBlinkerStartFrame = 0;
  let rightBlinkerStartFrame = 0;

  // Steering smoothing: frame-rate-independent exponential tracking (matches live playback)
  let smoothedSteeringAngle = 0;
  const steerFactor = 1 - Math.exp(-45 * (frameTimeMs / 1000)); // STEERING_TRACKING_SPEED=45

  // Convert video time to actual timestamp for display
  function convertVideoTimeToTimestamp(videoTimeMs) {
    if (!segments || segments.length === 0) return videoTimeMs;

    for (let i = 0; i < segments.length; i++) {
      const segStart = (cumStarts[i] || 0) * 1000;
      const segDuration = (segments[i]?.durationSec || 60) * 1000;
      const segEnd = segStart + segDuration;

      if (videoTimeMs >= segStart && videoTimeMs < segEnd) {
        const segmentTimestamp = segments[i]?.timestamp;
        if (segmentTimestamp) {
          const offsetInSegment = videoTimeMs - segStart;
          return segmentTimestamp + offsetInSegment;
        }
      }
    }

    return videoTimeMs;
  }

  // Track previous state to only emit events when data changes
  let prevState = null;
  let eventStartFrame = 0;

  for (let frame = 0; frame <= totalFrames; frame++) {
    const currentTimeMs = startTimeMs + (frame * frameTimeMs);
    const sei = findSeiAtTime(seiData, currentTimeMs);
    const actualTimestampMs = convertVideoTimeToTimestamp(currentTimeMs);

    // Extract telemetry values
    const mps = Math.abs(getSeiValue(sei, 'vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedUnit = getSpeedUnit(useMetric, language);

    const gear = getSeiValue(sei, 'gearState', 'gear_state');
    const gearText = getGearText(gear, language);

    const leftBlinkerOn = !!getSeiValue(sei, 'blinkerOnLeft', 'blinker_on_left');
    const rightBlinkerOn = !!getSeiValue(sei, 'blinkerOnRight', 'blinker_on_right');

    const apState = getSeiValue(sei, 'autopilotState', 'autopilot_state');
    const apActive = apState === 1 || apState === 2;
    const apText = getApText(apState, language);

    const brakeApplied = !!getSeiValue(sei, 'brakeApplied', 'brake_applied');
    const brakeActive = brakeApplied;

    const accelPos = getSeiValue(sei, 'acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    // Normalize to 0-100 range (SEI data can be 0-1 or 0-100 depending on version)
    const accelPct = accelPos > 1 ? Math.min(100, accelPos) : Math.min(100, accelPos * 100);
    const accelActive = accelPct > 5;

    const rawSteeringAngle = getSeiValue(sei, 'steeringWheelAngle', 'steering_wheel_angle') || 0;
    smoothedSteeringAngle += (rawSteeringAngle - smoothedSteeringAngle) * steerFactor;
    const steeringAngle = smoothedSteeringAngle;

    // Blinker animation state (frame-based, phase resets on activation)
    if (leftBlinkerOn && !prevLeftBlinkerOn) leftBlinkerStartFrame = frame;
    if (rightBlinkerOn && !prevRightBlinkerOn) rightBlinkerStartFrame = frame;
    const leftFrameInCycle = (frame - leftBlinkerStartFrame) % framesPerBlinkerCycle;
    const rightFrameInCycle = (frame - rightBlinkerStartFrame) % framesPerBlinkerCycle;
    const leftBlinkVisible = leftBlinkerOn && leftFrameInCycle < blinkerOnFrames;
    const rightBlinkVisible = rightBlinkerOn && rightFrameInCycle < blinkerOnFrames;
    prevLeftBlinkerOn = leftBlinkerOn;
    prevRightBlinkerOn = rightBlinkerOn;

    const displayTime = formatDisplayTime(actualTimestampMs, timeFormat);
    const displayDate = formatDisplayDate(actualTimestampMs, dateFormat);

    // Create state signature for change detection
    const currentState = JSON.stringify({
      speed, gearText, leftBlinkVisible, rightBlinkVisible,
      apActive, apText, brakeActive, accelPct: Math.round(accelPct),
      steeringAngle: Math.round(steeringAngle), displayTime, displayDate
    });

    // Emit events when state changes or at the end
    if (currentState !== prevState || frame === totalFrames) {
      if (prevState !== null && eventStartFrame < frame) {
        const startAssTime = formatAssTime((eventStartFrame * frameTimeMs));
        const endAssTime = formatAssTime((frame * frameTimeMs));

        // Parse previous state for event generation
        const prev = JSON.parse(prevState);

        // Corner radius for rounded rectangle
        const cornerRadius = Math.round(dashHeight * 0.35);

        // Background panel - semi-transparent dark rounded rectangle
        // Using absolute coordinates for the rectangle (not relative to pos)
        const bgLeft = pos.x - dashWidth / 2;
        const bgRight = pos.x + dashWidth / 2;
        const bgTop = pos.y - dashHeight / 2;
        const bgBottom = pos.y + dashHeight / 2;
        const r = cornerRadius;

        // Draw rounded rectangle using ASS vector drawing with absolute positioning
        // The \an7 (top-left alignment) + \pos(0,0) makes coordinates absolute
        events.push(dialogueLine(0, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(0,0)\\bord1\\shad0\\1c&H302828&\\3c&H404040&\\1a&H40&\\p1}` +
          `m ${bgLeft + r} ${bgTop} ` +
          `l ${bgRight - r} ${bgTop} ` +
          `b ${bgRight} ${bgTop} ${bgRight} ${bgTop + r} ${bgRight} ${bgTop + r} ` +
          `l ${bgRight} ${bgBottom - r} ` +
          `b ${bgRight} ${bgBottom} ${bgRight - r} ${bgBottom} ${bgRight - r} ${bgBottom} ` +
          `l ${bgLeft + r} ${bgBottom} ` +
          `b ${bgLeft} ${bgBottom} ${bgLeft} ${bgBottom - r} ${bgLeft} ${bgBottom - r} ` +
          `l ${bgLeft} ${bgTop + r} ` +
          `b ${bgLeft} ${bgTop} ${bgLeft + r} ${bgTop} ${bgLeft + r} ${bgTop}{\\p0}`
        ));

        // Brake pedal icon - from Illustrator export, centered at (0,0)
        const brakeColor = prev.brakeActive ? '&H0000FF&' : '&H606060&'; // Red when active, gray when off
        // Base path is ~773 units wide (from -386.87 to 386.05), scale to fit iconSize
        const pedalScale = iconSize / 450 * 0.45; // Scale to ~45% of iconSize
        const brakeX = Math.round(positions.brake);
        const brakeY = Math.round(pos.y);
        // Main pedal body
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${brakeY})\\bord0\\shad0\\1c${brakeColor}\\p1}` +
          drawBrakePedal(pedalScale) + `{\\p0}`
        ));
        // Pedal tab (same color)
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${brakeY})\\bord0\\shad0\\1c${brakeColor}\\p1}` +
          drawBrakePedalTab(pedalScale) + `{\\p0}`
        ));

        // Per-frame: only the small text size is still needed locally.
        const smallTextSize = Math.round(fontSize * 0.7);

        // Date and Time display (stacked vertically) - at position 1 (where Gear was)
        // Date on top, Time below - both same size as the old time display
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.dateTime},${pos.y - fontSize * 0.35})\\bord0\\shad0\\fs${dateNumSz}\\1c&HA0A0A0&}${prev.displayDate}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.dateTime},${pos.y + fontSize * 0.35})\\bord0\\shad0\\fs${dateUnitSz}\\1c&HA0A0A0&}${prev.displayTime}`
        ));

        // Left blinker arrow - from Illustrator export, centered at (0,0)
        const leftColor = prev.leftBlinkVisible ? '&H22C55E&' : '&H505050&'; // Green when on
        // Base arrow path is ~195 units wide, scale to fit iconSize
        const arrowScale = iconSize / 100 * 0.35; // Scale to ~35% of iconSize
        const leftX = Math.round(positions.leftBlinker);
        const leftY = Math.round(pos.y);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${leftX},${leftY})\\bord0\\shad0\\1c${leftColor}\\p1}` +
          drawLeftArrow(arrowScale) + `{\\p0}`
        ));

        // Speed display - number with unit below it (e.g. "32" over "MPH")
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.speed},${pos.y - fontSize * 0.35})\\bord0\\shad0\\fs${speedNumSz}\\b1\\1c&HFFFFFF&}${prev.speed}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.speed},${pos.y + fontSize * 0.35})\\bord0\\shad0\\fs${speedUnitSz}\\1c&H909090&}${speedUnit}`
        ));

        // Autopilot label and Gear (stacked vertically) - AP on top, Gear below
        const apColor = prev.apActive ? '&HFF4800&' : '&H808080&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.gearAp},${pos.y - fontSize * 0.35})\\bord0\\shad0\\fs${gearApNumSz}\\1c${apColor}}${prev.apText}`
        ));
        const gearColor = '&HFFFFFF&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${positions.gearAp},${pos.y + fontSize * 0.35})\\bord0\\shad0\\b1\\fs${gearApUnitSz}\\1c${gearColor}}${prev.gearText}`
        ));

        // Right blinker arrow - from Illustrator export, centered at (0,0)
        const rightColor = prev.rightBlinkVisible ? '&H22C55E&' : '&H505050&';
        const rightX = Math.round(positions.rightBlinker);
        const rightY = Math.round(pos.y);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${rightX},${rightY})\\bord0\\shad0\\1c${rightColor}\\p1}` +
          drawRightArrow(arrowScale) + `{\\p0}`
        ));

        // Steering wheel - from testwheel.svg (Illustrator export), centered at (0,0) for proper rotation
        const steerColor = prev.apActive ? '&HFF4800&' : '&H707070&'; // Blue when AP active
        // ASS \frz rotates counter-clockwise for positive angles, but CSS rotate() is clockwise
        // Negate the angle so exported steering wheel matches the live preview direction
        const angle = -(prev.steeringAngle || 0);
        // Base path radius is ~446.5 units, scale to fit iconSize
        const steerScale = iconSize / 446.5 * 0.5; // Scale to ~50% of iconSize
        const steerX = Math.round(positions.steering);
        const steerY = Math.round(pos.y);

        // For ASS vector drawings, \an7 with \pos places the drawing origin (0,0) at pos
        // Since our paths are centered at (0,0), this should center the wheel at steerX, steerY
        // \org sets the rotation origin to the same point

        // Outer filled circle (blue/gray background)
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${steerX},${steerY})\\org(${steerX},${steerY})\\bord0\\shad0\\1c${steerColor}\\frz${angle}\\p1}` +
          drawSteeringWheelOuter(steerScale) + `{\\p0}`
        ));

        // Inner white ring with grip cutouts
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${steerX},${steerY})\\org(${steerX},${steerY})\\bord0\\shad0\\1c&HFFFFFF&\\frz${angle}\\p1}` +
          drawSteeringWheelInner(steerScale) + `{\\p0}`
        ));

        // Accelerator pedal icon - from Illustrator export, centered at (0,0)
        const accelX = Math.round(positions.accel);
        const accelY = Math.round(pos.y);
        const accelPctVal = prev.accelPct || 0;
        const accelActive = accelPctVal > 5;

        if (accelPedMode === 'solid') {
          // Mode: solid - Simple on/off color change, no fill overlay
          const solidColor = accelActive ? '&HFF4800&' : '&H606060&';
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c${solidColor}\\p1}` +
            drawAcceleratorPedal(pedalScale) + `{\\p0}`
          ));
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c${solidColor}\\p1}` +
            drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
          ));
        } else if (accelPedMode === 'sidebar') {
          // Mode: sidebar - Icon with vertical bar on the right
          const sidebarIconColor = accelActive ? '&HFF4800&' : '&H606060&';
          // Draw pedal icon (shifted left to make room for bar)
          const sidebarIconX = accelX - Math.round(iconSize * 0.12);
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${sidebarIconX},${accelY})\\bord0\\shad0\\1c${sidebarIconColor}\\p1}` +
            drawAcceleratorPedal(pedalScale) + `{\\p0}`
          ));
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${sidebarIconX},${accelY})\\bord0\\shad0\\1c${sidebarIconColor}\\p1}` +
            drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
          ));
          // Draw vertical sidebar bar to the right of icon
          const barWidth = Math.max(2, Math.round(iconSize * 0.08));
          const barHeight = Math.round(iconSize * 0.9);
          const barX = sidebarIconX + Math.round(iconSize * 0.38);
          const barTop = accelY - Math.round(barHeight / 2);
          const barBottom = accelY + Math.round(barHeight / 2);
          // Gray background bar
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H404040&\\p1}` +
            `m ${barX} ${barTop} l ${barX + barWidth} ${barTop} l ${barX + barWidth} ${barBottom} l ${barX} ${barBottom}{\\p0}`
          ));
          // Blue fill from bottom based on percentage
          if (accelPctVal > 0) {
            const fillTop = Math.round(barBottom - (barHeight * accelPctVal / 100));
            events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFF4800&\\p1}` +
              `m ${barX} ${fillTop} l ${barX + barWidth} ${fillTop} l ${barX + barWidth} ${barBottom} l ${barX} ${barBottom}{\\p0}`
            ));
          }
        } else {
          // Mode: iconbar (default) - Icon fills from bottom based on percentage
          const pedalHalfHeight = Math.round(445 * pedalScale);
          const pedalTop = accelY - pedalHalfHeight;
          const pedalBottom = accelY + pedalHalfHeight;
          const clipY = Math.round(pedalBottom - (pedalBottom - pedalTop) * (accelPctVal / 100));

          // Main pedal body - gray base
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c&H606060&\\p1}` +
            drawAcceleratorPedal(pedalScale) + `{\\p0}`
          ));
          // Pedal tab - gray base
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c&H606060&\\p1}` +
            drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
          ));

          // Colored fill overlay - clipped from bottom based on percentage
          if (accelPctVal > 0) {
            const pedalHalfWidth = Math.round(200 * pedalScale);
            const clipLeft = accelX - pedalHalfWidth;
            const clipRight = accelX + pedalHalfWidth;
            events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c&HFF4800&\\clip(${clipLeft},${clipY},${clipRight},${pedalBottom})\\p1}` +
              drawAcceleratorPedal(pedalScale) + `{\\p0}`
            ));
            events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(${accelX},${accelY})\\bord0\\shad0\\1c&HFF4800&\\clip(${clipLeft},${clipY},${clipRight},${pedalBottom})\\p1}` +
              drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
            ));
          }
        }
      }

      prevState = currentState;
      eventStartFrame = frame;
    }
  }

  return events.join('\n');
}

/**
 * Generate complete ASS subtitle file for compact dashboard
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options
 * @returns {string} Complete ASS file content
 */
function generateCompactDashboardAss(seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080 } = options;

  // Calculate font size based on resolution
  const dashWidth = Math.round(playResX * 0.25);
  const dashHeight = Math.round(dashWidth * (76 / 500));
  const fontSize = Math.round(dashHeight * 0.4);

  const header = generateAssHeader(playResX, playResY, fontSize);
  const events = generateCompactDashboardEvents(seiData, startTimeMs, endTimeMs, options);

  return header + events;
}

/**
 * Write ASS subtitle file to temp directory
 * @param {string} exportId - Export ID for unique filename
 * @param {Array} seiData - SEI telemetry data
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @param {Object} options - Export options
 * @returns {Promise<string>} Path to generated ASS file
 */
async function writeCompactDashboardAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateCompactDashboardAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_${exportId}_${Date.now()}.ass`);

  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated compact dashboard subtitle: ${tempPath}`);

  return tempPath;
}

// ============================================
// ASS MINIMAP GENERATION
// Vector-based minimap using ASS drawings for GPU-accelerated rendering
// ============================================

/**
 * Calculate bounding box from GPS coordinates with padding
 * @param {Array} gpsPath - Array of [lat, lon] coordinates
 * @param {number} padding - Padding factor (0.1 = 10% padding)
 * @returns {{minLat, maxLat, minLon, maxLon, centerLat, centerLon}}
 */
function calculateGpsBounds(gpsPath, padding = 0.15) {
  if (!gpsPath || gpsPath.length === 0) {
    return { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1, centerLat: 0.5, centerLon: 0.5 };
  }

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  for (const [lat, lon] of gpsPath) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  // Add padding
  const latRange = maxLat - minLat || 0.001;
  const lonRange = maxLon - minLon || 0.001;
  const latPad = latRange * padding;
  const lonPad = lonRange * padding;

  minLat -= latPad;
  maxLat += latPad;
  minLon -= lonPad;
  maxLon += lonPad;

  return {
    minLat,
    maxLat,
    minLon,
    maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2
  };
}

/**
 * Convert latitude to Mercator Y coordinate
 * Required to match the Web Mercator projection used by OSM map tiles
 * @param {number} lat - Latitude in degrees
 * @returns {number} Mercator Y value
 */
function latToMercatorY(lat) {
  const latRad = lat * Math.PI / 180;
  return Math.log(Math.tan(latRad) + 1 / Math.cos(latRad));
}

/**
 * Convert GPS coordinate to pixel position within minimap
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {Object} bounds - GPS bounds from calculateGpsBounds
 * @param {number} mapSize - Minimap size in pixels (square)
 * @param {number} mapX - Minimap X offset in video
 * @param {number} mapY - Minimap Y offset in video
 * @param {number} marginFraction - Margin fraction (0 for map tile mode, 0.1 for dark bg mode)
 * @returns {{x: number, y: number}}
 */
function gpsToPixel(lat, lon, bounds, mapSize, mapX, mapY, marginFraction = 0.1) {
  const { minLat, maxLat, minLon, maxLon } = bounds;

  // Normalize to 0-1 range
  // Longitude is linear in Mercator projection
  const normalX = (lon - minLon) / (maxLon - minLon || 1);
  // Latitude must use Mercator projection to match OSM map tiles
  const mercY = latToMercatorY(lat);
  const mercMinY = latToMercatorY(minLat);
  const mercMaxY = latToMercatorY(maxLat);
  const normalY = 1 - (mercY - mercMinY) / (mercMaxY - mercMinY || 1); // Flip Y (lat increases north)

  // Apply margin inside the minimap
  // When using map tile background (marginFraction=0), no margin needed since
  // tile bounds already provide natural padding around the GPS track
  const margin = mapSize * marginFraction;
  const usableSize = mapSize - margin * 2;

  return {
    x: Math.round(mapX + margin + normalX * usableSize),
    y: Math.round(mapY + margin + normalY * usableSize)
  };
}

/**
 * Generate ASS header for minimap overlay
 * @param {number} playResX - Video width
 * @param {number} playResY - Video height
 * @returns {string} ASS header
 */
function generateMinimapAssHeader(playResX, playResY) {
  return `[Script Info]
Title: GPS Minimap Overlay
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: MinimapBg,Arial,20,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: MinimapPath,Arial,20,&H00FF7200,&H00FF7200,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: MinimapMarker,Arial,20,&H000048FF,&H000048FF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Calculate minimap position and size based on options
 * @param {number} playResX - Video width
 * @param {number} playResY - Video height
 * @param {string} position - Position: 'top-right', 'top-left', 'bottom-right', 'bottom-left'
 * @param {string} sizeOption - Size: 'small', 'medium', 'large', 'xlarge'
 * @returns {{mapX, mapY, mapSize, margin}}
 */
function calculateMinimapLayout(playResX, playResY, position, sizeOption) {
  const sizeMultipliers = {
    'small': 0.25,
    'medium': 0.35,
    'large': 0.45,
    'xlarge': 0.55
  };
  const multiplier = sizeMultipliers[sizeOption] || 0.25;

  // Square minimap based on smaller dimension
  const baseSize = Math.min(playResX, playResY);
  const mapSize = Math.round(baseSize * multiplier);
  const margin = Math.round(Math.min(playResX, playResY) * 0.02); // 2% margin from edge

  let mapX, mapY;

  switch (position) {
    case 'top-left':
      mapX = margin;
      mapY = margin;
      break;
    case 'top-right':
      mapX = playResX - mapSize - margin;
      mapY = margin;
      break;
    case 'bottom-left':
      mapX = margin;
      mapY = playResY - mapSize - margin;
      break;
    case 'bottom-right':
      mapX = playResX - mapSize - margin;
      mapY = playResY - mapSize - margin;
      break;
    default:
      mapX = playResX - mapSize - margin;
      mapY = margin;
  }

  return { mapX, mapY, mapSize, margin };
}

/**
 * Generate ASS events for minimap background panel with grid
 * @param {number} mapX - Minimap X position
 * @param {number} mapY - Minimap Y position
 * @param {number} mapSize - Minimap size
 * @param {number} durationMs - Total duration in ms
 * @returns {string} ASS dialogue lines for background and grid
 */
function generateMinimapBackground(mapX, mapY, mapSize, durationMs) {
  const startTime = formatAssTime(0);
  const endTime = formatAssTime(durationMs);
  const cornerRadius = Math.round(mapSize * 0.05);

  const r = cornerRadius;
  const left = mapX;
  const top = mapY;
  const right = mapX + mapSize;
  const bottom = mapY + mapSize;

  // Rounded rectangle with semi-transparent dark fill
  const bgPath =
    `m ${left + r} ${top} ` +
    `l ${right - r} ${top} ` +
    `b ${right} ${top} ${right} ${top + r} ${right} ${top + r} ` +
    `l ${right} ${bottom - r} ` +
    `b ${right} ${bottom} ${right - r} ${bottom} ${right - r} ${bottom} ` +
    `l ${left + r} ${bottom} ` +
    `b ${left} ${bottom} ${left} ${bottom - r} ${left} ${bottom - r} ` +
    `l ${left} ${top + r} ` +
    `b ${left} ${top} ${left + r} ${top} ${left + r} ${top}`;

  const events = [];

  // Main background
  events.push(`Dialogue: 0,${startTime},${endTime},MinimapBg,,0,0,0,,{\\an7\\pos(0,0)\\bord1\\shad0\\1c&H282828&\\3c&H404040&\\1a&H20&\\p1}${bgPath}{\\p0}`);

  // Add subtle grid lines for schematic appearance
  const gridSpacing = Math.round(mapSize / 5);
  const gridLineWidth = 1;
  let gridPath = '';

  // Vertical grid lines
  for (let x = left + gridSpacing; x < right; x += gridSpacing) {
    gridPath += `m ${x} ${top + r} l ${x} ${bottom - r} `;
  }

  // Horizontal grid lines  
  for (let y = top + gridSpacing; y < bottom; y += gridSpacing) {
    gridPath += `m ${left + r} ${y} l ${right - r} ${y} `;
  }

  // Draw grid as thin lines (using small rectangles for visibility)
  if (gridPath) {
    // Convert line paths to thin rectangles for ASS
    let gridRects = '';
    for (let x = left + gridSpacing; x < right; x += gridSpacing) {
      gridRects += `m ${x} ${top + r} l ${x + gridLineWidth} ${top + r} l ${x + gridLineWidth} ${bottom - r} l ${x} ${bottom - r} `;
    }
    for (let y = top + gridSpacing; y < bottom; y += gridSpacing) {
      gridRects += `m ${left + r} ${y} l ${right - r} ${y} l ${right - r} ${y + gridLineWidth} l ${left + r} ${y + gridLineWidth} `;
    }
    events.push(`Dialogue: 0,${startTime},${endTime},MinimapBg,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H383838&\\1a&H60&\\p1}${gridRects}{\\p0}`);
  }

  return events.join('\n');
}

/**
 * Generate ASS drawing for route path as proper stroked line segments
 * ASS fills shapes, so we draw thin rectangles for each line segment to simulate a stroke
 * @param {Array} gpsPath - Array of [lat, lon] coordinates
 * @param {Object} bounds - GPS bounds
 * @param {number} mapSize - Minimap size
 * @param {number} mapX - Minimap X offset
 * @param {number} mapY - Minimap Y offset
 * @param {number} durationMs - Total duration in ms
 * @returns {string} ASS dialogue lines for route path segments
 */

// Catmull-Rom spline interpolation for smooth curves between points
// Ported from minimap-renderer.html Leaflet smoothing
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Smooth a path of {x, y} points using Catmull-Rom spline interpolation
 * @param {Array<{x: number, y: number}>} points - Pixel-space points
 * @param {number} subdivisions - Intermediate points per segment (default 4)
 * @returns {Array<{x: number, y: number}>} Smoothed points
 */
function smoothPixelPath(points, subdivisions = 4) {
  if (points.length < 3) return points;

  const result = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];

    for (let s = 0; s < subdivisions; s++) {
      const t = s / subdivisions;
      result.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, t)
      });
    }
  }

  // Add the final point
  result.push(points[points.length - 1]);
  return result;
}

function generateMinimapRoutePath(gpsPath, bounds, mapSize, mapX, mapY, durationMs, marginFraction = 0.1, mapZoom = null) {
  if (!gpsPath || gpsPath.length < 2) return '';

  const startTime = formatAssTime(0);
  const endTime = formatAssTime(durationMs);

  // Convert all GPS points to pixel coordinates
  const points = gpsPath.map(([lat, lon]) => gpsToPixel(lat, lon, bounds, mapSize, mapX, mapY, marginFraction));

  // Apply Catmull-Rom spline smoothing in pixel space for smooth curves at turns
  // (same algorithm as the Leaflet renderer in minimap-renderer.html)
  const smoothedPoints = smoothPixelPath(points, 4);

  // Downsample smoothed points to reduce ASS path complexity
  const maxPoints = 500;
  let sampledPoints = smoothedPoints;
  if (smoothedPoints.length > maxPoints) {
    const step = Math.ceil(smoothedPoints.length / maxPoints);
    sampledPoints = smoothedPoints.filter((_, i) => i % step === 0 || i === smoothedPoints.length - 1);
  }

  // Line thickness scales with both minimap size and zoom level
  // Higher zoom = more detail visible = thinner line so roads aren't obscured
  const strokeWidth = mapZoom
    ? Math.max(2, Math.round(mapSize / (60 + (mapZoom - 12) * 12)))
    : Math.max(2, Math.round(mapSize / 80));

  // Build path as a series of thin filled rectangles (stroke segments)
  // For each segment, create a quadrilateral perpendicular to the line direction
  // Start with anchor points at (0,0) and (mapX+mapSize, mapY+mapSize) to fix bounding box.
  // ASS \an7\pos(0,0) positions the bounding box top-left at (0,0), so without anchors
  // the drawing shifts by (-min_x, -min_y) of the path coordinates, misaligning with the map.
  let pathStr = `m ${mapX} ${mapY} m ${mapX + mapSize} ${mapY + mapSize} `;

  for (let i = 0; i < sampledPoints.length - 1; i++) {
    const p1 = sampledPoints[i];
    const p2 = sampledPoints[i + 1];

    // Calculate direction vector
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < 0.5) continue; // Skip tiny segments

    // Perpendicular unit vector for stroke width
    const px = (-dy / len) * strokeWidth / 2;
    const py = (dx / len) * strokeWidth / 2;

    // Four corners of the line segment rectangle
    const x1 = Math.round(p1.x + px);
    const y1 = Math.round(p1.y + py);
    const x2 = Math.round(p1.x - px);
    const y2 = Math.round(p1.y - py);
    const x3 = Math.round(p2.x - px);
    const y3 = Math.round(p2.y - py);
    const x4 = Math.round(p2.x + px);
    const y4 = Math.round(p2.y + py);

    // Draw as filled quadrilateral
    pathStr += `m ${x1} ${y1} l ${x2} ${y2} l ${x3} ${y3} l ${x4} ${y4} `;
  }

  // Circle approximation using bezier curves for round joints and caps
  const circleAt = (cx, cy, r) => {
    const k = 0.552284749831; // Bezier circle constant
    return `m ${cx} ${cy - r} ` +
      `b ${cx + r * k} ${cy - r} ${cx + r} ${cy - r * k} ${cx + r} ${cy} ` +
      `b ${cx + r} ${cy + r * k} ${cx + r * k} ${cy + r} ${cx} ${cy + r} ` +
      `b ${cx - r * k} ${cy + r} ${cx - r} ${cy + r * k} ${cx - r} ${cy} ` +
      `b ${cx - r} ${cy - r * k} ${cx - r * k} ${cy - r} ${cx} ${cy - r} `;
  };

  // Add round joints at every point to fill gaps between angled segments
  const jointRadius = strokeWidth / 2;
  for (let i = 0; i < sampledPoints.length; i++) {
    pathStr += circleAt(Math.round(sampledPoints[i].x), Math.round(sampledPoints[i].y), jointRadius);
  }

  // Route line with blue color
  return `Dialogue: 1,${startTime},${endTime},MinimapPath,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFF7200&\\p1}${pathStr}{\\p0}`;
}

/**
 * Generate ASS arrow marker path (direction indicator)
 * Creates a navigation arrow pointing up, centered at (0,0)
 * Based on new arrow icon design - modern navigation style
 * @param {number} scale - Scale factor
 * @param {number} cx - Center X position in absolute pixel coordinates (default 0)
 * @param {number} cy - Center Y position in absolute pixel coordinates (default 0)
 * @returns {string} ASS drawing path for arrow
 */
function generateArrowPath(scale = 1, cx = 0, cy = 0) {
  // Navigation arrow icon - drawn at absolute position (cx, cy)
  // When cx/cy are provided, the arrow is positioned at those absolute pixel
  // coordinates, matching the route path's absolute coordinate strategy.
  const baseScale = scale / 15;
  const s = baseScale;

  // Right half of arrow
  const path = `m ${(0.5 * s + cx).toFixed(2)} ${(151 * s + cy).toFixed(2)} ` +
    `b ${(15.24 * s + cx).toFixed(2)} ${(159 * s + cy).toFixed(2)} ${(29.98 * s + cx).toFixed(2)} ${(167 * s + cy).toFixed(2)} ${(44.72 * s + cx).toFixed(2)} ${(175.08 * s + cy).toFixed(2)} ` +
    `${(108.97 * s + cx).toFixed(2)} ${(210.28 * s + cy).toFixed(2)} ${(156.82 * s + cx).toFixed(2)} ${(193.32 * s + cy).toFixed(2)} ${(132.86 * s + cx).toFixed(2)} ${(129.62 * s + cy).toFixed(2)} ` +
    `${(106.86 * s + cx).toFixed(2)} ${(69.24 * s + cy).toFixed(2)} ${(24.97 * s + cx).toFixed(2)} ${(-121.96 * s + cy).toFixed(2)} ${(24.97 * s + cx).toFixed(2)} ${(-121.96 * s + cy).toFixed(2)} ` +
    `${(16.03 * s + cx).toFixed(2)} ${(-142.33 * s + cy).toFixed(2)} ${(8.22 * s + cx).toFixed(2)} ${(-150.11 * s + cy).toFixed(2)} ${(0.5 * s + cx).toFixed(2)} ${(-150.44 * s + cy).toFixed(2)} ` +
    `${(0.5 * s + cx).toFixed(2)} ${(-150.44 * s + cy).toFixed(2)} ${(0.5 * s + cx).toFixed(2)} ${(50.57 * s + cy).toFixed(2)} ${(0.5 * s + cx).toFixed(2)} ${(151 * s + cy).toFixed(2)} ` +
    // Left half of arrow (mirrored)
    `m ${(-0.5 * s + cx).toFixed(2)} ${(151 * s + cy).toFixed(2)} ` +
    `b ${(-15.24 * s + cx).toFixed(2)} ${(159 * s + cy).toFixed(2)} ${(-29.98 * s + cx).toFixed(2)} ${(167 * s + cy).toFixed(2)} ${(-44.72 * s + cx).toFixed(2)} ${(175.08 * s + cy).toFixed(2)} ` +
    `${(-108.97 * s + cx).toFixed(2)} ${(210.28 * s + cy).toFixed(2)} ${(-156.82 * s + cx).toFixed(2)} ${(193.32 * s + cy).toFixed(2)} ${(-132.86 * s + cx).toFixed(2)} ${(129.62 * s + cy).toFixed(2)} ` +
    `${(-106.86 * s + cx).toFixed(2)} ${(69.24 * s + cy).toFixed(2)} ${(-24.97 * s + cx).toFixed(2)} ${(-121.96 * s + cy).toFixed(2)} ${(-24.97 * s + cx).toFixed(2)} ${(-121.96 * s + cy).toFixed(2)} ` +
    `${(-16.03 * s + cx).toFixed(2)} ${(-142.33 * s + cy).toFixed(2)} ${(-8.22 * s + cx).toFixed(2)} ${(-150.11 * s + cy).toFixed(2)} ${(-0.5 * s + cx).toFixed(2)} ${(-150.44 * s + cy).toFixed(2)} ` +
    `${(-0.5 * s + cx).toFixed(2)} ${(-150.44 * s + cy).toFixed(2)} ${(-0.5 * s + cx).toFixed(2)} ${(50.57 * s + cy).toFixed(2)} ${(-0.5 * s + cx).toFixed(2)} ${(151 * s + cy).toFixed(2)}`;

  return path;
}

/**
 * Generate ASS events for position markers throughout the video
 * @param {Array} seiData - Array of {timestampMs, sei} objects with GPS data
 * @param {Array} gpsPath - Array of [lat, lon] for bounds calculation
 * @param {Object} bounds - GPS bounds
 * @param {number} mapSize - Minimap size
 * @param {number} mapX - Minimap X offset
 * @param {number} mapY - Minimap Y offset
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @returns {string} ASS dialogue lines for position markers
 */
function generateMinimapMarkers(seiData, gpsPath, bounds, mapSize, mapX, mapY, startTimeMs, endTimeMs, marginFraction = 0.1, mapZoom = null) {
  if (!seiData || seiData.length === 0) return '';

  const events = [];
  // Arrow marker size — smaller for cleaner appearance on detailed maps
  const markerScale = Math.max(0.5, mapSize / 400);

  // Bounding box anchors for \an7\pos(0,0) positioning — same strategy as the route path.
  // These moveto points force the bounding box to span the full minimap area,
  // so \an7 places drawing coordinates at their absolute pixel positions.
  const bboxAnchors = `m ${mapX} ${mapY} m ${mapX + mapSize} ${mapY + mapSize} `;

  // Collect all valid GPS waypoints with pixel positions and timestamps
  const waypoints = [];
  for (let i = 0; i < seiData.length; i++) {
    const { timestampMs, sei } = seiData[i];
    const lat = sei?.latitude_deg ?? sei?.latitudeDeg ?? 0;
    const lon = sei?.longitude_deg ?? sei?.longitudeDeg ?? 0;
    const heading = sei?.heading_deg ?? sei?.headingDeg ?? 0;

    if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) continue;

    const pos = gpsToPixel(lat, lon, bounds, mapSize, mapX, mapY, marginFraction);
    const relativeTimeMs = timestampMs - startTimeMs;
    waypoints.push({ x: pos.x, y: pos.y, heading: heading, timeMs: relativeTimeMs });
  }

  if (waypoints.length === 0) return '';

  // Smooth raw waypoints with large window to eliminate GPS noise
  const smoothWindow = 50;
  const halfWin = Math.floor(smoothWindow / 2);
  const smoothedAll = waypoints.map((wp, i) => {
    let sumX = 0, sumY = 0, sinH = 0, cosH = 0, count = 0;
    for (let j = Math.max(0, i - halfWin); j <= Math.min(waypoints.length - 1, i + halfWin); j++) {
      sumX += waypoints[j].x;
      sumY += waypoints[j].y;
      const hRad = waypoints[j].heading * Math.PI / 180;
      sinH += Math.sin(hRad);
      cosH += Math.cos(hRad);
      count++;
    }
    // Circular mean for heading to handle 0°/360° wraparound correctly
    const avgHeading = Math.atan2(sinH / count, cosH / count) * 180 / Math.PI;
    const normalizedHeading = ((avgHeading % 360) + 360) % 360;
    return { x: Math.round(sumX / count), y: Math.round(sumY / count), heading: Math.round(normalizedHeading / 2) * 2, timeMs: wp.timeMs };
  });

  // Downsample to ~1 keyframe per frame at 36fps (28ms) for smooth arrow movement
  const keyframeIntervalMs = 28;
  const smoothed = [smoothedAll[0]];
  for (let i = 1; i < smoothedAll.length; i++) {
    if (smoothedAll[i].timeMs - smoothed[smoothed.length - 1].timeMs >= keyframeIntervalMs) {
      smoothed.push(smoothedAll[i]);
    }
  }
  // Always include the last point
  if (smoothed[smoothed.length - 1] !== smoothedAll[smoothedAll.length - 1]) {
    smoothed.push(smoothedAll[smoothedAll.length - 1]);
  }

  // Emit static keyframe events — no \move() since it's incompatible with \frz rotation
  // 28ms intervals (~1 frame at 36fps) keep the arrow position current every frame
  for (let i = 0; i < smoothed.length; i++) {
    const wp = smoothed[i];
    const nextWp = i < smoothed.length - 1 ? smoothed[i + 1] : null;

    const startTime = formatAssTime(Math.max(0, wp.timeMs));
    const endTime = nextWp
      ? formatAssTime(Math.max(0, nextWp.timeMs))
      : formatAssTime(Math.max(0, endTimeMs - startTimeMs));

    const arrowPath = generateArrowPath(markerScale, wp.x, wp.y);

    events.push(`Dialogue: 2,${startTime},${endTime},MinimapMarker,,0,0,0,,{\\an7\\pos(0,0)\\org(${wp.x},${wp.y})\\frz${-wp.heading}\\bord2\\shad1\\1c&H0000FF&\\3c&HFFFFFF&\\4c&H000000&\\p1}${bboxAnchors}${arrowPath}{\\p0}`);
  }

  return events.join('\n');
}

/**
 * Generate complete ASS file for minimap overlay
 * @param {Array} seiData - Array of {timestampMs, sei} objects with GPS data
 * @param {Array} mapPath - Array of [lat, lon] coordinates for route display
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Options including playResX, playResY, position, size
 * @returns {string} Complete ASS file content
 */
function generateMinimapAss(seiData, mapPath, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    position = 'top-right',
    size = 'small',
    // For standalone mode (overlaying on map image), set these:
    standaloneMode = false,  // If true, generates ASS for a standalone minimap image
    standaloneSize = 256,    // Size of the standalone minimap
    customBounds = null,     // Custom GPS bounds (e.g., from map tiles)
    includeBackground = true, // Whether to include the dark background
    mapZoom = null           // Tile zoom level (for scaling line thickness)
  } = options;

  const durationMs = endTimeMs - startTimeMs;

  let mapX, mapY, mapSize;

  if (standaloneMode) {
    // Standalone mode: ASS coordinates are 0,0 to standaloneSize,standaloneSize
    mapX = 0;
    mapY = 0;
    mapSize = standaloneSize;
  } else {
    // Normal mode: Calculate position within video frame
    const layout = calculateMinimapLayout(playResX, playResY, position, size);
    mapX = layout.mapX;
    mapY = layout.mapY;
    mapSize = layout.mapSize;
  }

  // Use custom bounds if provided (e.g., from map tile boundaries), otherwise calculate from path
  const bounds = customBounds || calculateGpsBounds(mapPath);

  // Generate header with appropriate resolution
  const headerResX = standaloneMode ? standaloneSize : playResX;
  const headerResY = standaloneMode ? standaloneSize : playResY;
  let assContent = generateMinimapAssHeader(headerResX, headerResY);

  // Generate background panel (skip in standalone mode if we have a map image background)
  if (includeBackground) {
    assContent += generateMinimapBackground(mapX, mapY, mapSize, durationMs) + '\n';
  }

  // Generate route path - extract GPS from seiData to ensure path matches arrow position
  // This ensures the blue line follows the same coordinates as the arrow marker
  const seiGpsPath = seiData
    .map(({ sei }) => {
      const lat = sei?.latitude_deg ?? sei?.latitudeDeg ?? 0;
      const lon = sei?.longitude_deg ?? sei?.longitudeDeg ?? 0;
      // Skip invalid coordinates
      if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return null;
      return [lat, lon];
    })
    .filter(coord => coord !== null);

  // Use seiGpsPath if available, otherwise fall back to mapPath
  // When customBounds are provided (from map tile edges), always use them to ensure
  // the route aligns with the map background. Only recalculate when no custom bounds.
  const routeGpsPath = seiGpsPath.length > 0 ? seiGpsPath : mapPath;
  const routeBounds = customBounds || (seiGpsPath.length > 0 ? calculateGpsBounds(seiGpsPath) : bounds);
  // When using map tile background (customBounds), use no margin since tile bounds
  // already provide natural padding and margin would misalign track with roads
  const marginFraction = customBounds ? 0 : 0.1;
  const routePath = generateMinimapRoutePath(routeGpsPath, routeBounds, mapSize, mapX, mapY, durationMs, marginFraction, mapZoom);
  if (routePath) {
    assContent += routePath + '\n';
  }

  // Generate position markers - use same bounds and margin as route path for alignment
  const markers = generateMinimapMarkers(seiData, mapPath, routeBounds, mapSize, mapX, mapY, startTimeMs, endTimeMs, marginFraction, mapZoom);
  if (markers) {
    assContent += markers + '\n';
  }

  return assContent;
}

/**
 * Write minimap ASS file to temp directory
 * @param {string} exportId - Export ID for unique filename
 * @param {Array} seiData - SEI telemetry data with GPS
 * @param {Array} mapPath - GPS path coordinates
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @param {Object} options - Export options
 * @returns {Promise<string>} Path to generated ASS file
 */
async function writeMinimapAss(exportId, seiData, mapPath, startTimeMs, endTimeMs, options) {
  const assContent = generateMinimapAss(seiData, mapPath, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `minimap_${exportId}_${Date.now()}.ass`);

  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated minimap overlay: ${tempPath} (${mapPath?.length || 0} GPS points)`);

  return tempPath;
}

// ============================================
// ASS DETAILED DASHBOARD GENERATION
// Vertical list-based telemetry dashboard using ASS drawings
// ============================================

/**
 * Generate ASS header with styles for detailed dashboard
 * @param {number} playResX - Coordinate space width
 * @param {number} playResY - Coordinate space height
 * @param {number} fontSize - Base font size
 * @returns {string} ASS header section
 */
function generateDetailedAssHeader(playResX, playResY, fontSize) {
  const scaledFontSize = Math.round(fontSize);
  const smallFontSize = Math.round(fontSize * 0.7);
  const largeFontSize = Math.round(fontSize * 1.8);
  const labelFontSize = Math.round(fontSize * 0.6);

  return `[Script Info]
Title: Tesla Detailed Dashboard
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: DetailedDash,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: DetailedLabel,Segoe UI,${labelFontSize},&H00909090,&H00909090,${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: DetailedValue,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: DetailedLarge,Segoe UI,${largeFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: DetailedSmall,Segoe UI,${smallFontSize},&H00A0A0A0,&H00A0A0A0,${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: DetailedGreen,Segoe UI,${scaledFontSize},${COLORS.green},${COLORS.green},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: DetailedBlue,Segoe UI,${scaledFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: DetailedRed,Segoe UI,${scaledFontSize},${COLORS.red},${COLORS.red},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Generate detailed dashboard events for a time range
 * Vertical list layout matching the reference image with app theme
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options
 * @returns {string} ASS events section
 */
function generateDetailedDashboardEvents(seiData, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    position = 'bottom-center',
    size = 'medium',
    useMetric = false,
    segments = [],
    cumStarts = [],
    dateFormat = 'mdy',
    timeFormat = '12h',
    language = 'en',
    customPosition = null,
    // Defaults to 1 so the simple modal (which doesn't send these) is
    // unaffected. The AE sends user-chosen multipliers from the sidebar's
    // Label Size / Value Size dropdowns.
    labelScale = 1,
    valueScale = 1
  } = options;

  const tLang = DASHBOARD_TRANSLATIONS[language] || DASHBOARD_TRANSLATIONS.en;
  const labels = tLang.labels || DASHBOARD_TRANSLATIONS.en.labels;
  const brakeStates = tLang.brakeStates || DASHBOARD_TRANSLATIONS.en.brakeStates;
  const apStates = tLang.apStates || DASHBOARD_TRANSLATIONS.en.apStates;

  // Dashboard dimensions
  const sizeMultipliers = { 'small': 0.30, 'medium': 0.40, 'large': 0.50, 'xlarge': 0.60 };
  const sizeMultiplier = sizeMultipliers[size] || 0.40;

  const numRows = 9; // Speed, Gear, Steering, Accel, Brake, Blinkers, Autopilot, GPS, Acceleration
  const totalRows = numRows + 1; // +1 for the Date/Time header row at the top

  let dashWidth, dashHeight, rowHeight, pos;
  if (customPosition) {
    dashWidth = Math.max(80, Math.round(customPosition.w));
    dashHeight = Math.max(80, Math.round(customPosition.h));
    // Fill the user's tile precisely: 10 content rows (header + 9 data)
    // sized to fit between top and bottom paddings. The old `/ (totalRows
    // + 1)` left an extra row's worth of dead space below the last row.
    const customPadding = Math.round(dashWidth * 0.06);
    rowHeight = Math.max(10, Math.floor((dashHeight - 2 * customPadding) / totalRows));
    pos = {
      x: Math.round(customPosition.x + dashWidth / 2),
      y: Math.round(customPosition.y + dashHeight / 2)
    };
  } else {
    dashWidth = Math.min(Math.round(1920 * sizeMultiplier * 0.50), playResX - 80);
    const maxHeight = Math.round(playResY * 0.80);
    rowHeight = Math.min(Math.round(dashWidth * 0.16), Math.floor(maxHeight / (totalRows + 1)));
    dashHeight = Math.min(Math.round(rowHeight * (totalRows + 1)), maxHeight);
    pos = calculatePosition(position, playResX, playResY, dashWidth, dashHeight);
  }
  // Header zone = one full row, so the header reads as a sibling of the other rows.
  const dateHeaderHeight = rowHeight;
  // Base sizes — unchanged formula so simple-modal exports stay identical.
  // AE applies labelScale / valueScale as multipliers on top.
  const baseFont = Math.max(12, Math.round(rowHeight * 0.42));
  const fontSize = Math.max(8, Math.round(baseFont * valueScale));
  const labelFontSize = Math.max(8, Math.round(baseFont * 0.75 * labelScale));
  const largeFontSize = Math.max(10, Math.round(baseFont * 2.0 * valueScale));
  const smallFontSize = Math.max(8, Math.round(baseFont * 0.82 * valueScale));
  const headerFontSize = Math.max(10, Math.round(baseFont * 1.15 * valueScale));
  // Icons must FIT inside the row regardless of value scale — otherwise the
  // steering wheel (and any future icon) bleeds into the row above/below
  // when the user picks a large value-scale.
  const iconSize = Math.min(
    Math.max(8, Math.round(rowHeight * 0.70 * valueScale)),
    Math.round(rowHeight * 0.85)
  );
  // For rows that display TWO stacked text lines in a single rowHeight (GPS:
  // coords + heading; G-Force: lateral + longitudinal). Capped at ~38% so
  // both lines plus inter-line padding fit cleanly without crowding the
  // separator below.
  const dualLineFontSize = Math.min(smallFontSize, Math.max(8, Math.round(rowHeight * 0.38)));
  const padding = Math.round(dashWidth * 0.06);
  const events = [];

  // Panel bounds
  const panelLeft = pos.x - dashWidth / 2;
  const panelRight = pos.x + dashWidth / 2;
  const panelTop = pos.y - dashHeight / 2;
  const panelBottom = pos.y + dashHeight / 2;
  const contentLeft = panelLeft + padding;
  const contentRight = panelRight - padding;
  const contentWidth = contentRight - contentLeft;
  const centerX = pos.x;

  // ---- Horizontal width caps (AE-only) ----
  // ASS computes fonts from rowHeight only, so a tall+narrow dashboard ends
  // up with text wider than the panel. Cap each text by an estimated char
  // count so the centered/aligned strings stay inside the dashboard width.
  // Simple modal exports use their original (uncapped) font sizes — only
  // gated for customPosition (AE) since the simple modal's preset sizes
  // were already tuned for its layout and shouldn't be shrunk.
  const widthCap = (charCount, available) =>
    Math.max(8, Math.floor(Math.max(10, available) / Math.max(1, charCount * 0.55)));
  const capIfCustom = (size, ...caps) =>
    customPosition ? Math.min(size, ...caps) : size;
  // Speed: value sits LEFT of centerX, unit sits RIGHT — each gets ~half.
  const speedFontWidth = capIfCustom(largeFontSize, widthCap(6, contentWidth * 0.55));
  const speedUnitFontWidth = capIfCustom(smallFontSize, widthCap(4, contentWidth * 0.42));
  // Header date/time spans the full width: longest format is ~24 chars.
  const headerFontWidth = capIfCustom(headerFontSize, widthCap(24, contentWidth));
  // Centered single-line value texts. Each capped by its longest string.
  const gearFontWidth   = capIfCustom(Math.round(fontSize * 1.5), widthCap(7,  contentWidth));  // "REVERSE"
  // Accel value sits ABOVE a horizontal progress bar — extra height cap so
  // the centered value never extends downward into the bar's area. AE-only
  // because the simple modal's original sizing was already safe.
  const accelFontWidth  = capIfCustom(
    Math.round(fontSize * 1.3),
    widthCap(5, contentWidth),
    Math.round(rowHeight * 0.50)
  );
  const brakeFontWidth  = capIfCustom(Math.round(fontSize * 1.3), widthCap(8,  contentWidth));  // "REGEN" / "OFF" / "ON"
  const apFontWidth     = capIfCustom(Math.round(fontSize * 1.3), widthCap(16, contentWidth));  // "FSD Supervised"
  // Steering angle sits next to the wheel icon, occupies right half only.
  const steerAngleFontWidth = capIfCustom(Math.round(fontSize * 1.3), widthCap(7, contentWidth * 0.40));

  // Row Y positions (top of each row's content area). Row 0 sits below the
  // date/time header row, so all rows shift down by dateHeaderHeight.
  const rowPadding = Math.round(rowHeight * 0.18);
  const getRowY = (rowIndex) => panelTop + padding + dateHeaderHeight + (rowIndex * rowHeight);
  // The header row mirrors getRowY(0) but at rowIndex -1 (i.e. panelTop + padding).
  const headerRowY = panelTop + padding;

  const durationMs = endTimeMs - startTimeMs;
  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const frameTimeMs = 1000 / FPS;

  // Blinker animation
  const framesPerBlinkerCycle = 25;
  const blinkerOnFrames = 14;
  let prevLeftBlinkerOn = false;
  let prevRightBlinkerOn = false;
  let leftBlinkerStartFrame = 0;
  let rightBlinkerStartFrame = 0;

  // Steering smoothing
  let smoothedSteeringAngle = 0;
  const steerFactor = 1 - Math.exp(-45 * (frameTimeMs / 1000));

  // Track previous state for change detection
  let prevState = null;
  let eventStartFrame = 0;

  // Corner radius for rounded rect
  const cornerRadius = Math.round(dashWidth * 0.04);

  // Section separator helper: visible line across the panel
  function drawSectionSep(startAssTime, endAssTime, y) {
    const sepY = Math.round(y);
    const sepLeft = Math.round(panelLeft + padding * 0.5);
    const sepRight = Math.round(panelRight - padding * 0.5);
    const sepH = 2; // 2px thick for visibility
    events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
      `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H555555&\\p1}` +
      `m ${sepLeft} ${sepY} l ${sepRight} ${sepY} l ${sepRight} ${sepY + sepH} l ${sepLeft} ${sepY + sepH}{\\p0}`
    ));
  }

  for (let frame = 0; frame <= totalFrames; frame++) {
    const currentTimeMs = startTimeMs + (frame * frameTimeMs);
    const sei = findSeiAtTime(seiData, currentTimeMs);

    // Extract telemetry values
    const mps = Math.abs(getSeiValue(sei, 'vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speedKmh = mps * MPS_TO_KMH;
    const speedMph = mps * MPS_TO_MPH;
    const primarySpeed = useMetric ? speedKmh.toFixed(1) : speedMph.toFixed(1);
    const primaryUnit = getSpeedUnit(useMetric, language);

    const gear = getSeiValue(sei, 'gearState', 'gear_state');
    const gearText = getGearText(gear, language);

    const leftBlinkerOn = !!getSeiValue(sei, 'blinkerOnLeft', 'blinker_on_left');
    const rightBlinkerOn = !!getSeiValue(sei, 'blinkerOnRight', 'blinker_on_right');

    const apState = getSeiValue(sei, 'autopilotState', 'autopilot_state') || 0;
    const apActive = apState === 1 || apState === 2;
    let apDisplayText = apStates.off;
    if (apState === 1) apDisplayText = apStates.fsd;
    else if (apState === 2) apDisplayText = apStates.autopilot;
    else if (apState === 3) apDisplayText = apStates.tacc;

    const brakeApplied = !!getSeiValue(sei, 'brakeApplied', 'brake_applied');

    const accelPos = getSeiValue(sei, 'acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPct = accelPos > 1 ? Math.min(100, Math.round(accelPos)) : Math.min(100, Math.round(accelPos * 100));

    const rawSteeringAngle = getSeiValue(sei, 'steeringWheelAngle', 'steering_wheel_angle') || 0;
    smoothedSteeringAngle += (rawSteeringAngle - smoothedSteeringAngle) * steerFactor;
    const steeringAngle = smoothedSteeringAngle;

    // Blinker animation
    if (leftBlinkerOn && !prevLeftBlinkerOn) leftBlinkerStartFrame = frame;
    if (rightBlinkerOn && !prevRightBlinkerOn) rightBlinkerStartFrame = frame;
    const leftFrameInCycle = (frame - leftBlinkerStartFrame) % framesPerBlinkerCycle;
    const rightFrameInCycle = (frame - rightBlinkerStartFrame) % framesPerBlinkerCycle;
    const leftBlinkVisible = leftBlinkerOn && leftFrameInCycle < blinkerOnFrames;
    const rightBlinkVisible = rightBlinkerOn && rightFrameInCycle < blinkerOnFrames;
    prevLeftBlinkerOn = leftBlinkerOn;
    prevRightBlinkerOn = rightBlinkerOn;

    // GPS data
    const lat = getSeiValue(sei, 'latitudeDeg', 'latitude_deg');
    const lon = getSeiValue(sei, 'longitudeDeg', 'longitude_deg');
    const heading = getSeiValue(sei, 'headingDeg', 'heading_deg');
    const latStr = (lat !== undefined && lat !== null) ? lat.toFixed(6) : '--';
    const lonStr = (lon !== undefined && lon !== null) ? lon.toFixed(6) : '--';
    const headingStr = (heading !== undefined && heading !== null) ? heading.toFixed(1) + '°' : '--';

    // G-Force data (convert m/s² to G)
    const GRAVITY = 9.81;
    const rawAccelX = getSeiValue(sei, 'linearAccelerationMps2X', 'linear_acceleration_mps2_x');
    const rawAccelY = getSeiValue(sei, 'linearAccelerationMps2Y', 'linear_acceleration_mps2_y');
    const gForceX = (rawAccelX !== undefined && rawAccelX !== null) ? (rawAccelX / GRAVITY) : null;
    const gForceY = (rawAccelY !== undefined && rawAccelY !== null) ? (rawAccelY / GRAVITY) : null;
    const gForceXStr = gForceX !== null ? ((gForceX >= 0 ? '+' : '') + gForceX.toFixed(2)) : '0.00';
    const gForceYStr = gForceY !== null ? ((gForceY >= 0 ? '+' : '') + gForceY.toFixed(2)) : '0.00';

    // Date/Time header: bucket to whole seconds so the signature changes once per
    // second (otherwise it would never tick even though the clock should move).
    const headerActualTs = convertVideoTimeToTimestamp(currentTimeMs, segments, cumStarts);
    const headerTimeSec = Math.floor((headerActualTs || 0) / 1000);

    // Create state signature
    const currentState = JSON.stringify({
      primarySpeed, gearText,
      leftBlinkVisible, rightBlinkVisible,
      apActive, apDisplayText, brakeApplied, accelPct,
      steeringAngle: Math.round(steeringAngle * 10) / 10,
      latStr, lonStr, headingStr,
      gForceXStr, gForceYStr,
      headerTimeSec
    });

    // Emit events when state changes or at end
    if (currentState !== prevState || frame === totalFrames) {
      if (prevState !== null && eventStartFrame < frame) {
        const startAssTime = formatAssTime(eventStartFrame * frameTimeMs);
        const endAssTime = formatAssTime(frame * frameTimeMs);
        const prev = JSON.parse(prevState);
        const r = cornerRadius;

        // === Background Panel ===
        events.push(dialogueLine(0, startAssTime, endAssTime, 'DetailedDash',
          `{\\an7\\pos(0,0)\\bord1\\shad0\\1c&H282828&\\3c&H404040&\\1a&H30&\\p1}` +
          `m ${panelLeft + r} ${panelTop} ` +
          `l ${panelRight - r} ${panelTop} ` +
          `b ${panelRight} ${panelTop} ${panelRight} ${panelTop + r} ${panelRight} ${panelTop + r} ` +
          `l ${panelRight} ${panelBottom - r} ` +
          `b ${panelRight} ${panelBottom} ${panelRight - r} ${panelBottom} ${panelRight - r} ${panelBottom} ` +
          `l ${panelLeft + r} ${panelBottom} ` +
          `b ${panelLeft} ${panelBottom} ${panelLeft} ${panelBottom - r} ${panelLeft} ${panelBottom - r} ` +
          `l ${panelLeft} ${panelTop + r} ` +
          `b ${panelLeft} ${panelTop} ${panelLeft + r} ${panelTop} ${panelLeft + r} ${panelTop}{\\p0}`
        ));

        // === Date/Time Header (first row of panel) ===
        // Uses the user's dateFormat (mdy/dmy/ymd) and timeFormat (12h/24h) prefs.
        // Laid out exactly like the other rows: grey label on the left, bold white
        // value centered in the row.
        {
          const headerEventTimeMs = startTimeMs + (eventStartFrame * frameTimeMs);
          const rawTs = convertVideoTimeToTimestamp(headerEventTimeMs, segments, cumStarts);
          // convertVideoTimeToTimestamp falls back to returning the raw videoTimeMs if
          // no segment matches — that would render as 1970-01-01. Treat anything before
          // year 2000 as 'no real timestamp available' so the formatters emit their
          // neutral --/-- placeholders instead of bogus 1970 dates.
          const headerTs = (rawTs && rawTs > 946684800000) ? rawTs : null;
          const headerDate = formatDisplayDate(headerTs, dateFormat);
          const headerTime = formatDisplayTime(headerTs, timeFormat);
          const headerText = `${headerDate}   ${headerTime}`;
          // Label (left, same style as Speed/Gear/Steering labels)
          events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
            `{\\an4\\pos(${contentLeft},${headerRowY + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.dateTime}`
          ));
          // Value (centered in the row, bold, white — same pattern as Brake's OFF/ON
          // and Gear's DRIVE, just a touch smaller so the full timestamp fits).
          events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
            `{\\an5\\pos(${centerX},${headerRowY + rowHeight * 0.58})\\bord0\\shad0\\fs${headerFontWidth}\\1c&HFFFFFF&\\b1}${headerText}`
          ));
          // Separator below the header (matches every other row's bottom separator).
          drawSectionSep(startAssTime, endAssTime, headerRowY + rowHeight);
        }

        // === Row 0: Speed ===
        const row0Y = getRowY(0);
        // Label (centered)
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row0Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.speed}`
        ));
        // Large speed value centered
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an6\\pos(${centerX},${row0Y + rowHeight * 0.55})\\bord0\\shad0\\fs${speedFontWidth}\\1c&H00CC44&\\b1}${prev.primarySpeed}`
        ));
        // Unit label to the right of speed number
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${centerX + Math.round(fontSize * 0.3)},${row0Y + rowHeight * 0.55})\\bord0\\shad0\\fs${speedUnitFontWidth}\\1c&HA0A0A0&}${primaryUnit}`
        ));

        drawSectionSep(startAssTime, endAssTime, row0Y + rowHeight);

        // === Row 1: Gear ===
        const row1Y = getRowY(1);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row1Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.gear}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row1Y + rowHeight * 0.58})\\bord0\\shad0\\fs${gearFontWidth}\\1c&HFFFFFF&\\b1}${prev.gearText}`
        ));

        drawSectionSep(startAssTime, endAssTime, row1Y + rowHeight);

        // === Row 2: Steering ===
        const row2Y = getRowY(2);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row2Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.steering}`
        ));
        // Horizontal layout: icon on left, angle text on right
        const steerIconRadius = Math.round(iconSize * 0.45);
        const steerWheelX = Math.round(centerX - dashWidth * 0.10);
        const steerWheelY = Math.round(row2Y + rowHeight * 0.50);
        const steerScale = iconSize / 446.5 * 0.55;
        const steerAngleAss = -(prev.steeringAngle || 0);
        const steerColor = prev.apActive ? '&HFF4800&' : '&H707070&';
        // Outer circle
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an7\\pos(${steerWheelX},${steerWheelY})\\org(${steerWheelX},${steerWheelY})\\bord0\\shad0\\1c${steerColor}\\frz${steerAngleAss}\\p1}` +
          drawSteeringWheelOuter(steerScale) + `{\\p0}`
        ));
        // Inner ring
        events.push(dialogueLine(2, startAssTime, endAssTime, 'DetailedDash',
          `{\\an7\\pos(${steerWheelX},${steerWheelY})\\org(${steerWheelX},${steerWheelY})\\bord0\\shad0\\1c&HFFFFFF&\\frz${steerAngleAss}\\p1}` +
          drawSteeringWheelInner(steerScale) + `{\\p0}`
        ));
        // Steering angle value to the right of the icon
        const steerAngleDisplay = prev.steeringAngle.toFixed(1) + '°';
        const steerTextX = Math.round(steerWheelX + steerIconRadius + padding);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${steerTextX},${steerWheelY})\\bord0\\shad0\\fs${steerAngleFontWidth}\\1c&H00CC44&\\b1}${steerAngleDisplay}`
        ));

        drawSectionSep(startAssTime, endAssTime, row2Y + rowHeight);

        // === Row 3: Accelerator ===
        const row3Y = getRowY(3);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row3Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.accelerator}`
        ));
        // Percentage value
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row3Y + rowHeight * 0.40})\\bord0\\shad0\\fs${accelFontWidth}\\1c&H00CC44&\\b1}${prev.accelPct}`
        ));
        // Horizontal bar background
        const barLeft = Math.round(contentLeft);
        const barRight = Math.round(contentRight);
        const barY = Math.round(row3Y + rowHeight * 0.68);
        const barHeight = Math.max(4, Math.round(rowHeight * 0.10));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H404040&\\p1}` +
          `m ${barLeft} ${barY} l ${barRight} ${barY} l ${barRight} ${barY + barHeight} l ${barLeft} ${barY + barHeight}{\\p0}`
        ));
        // Bar fill (green)
        if (prev.accelPct > 0) {
          const fillRight = Math.round(barLeft + (barRight - barLeft) * prev.accelPct / 100);
          events.push(dialogueLine(2, startAssTime, endAssTime, 'DetailedDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H00CC44&\\p1}` +
            `m ${barLeft} ${barY} l ${fillRight} ${barY} l ${fillRight} ${barY + barHeight} l ${barLeft} ${barY + barHeight}{\\p0}`
          ));
        }

        drawSectionSep(startAssTime, endAssTime, row3Y + rowHeight);

        // === Row 4: Brake ===
        const row4Y = getRowY(4);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row4Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.brake}`
        ));
        const brakeText = prev.brakeApplied ? brakeStates.on : brakeStates.off;
        const brakeColor = prev.brakeApplied ? '&H0000FF&' : '&HFFFFFF&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row4Y + rowHeight * 0.58})\\bord0\\shad0\\fs${brakeFontWidth}\\1c${brakeColor}\\b1}${brakeText}`
        ));

        drawSectionSep(startAssTime, endAssTime, row4Y + rowHeight);

        // === Row 5: Blinkers ===
        const row5Y = getRowY(5);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row5Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.blinkers}`
        ));
        // Left arrow
        const arrowScale = iconSize / 100 * 0.42;
        const leftArrowX = Math.round(centerX - dashWidth * 0.14);
        const leftArrowY = Math.round(row5Y + rowHeight * 0.58);
        const leftColor = prev.leftBlinkVisible ? '&H22C55E&' : '&H505050&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an7\\pos(${leftArrowX},${leftArrowY})\\bord0\\shad0\\1c${leftColor}\\p1}` +
          drawLeftArrow(arrowScale) + `{\\p0}`
        ));
        // Right arrow
        const rightArrowX = Math.round(centerX + dashWidth * 0.14);
        const rightArrowY = leftArrowY;
        const rightColor = prev.rightBlinkVisible ? '&H22C55E&' : '&H505050&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an7\\pos(${rightArrowX},${rightArrowY})\\bord0\\shad0\\1c${rightColor}\\p1}` +
          drawRightArrow(arrowScale) + `{\\p0}`
        ));

        drawSectionSep(startAssTime, endAssTime, row5Y + rowHeight);

        // === Row 6: Autopilot ===
        const row6Y = getRowY(6);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row6Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.autopilot}`
        ));
        const apColor = prev.apActive ? '&HFF4800&' : '&HFFFFFF&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row6Y + rowHeight * 0.58})\\bord0\\shad0\\fs${apFontWidth}\\1c${apColor}\\b1}${prev.apDisplayText}`
        ));

        drawSectionSep(startAssTime, endAssTime, row6Y + rowHeight);

        // === Row 7: GPS ===
        const row7Y = getRowY(7);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row7Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.gps}`
        ));
        // Coordinates — uses dualLineFontSize (capped) so coord + heading
        // both fit cleanly inside the row at high value-scale.
        const gpsText = `${prev.latStr}, ${prev.lonStr}`;
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row7Y + rowHeight * 0.42})\\bord0\\shad0\\fs${dualLineFontSize}\\1c&HCCCCCC&}${gpsText}`
        ));
        // Heading
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row7Y + rowHeight * 0.68})\\bord0\\shad0\\fs${dualLineFontSize}\\1c&HA0A0A0&}${labels.heading}: ${prev.headingStr}`
        ));

        drawSectionSep(startAssTime, endAssTime, row7Y + rowHeight);

        // === Row 8: G-Force ===
        const row8Y = getRowY(8);
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an4\\pos(${contentLeft},${row8Y + rowPadding})\\bord0\\shad0\\fs${labelFontSize}\\1c&H909090&}${labels.gForce}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row8Y + rowHeight * 0.42})\\bord0\\shad0\\fs${dualLineFontSize}\\1c&HCCCCCC&}${labels.lateral}:  ${prev.gForceXStr} G`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'DetailedDash',
          `{\\an5\\pos(${centerX},${row8Y + rowHeight * 0.68})\\bord0\\shad0\\fs${dualLineFontSize}\\1c&HCCCCCC&}${labels.longitudinal}:  ${prev.gForceYStr} G`
        ));
      }

      prevState = currentState;
      eventStartFrame = frame;
    }
  }

  return events.join('\n');
}

/**
 * Generate complete ASS subtitle file for detailed dashboard
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options
 * @returns {string} Complete ASS file content
 */
function generateDetailedDashboardAss(seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080 } = options;

  // Calculate font size based on resolution (must match generateDetailedDashboardEvents)
  const sizeMultiplier = { 'small': 0.30, 'medium': 0.40, 'large': 0.50, 'xlarge': 0.60 }[options.size] || 0.40;
  const dashWidth = Math.min(Math.round(1920 * sizeMultiplier * 0.50), playResX - 80);
  const maxHeight = Math.round(playResY * 0.80);
  const rowHeight = Math.min(Math.round(dashWidth * 0.16), Math.floor(maxHeight / 10));
  const fontSize = Math.max(12, Math.round(rowHeight * 0.42));

  const header = generateDetailedAssHeader(playResX, playResY, fontSize);
  const events = generateDetailedDashboardEvents(seiData, startTimeMs, endTimeMs, options);

  return header + events;
}

/**
 * Write detailed dashboard ASS subtitle file to temp directory
 * @param {string} exportId - Export ID for unique filename
 * @param {Array} seiData - SEI telemetry data
 * @param {number} startTimeMs - Start time in ms
 * @param {number} endTimeMs - End time in ms
 * @param {Object} options - Export options
 * @returns {Promise<string>} Path to generated ASS file
 */
async function writeDetailedDashboardAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateDetailedDashboardAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_detailed_${exportId}_${Date.now()}.ass`);

  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated detailed dashboard subtitle: ${tempPath}`);

  return tempPath;
}

// ============================================
// DEFAULT (floating-widget) DASHBOARD
// Matches the look of the floating #dashboardVis widget shown in the main
// player. v1: delegates the actual ASS render to the compact generator
// (same horizontal cluster of speed/gear/blinkers/autopilot/brake/accel),
// but writes to a distinct file path so logs/temp files identify the style.
// A future iteration can extend this with a second row containing the
// G-force meter + compass shapes to fully match the floating widget.
// ============================================

async function writeDefaultDashboardAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateCompactDashboardAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_default_${exportId}_${Date.now()}.ass`);

  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated default (floating-widget) dashboard subtitle: ${tempPath}`);

  return tempPath;
}

// ============================================
// TESLA MOBILE DASHBOARD
// Full-width bar mimicking Tesla app's dashcam viewer UI
// Only supports top or bottom positioning
// ============================================

/**
 * Generate ASS header for Tesla Mobile dashboard
 * Uses same styles as compact but with Tesla-specific theming
 */
function generateTeslaMobileAssHeader(playResX, playResY, fontSize) {
  const scaledFontSize = Math.round(fontSize);
  const smallFontSize = Math.round(fontSize * 0.7);
  const largeFontSize = Math.round(fontSize * 1.4);

  return `[Script Info]
Title: Tesla Mobile Dashboard
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CompactDash,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Speed,Segoe UI,${largeFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SpeedUnit,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Gear,Segoe UI,${scaledFontSize},${COLORS.white},${COLORS.white},${COLORS.dimGray},&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,10,10,10,1
Style: GearActive,Segoe UI,${scaledFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,10,10,10,1
Style: Time,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: APLabel,Segoe UI,${smallFontSize},${COLORS.whiteTransparent},${COLORS.whiteTransparent},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: APActive,Segoe UI,${smallFontSize},${COLORS.blue},${COLORS.blue},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: BlinkerOff,Segoe UI,${scaledFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: BlinkerOn,Segoe UI,${scaledFontSize},${COLORS.green},${COLORS.green},&H00115C2F,&H80000000,1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: BrakeOff,Segoe UI,${smallFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: BrakeOn,Segoe UI,${smallFontSize},${COLORS.red},${COLORS.red},&H00000080,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: AccelOff,Segoe UI,${smallFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.transparent},${COLORS.transparent},1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: AccelOn,Segoe UI,${smallFontSize},${COLORS.blue},${COLORS.blue},&H00802400,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SteeringWheel,Segoe UI,${largeFontSize},${COLORS.dimGray},${COLORS.dimGray},${COLORS.dimGray},&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: SteeringActive,Segoe UI,${largeFontSize},${COLORS.blue},${COLORS.blue},&H00802400,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Draw a filled circle in ASS vector drawing format (centered at 0,0)
 * @param {number} r - Radius
 * @returns {string} ASS path commands
 */
function drawCircle(r) {
  const k = Math.round(r * 0.5523); // Bezier approximation factor for circles
  return `m 0 ${-r} b ${k} ${-r} ${r} ${-k} ${r} 0 b ${r} ${k} ${k} ${r} 0 ${r} b ${-k} ${r} ${-r} ${k} ${-r} 0 b ${-r} ${-k} ${-k} ${-r} 0 ${-r}`;
}

/**
 * Generate Tesla Mobile dashboard events
 * Full-width bar that EXTENDS the canvas (below or above clips, not overlaid).
 * Layout matches Tesla app dashcam viewer:
 *   [Brake circle] [Gear circle] ... [← Blinker] [Speed MPH  Self-Driving] [→ Blinker] ... [Steering circle] [Accel circle]
 *   Center group (blinkers+speed+AP) tightly spaced, edge icons spread out.
 *
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} startTimeMs - Export start time in ms
 * @param {number} endTimeMs - Export end time in ms
 * @param {Object} options - Export options (playResY includes padded height, videoH = original)
 * @returns {string} ASS events section
 */
function generateTeslaMobileDashboardEvents(seiData, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    videoH = 1080,
    position = 'bottom',
    useMetric = false,
    segments = [],
    cumStarts = [],
    language = 'en',
    accelPedMode = 'iconbar',
    dateBarHeight = 0,
    dashBarHeight = 0,
    dateFormat = 'mdy',
    timeFormat = '12h',
    customPosition = null,
    // Defaults to 1 so the simple modal (which doesn't send these) is
    // unaffected. The AE sends user-chosen multipliers from the sidebar.
    labelScale = 1,
    valueScale = 1
  } = options;

  let dashWidth, dashHeight, dateHeight, posX0, posY;
  if (customPosition) {
    // Advanced Editor: dashboard bar fills the user's tile. No separate date bar.
    dashWidth = Math.max(80, Math.round(customPosition.w));
    dashHeight = Math.max(20, Math.round(customPosition.h));
    dateHeight = 0;
    posX0 = Math.round(customPosition.x);
    posY = Math.round(customPosition.y + dashHeight / 2);
  } else {
    dashHeight = dashBarHeight > 0 ? dashBarHeight : (playResY - videoH);
    dateHeight = dateBarHeight > 0 ? dateBarHeight : 0;
    dashWidth = playResX;
    posX0 = 0;
    const isTop = position === 'top' || position === 'top-center' || position === 'top-left' || position === 'top-right';
    posY = isTop
      ? dateHeight + dashHeight / 2          // Dashboard just below date bar
      : dateHeight + videoH + dashHeight / 2; // Dashboard below video
  }
  const isTop = position === 'top' || position === 'top-center' || position === 'top-left' || position === 'top-right';
  const dateCenterY = dateHeight / 2;

  // All circles use the SAME radius - derived from bar height with small padding.
  // valueScale scales the fontSize/text up/down (icons stay sized to circle so
  // they fit). Capped at ~90% of the bar height so text never overflows
  // vertically out of the bar.
  const circleR = Math.round(dashHeight * 0.38); // Circle diameter ~ 76% of bar height
  const baseFontSize = Math.round(circleR * 0.7); // Text proportional to circle
  const fontSize = Math.min(
    Math.max(8, Math.round(baseFontSize * valueScale)),
    Math.round(dashHeight * 0.85)
  );

  const events = [];

  // === LAYOUT ===
  // Tesla Mobile groups elements: edges have circled icons, center has tight blinker+speed+AP group
  // [Brake circle] [Gear circle] ---- [← blinker] [speed MPH] [AP text] [→ blinker] ---- [Steering circle] [Accel circle]
  const circleDiameter = circleR * 2;
  const circleGap = Math.round(circleR * 0.5); // Gap between adjacent circles
  const edgePadding = Math.round(dashWidth * 0.03);
  const centerX = posX0 + dashWidth / 2;

  // Left edge: [brake] [gap] [gear] starting from left padding
  const positions = {
    brake: posX0 + edgePadding + circleR,
    gear: posX0 + edgePadding + circleDiameter + circleGap + circleR,
  };

  // Right edge: [steering] [gap] [accel] ending at right padding
  positions.accel = posX0 + dashWidth - edgePadding - circleR;
  positions.steering = posX0 + dashWidth - edgePadding - circleDiameter - circleGap - circleR;

  // Center group: [← blinker] [speed MPH] [AP text] [→ blinker]
  // Tight spacing - fits within ~35% of width
  const centerGroupWidth = dashWidth * 0.32;
  const centerSpacing = centerGroupWidth / 3;
  positions.leftBlinker = centerX - centerSpacing * 1.5;
  positions.speed = centerX - centerSpacing * 0.5;
  positions.apStatus = centerX + centerSpacing * 0.5;
  positions.rightBlinker = centerX + centerSpacing * 1.5;

  // Hoisted text sizes with valueScale + width caps. AE's user-chosen Value
  // Size multiplies the base. Width caps (centerSpacing) are AE-only —
  // simple modal Tesla Mobile uses full canvas width and would be unfairly
  // shrunk by a centerSpacing cap. Vertical cap (dashHeight * 0.85) and
  // gear-letter cap (circle interior) apply to both modes since the
  // originals were already below them.
  const circleDiamLocal = circleR * 2;
  const heightCapTm = Math.round(dashHeight * 0.85);
  const widthCapTm = (charCount, available) =>
    Math.max(8, Math.floor(Math.max(10, available) / Math.max(1, charCount * 0.55)));
  const capIfCustomTm = (size, ...caps) =>
    customPosition ? Math.min(size, ...caps) : Math.min(size, heightCapTm);
  const speedNumSize  = capIfCustomTm(Math.round(circleDiamLocal * 0.95 * valueScale), heightCapTm, widthCapTm(5,  centerSpacing));
  const speedUnitSize = capIfCustomTm(Math.round(circleDiamLocal * 0.65 * valueScale), heightCapTm, widthCapTm(4,  centerSpacing * 0.7));
  const gearLetterSize = Math.min(Math.round(circleDiamLocal * 0.70 * valueScale), Math.round(circleDiamLocal * 0.85));
  const apFontSize    = capIfCustomTm(Math.round(circleDiamLocal * 0.65 * valueScale), heightCapTm, widthCapTm(16, centerSpacing));

  const durationMs = endTimeMs - startTimeMs;
  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const frameTimeMs = 1000 / FPS;

  // Blinker animation
  const framesPerBlinkerCycle = 25;
  const blinkerOnFrames = 14;
  let prevLeftBlinkerOn = false;
  let prevRightBlinkerOn = false;
  let leftBlinkerStartFrame = 0;
  let rightBlinkerStartFrame = 0;

  // Steering smoothing
  let smoothedSteeringAngle = 0;
  const steerFactor = 1 - Math.exp(-45 * (frameTimeMs / 1000));

  let prevState = null;
  let eventStartFrame = 0;

  for (let frame = 0; frame <= totalFrames; frame++) {
    const currentTimeMs = startTimeMs + (frame * frameTimeMs);
    const sei = findSeiAtTime(seiData, currentTimeMs);

    // Extract telemetry
    const mps = Math.abs(getSeiValue(sei, 'vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedUnit = getSpeedUnit(useMetric, language);

    const gear = getSeiValue(sei, 'gearState', 'gear_state');
    const gearLetter = gear === 1 ? 'D' : gear === 2 ? 'R' : gear === 0 ? 'P' : gear === 3 ? 'N' : '--';

    const leftBlinkerOn = !!getSeiValue(sei, 'blinkerOnLeft', 'blinker_on_left');
    const rightBlinkerOn = !!getSeiValue(sei, 'blinkerOnRight', 'blinker_on_right');

    const apState = getSeiValue(sei, 'autopilotState', 'autopilot_state');
    const apActive = apState === 1 || apState === 2;
    const apText = getApText(apState, language);

    const brakeActive = !!getSeiValue(sei, 'brakeApplied', 'brake_applied');

    const accelPos = getSeiValue(sei, 'acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPct = accelPos > 1 ? Math.min(100, accelPos) : Math.min(100, accelPos * 100);

    const rawSteeringAngle = getSeiValue(sei, 'steeringWheelAngle', 'steering_wheel_angle') || 0;
    smoothedSteeringAngle += (rawSteeringAngle - smoothedSteeringAngle) * steerFactor;
    const steeringAngle = smoothedSteeringAngle;

    // Blinker animation
    if (leftBlinkerOn && !prevLeftBlinkerOn) leftBlinkerStartFrame = frame;
    if (rightBlinkerOn && !prevRightBlinkerOn) rightBlinkerStartFrame = frame;
    const leftFrameInCycle = (frame - leftBlinkerStartFrame) % framesPerBlinkerCycle;
    const rightFrameInCycle = (frame - rightBlinkerStartFrame) % framesPerBlinkerCycle;
    const leftBlinkVisible = leftBlinkerOn && leftFrameInCycle < blinkerOnFrames;
    const rightBlinkVisible = rightBlinkerOn && rightFrameInCycle < blinkerOnFrames;
    prevLeftBlinkerOn = leftBlinkerOn;
    prevRightBlinkerOn = rightBlinkerOn;

    // Include seconds-level timestamp in state to ensure date/time bar updates each second
    const actualTs = dateHeight > 0 ? convertVideoTimeToTimestamp(currentTimeMs, segments, cumStarts) : 0;
    const timeSec = dateHeight > 0 ? Math.floor(actualTs / 1000) : 0;

    const currentState = JSON.stringify({
      speed, gearLetter, leftBlinkVisible, rightBlinkVisible,
      apActive, apText, brakeActive, accelPct: Math.round(accelPct),
      steeringAngle: Math.round(steeringAngle),
      timeSec
    });

    if (currentState !== prevState || frame === totalFrames) {
      if (prevState !== null && eventStartFrame < frame) {
        const startAssTime = formatAssTime((eventStartFrame * frameTimeMs));
        const endAssTime = formatAssTime((frame * frameTimeMs));
        const prev = JSON.parse(prevState);

        // No background needed - pad filter already fills with #1A1A1A

        // Date/Time bar (always at top, zone: 0..dateHeight)
        if (dateHeight > 0) {
          const eventStartTimeMs = startTimeMs + (eventStartFrame * frameTimeMs);
          const actualTimestampMs = convertVideoTimeToTimestamp(eventStartTimeMs, segments, cumStarts);
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
          const dateObj = actualTimestampMs ? new Date(actualTimestampMs) : new Date();
          const dayName = dayNames[dateObj.getDay()];
          const monthName = monthNames[dateObj.getMonth()];
          const dayNum = dateObj.getDate();
          const year = dateObj.getFullYear();
          const timeStr = formatDisplayTime(actualTimestampMs, timeFormat);
          const dateTimeStr = `${dayName}, ${monthName} ${dayNum}, ${year}   ${timeStr}`;

          const dateFontSize = Math.round(dateHeight * 0.55);
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an5\\pos(${playResX / 2},${dateCenterY})\\fs${dateFontSize}\\bord0\\shad0\\1c&HFFFFFF&\\1a&H00&}${dateTimeStr}`
          ));

          // Separator below date bar
          const dateSepY = dateHeight - 1;
          events.push(dialogueLine(0, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H333333&\\1a&H00&\\p1}` +
            `m 0 ${dateSepY} l ${playResX} ${dateSepY} l ${playResX} ${dateSepY + 1} l 0 ${dateSepY + 1}{\\p0}`
          ));
        }

        // Thin separator line between dashboard bar and video
        const dashBarTop = isTop ? dateHeight : dateHeight + videoH;
        const dashBarBottom = dashBarTop + dashHeight;
        // Separator on the video-facing edge of the dashboard bar
        const sepY = isTop ? (dashBarBottom - 1) : dashBarTop;
        events.push(dialogueLine(0, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H333333&\\1a&H00&\\p1}` +
          `m 0 ${sepY} l ${playResX} ${sepY} l ${playResX} ${sepY + 1} l 0 ${sepY + 1}{\\p0}`
        ));

        // --- Uniform sizing: everything matches circle diameter height ---
        // Circle diameter is the visual reference height for ALL elements.
        // Icon scales stay constant per-frame (sized to circle); text sizes
        // are hoisted outside the loop above so valueScale + caps apply.
        const circleDiam = circleR * 2;
        const pedalScale = circleR / 450 * 0.50;    // Pedal icons fit inside circle
        const steerScale = circleR / 446.5;  // Steering wheel matches other circle sizes
        const arrowScale = circleDiam / 100 * 0.45;          // Blinker arrows

        // === LEFT EDGE: Brake circle + Gear circle ===

        // Brake icon inside circle
        const brakeX = Math.round(positions.brake);
        const brakeBgColor = prev.brakeActive ? '&H000050&' : '&H303030&';
        const brakeIconColor = prev.brakeActive ? '&H0000FF&' : '&H909090&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${posY})\\bord0\\shad0\\1c${brakeBgColor}\\1a&H00&\\p1}` +
          drawCircle(circleR) + `{\\p0}`
        ));
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${posY})\\bord0\\shad0\\1c${brakeIconColor}\\p1}` +
          drawBrakePedal(pedalScale) + `{\\p0}`
        ));
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${brakeX},${posY})\\bord0\\shad0\\1c${brakeIconColor}\\p1}` +
          drawBrakePedalTab(pedalScale) + `{\\p0}`
        ));

        // Gear circle (Tesla style: letter in colored circle)
        const gearCX = Math.round(positions.gear);
        const gearCircleColor = prev.apActive ? '&HFF4800&' : '&H404040&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${gearCX},${posY})\\bord0\\shad0\\1c${gearCircleColor}\\1a&H00&\\p1}` +
          drawCircle(circleR) + `{\\p0}`
        ));
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${gearCX},${posY})\\bord0\\shad0\\fs${gearLetterSize}\\1c&HFFFFFF&\\b1}${prev.gearLetter}`
        ));

        // === CENTER GROUP: [← blinker] [speed MPH] [AP text] [→ blinker] ===

        // Left blinker
        const leftColor = prev.leftBlinkVisible ? '&H22C55E&' : '&H505050&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${Math.round(positions.leftBlinker)},${posY})\\bord0\\shad0\\1c${leftColor}\\p1}` +
          drawLeftArrow(arrowScale) + `{\\p0}`
        ));

        // Speed: number + unit
        const speedGap = circleDiam * 0.08;
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an6\\pos(${Math.round(positions.speed - speedGap)},${posY})\\bord0\\shad0\\fs${speedNumSize}\\1c&HFFFFFF&}${prev.speed}`
        ));
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an4\\pos(${Math.round(positions.speed + speedGap)},${posY})\\bord0\\shad0\\fs${speedUnitSize}\\1c&H808080&}${speedUnit}`
        ));

        // AP status text - same height as speed number (apFontSize hoisted above)
        const apColor = prev.apActive ? '&HFF4800&' : '&H808080&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${Math.round(positions.apStatus)},${posY})\\bord0\\shad0\\fs${apFontSize}\\1c${apColor}}${prev.apText}`
        ));

        // Right blinker
        const rightColor = prev.rightBlinkVisible ? '&H22C55E&' : '&H505050&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${Math.round(positions.rightBlinker)},${posY})\\bord0\\shad0\\1c${rightColor}\\p1}` +
          drawRightArrow(arrowScale) + `{\\p0}`
        ));

        // === RIGHT EDGE: Steering circle + Accel circle ===

        // Steering wheel (no background circle — the wheel outer ring IS the circle)
        const steerX = Math.round(positions.steering);
        const steerColor = prev.apActive ? '&HFF4800&' : '&H707070&';
        const angle = -(prev.steeringAngle || 0);
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${steerX},${posY})\\org(${steerX},${posY})\\bord0\\shad0\\1c${steerColor}\\frz${angle}\\p1}` +
          drawSteeringWheelOuter(steerScale) + `{\\p0}`
        ));
        events.push(dialogueLine(3, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${steerX},${posY})\\org(${steerX},${posY})\\bord0\\shad0\\1c&HFFFFFF&\\frz${angle}\\p1}` +
          drawSteeringWheelInner(steerScale) + `{\\p0}`
        ));

        // Accel pedal - respects user's accelPedMode setting
        // Icon is always centered in circle at same size as brake pedal
        // For iconbar/sidebar modes, the fill bar is OUTSIDE the circle to the right
        const accelX = Math.round(positions.accel);
        const accelPctVal = prev.accelPct || 0;
        const accelIsActive = accelPctVal > 5;

        // Circle background (always present)
        const accelBgColor = accelIsActive ? '&H505050&' : '&H303030&';
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c${accelBgColor}\\1a&H00&\\p1}` +
          drawCircle(circleR) + `{\\p0}`
        ));

        if (accelPedMode === 'solid') {
          // Solid mode: icon color changes on/off, same size as brake
          const solidColor = accelIsActive ? '&HC8C8C8&' : '&H909090&';
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c${solidColor}\\p1}` +
            drawAcceleratorPedal(pedalScale) + `{\\p0}`
          ));
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c${solidColor}\\p1}` +
            drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
          ));
        } else if (accelPedMode === 'sidebar') {
          // Sidebar mode: centered icon in circle + bar OUTSIDE circle to the right
          const sidebarIconColor = accelIsActive ? '&HC8C8C8&' : '&H909090&';
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c${sidebarIconColor}\\p1}` +
            drawAcceleratorPedal(pedalScale) + `{\\p0}`
          ));
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c${sidebarIconColor}\\p1}` +
            drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
          ));
          // Vertical bar outside circle, to the right, same height as circle diameter
          const barWidth = Math.max(3, Math.round(circleR * 0.12));
          const barHeight = circleR * 2; // Same height as circle
          const barX = accelX + circleR + Math.round(circleR * 0.2); // Gap after circle
          const barTop = posY - Math.round(barHeight / 2);
          const barBottom = posY + Math.round(barHeight / 2);
          // Gray background bar
          events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H404040&\\p1}` +
            `m ${barX} ${barTop} l ${barX + barWidth} ${barTop} l ${barX + barWidth} ${barBottom} l ${barX} ${barBottom}{\\p0}`
          ));
          // Gray/white fill from bottom
          if (accelPctVal > 0) {
            const fillTop = Math.round(barBottom - (barHeight * accelPctVal / 100));
            events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HC8C8C8&\\p1}` +
              `m ${barX} ${fillTop} l ${barX + barWidth} ${fillTop} l ${barX + barWidth} ${barBottom} l ${barX} ${barBottom}{\\p0}`
            ));
          }
        } else {
          // Iconbar mode (default): icon centered in circle, circle itself fills from bottom
          // Gray base icon (always visible)
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c&H909090&\\p1}` +
            drawAcceleratorPedal(pedalScale) + `{\\p0}`
          ));
          events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
            `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c&H909090&\\p1}` +
            drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
          ));
          // Colored circle fill from bottom based on percentage (the circle IS the bar)
          if (accelPctVal > 0) {
            const circleTop = posY - circleR;
            const circleBottom = posY + circleR;
            const clipY = Math.round(circleBottom - (circleR * 2 * accelPctVal / 100));
            const clipLeft = accelX - circleR;
            const clipRight = accelX + circleR;
            // Gray/white circle clipped from bottom
            events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c&HC8C8C8&\\1a&H40&\\clip(${clipLeft},${clipY},${clipRight},${circleBottom})\\p1}` +
              drawCircle(circleR) + `{\\p0}`
            ));
            // Re-draw icon on top in white so it's visible over the fill
            events.push(dialogueLine(3, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c&HFFFFFF&\\clip(${clipLeft},${clipY},${clipRight},${circleBottom})\\p1}` +
              drawAcceleratorPedal(pedalScale) + `{\\p0}`
            ));
            events.push(dialogueLine(3, startAssTime, endAssTime, 'CompactDash',
              `{\\an7\\pos(${accelX},${posY})\\bord0\\shad0\\1c&HFFFFFF&\\clip(${clipLeft},${clipY},${clipRight},${circleBottom})\\p1}` +
              drawAcceleratorPedalTab(pedalScale) + `{\\p0}`
            ));
          }
        }
      }

      prevState = currentState;
      eventStartFrame = frame;
    }
  }

  return events.join('\n');
}

/**
 * Helper: find the SEI sample nearest to a given time (earlier sample wins
 * ties). seiData is sorted by timestampMs, so this is a binary search —
 * the frame loops call it once per output frame, and a linear scan made
 * long exports O(n²) (minutes of blocked main process).
 */
function findSeiAtTime(seiData, videoTimeMs) {
  if (!seiData || seiData.length === 0) return null;

  // Binary search for the first sample with timestampMs >= videoTimeMs
  let lo = 0;
  let hi = seiData.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seiData[mid].timestampMs < videoTimeMs) lo = mid + 1;
    else hi = mid;
  }

  // Nearest is either seiData[lo] or its predecessor; on a tie the earlier wins
  if (lo > 0) {
    const prevDiff = Math.abs(seiData[lo - 1].timestampMs - videoTimeMs);
    const currDiff = Math.abs(seiData[lo].timestampMs - videoTimeMs);
    if (prevDiff <= currDiff) lo -= 1;
  }

  return seiData[lo]?.sei || null;
}

/**
 * Helper: convert video time to actual timestamp (extracted for reuse)
 */
function convertVideoTimeToTimestamp(videoTimeMs, segments, cumStarts) {
  if (!segments || segments.length === 0) return videoTimeMs;

  for (let i = 0; i < segments.length; i++) {
    const segStart = (cumStarts[i] || 0) * 1000;
    const segDuration = (segments[i]?.durationSec || 60) * 1000;
    const segEnd = segStart + segDuration;

    if (videoTimeMs >= segStart && videoTimeMs < segEnd) {
      const segmentTimestamp = segments[i]?.timestamp;
      if (segmentTimestamp) {
        const offsetInSegment = videoTimeMs - segStart;
        return segmentTimestamp + offsetInSegment;
      }
    }
  }

  return videoTimeMs;
}

/**
 * Generate complete ASS subtitle file for Tesla Mobile dashboard
 * playResY includes the padded bar area, videoH is the original video height
 */
function generateTeslaMobileDashboardAss(seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080, dashBarHeight = 0, videoH } = options;

  // Use explicit dashBarHeight if provided, else fallback
  const dashHeight = dashBarHeight > 0 ? dashBarHeight : (playResY - (videoH || playResY));
  // fontSize for ASS header styles - match the circleR-based sizing in events generator
  const circleR = Math.round(dashHeight * 0.38);
  const fontSize = Math.round(circleR * 0.7);

  const header = generateTeslaMobileAssHeader(playResX, playResY, fontSize);
  const events = generateTeslaMobileDashboardEvents(seiData, startTimeMs, endTimeMs, options);

  return header + events;
}

/**
 * Write Tesla Mobile dashboard ASS subtitle file to temp directory
 */
async function writeTeslaMobileDashboardAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateTeslaMobileDashboardAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_tesla_mobile_${exportId}_${Date.now()}.ass`);

  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated Tesla Mobile dashboard subtitle: ${tempPath}`);

  return tempPath;
}

// ============================================
// TESLA MOBILE — Advanced Editor split writers
//
// In AE mode each section (date bar / data bar) is a freely-placed tile,
// so we emit them as two separate ASS files (each with its own customPosition).
// The legacy writeTeslaMobileDashboardAss stays untouched for the simple-modal
// (non-AE) path, which uses FFmpeg padding to stack date+data.
//
// Each writer below renders ONLY its own section — no shared
// `dashBarTop = isTop ? dateHeight : dateHeight + videoH` arithmetic because
// the user's tile geometry already encodes the absolute Y in the padded canvas.
// ============================================

/**
 * Generate ONLY the date-bar dialogue (Tesla Mobile AE mode).
 * Centered "Day, Month D, YYYY  H:MM AM/PM" with a thin separator below.
 * `options.customPosition = { x, y, w, h }` defines the tile.
 */
function generateTeslaMobileDateEvents(seiData, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    segments = [],
    cumStarts = [],
    timeFormat = '12h',
    customPosition,
    dateValueScale = 1,
  } = options;

  if (!customPosition) return '';

  const dateX = Math.round(customPosition.x);
  const dateY = Math.round(customPosition.y);
  const dateW = Math.max(80, Math.round(customPosition.w));
  const dateH = Math.max(12, Math.round(customPosition.h));
  const centerX = dateX + dateW / 2;
  const centerY = dateY + dateH / 2;
  // Match the ASS legacy size scaling (dateHeight * 0.55) then apply user scale.
  const dateFontSize = Math.max(10, Math.round(dateH * 0.55 * (dateValueScale || 1)));

  const durationMs = endTimeMs - startTimeMs;
  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const frameTimeMs = 1000 / FPS;

  const events = [];
  let prevTimeSec = null;
  let eventStartFrame = 0;

  for (let frame = 0; frame <= totalFrames; frame++) {
    const currentTimeMs = startTimeMs + (frame * frameTimeMs);
    const actualTs = convertVideoTimeToTimestamp(currentTimeMs, segments, cumStarts);
    // Date bar updates once per second (minute precision is enough but
    // matches the legacy keyframing).
    const timeSec = Math.floor(actualTs / 1000);

    if (timeSec !== prevTimeSec || frame === totalFrames) {
      if (prevTimeSec !== null && eventStartFrame < frame) {
        const startAssTime = formatAssTime(eventStartFrame * frameTimeMs);
        const endAssTime = formatAssTime(frame * frameTimeMs);
        const eventStartTimeMs = startTimeMs + (eventStartFrame * frameTimeMs);
        const actualTimestampMs = convertVideoTimeToTimestamp(eventStartTimeMs, segments, cumStarts);

        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'];
        const dateObj = actualTimestampMs ? new Date(actualTimestampMs) : new Date();
        const dayName = dayNames[dateObj.getDay()];
        const monthName = monthNames[dateObj.getMonth()];
        const dayNum = dateObj.getDate();
        const year = dateObj.getFullYear();
        const timeStr = formatDisplayTime(actualTimestampMs, timeFormat);
        const dateTimeStr = `${dayName}, ${monthName} ${dayNum}, ${year}   ${timeStr}`;

        // Solid panel background (matches the #1A1A1A pad color used in
        // legacy non-AE mode). Layer 0 so the text sits above it.
        events.push(dialogueLine(0, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H1A1A1A&\\1a&H00&\\p1}` +
          `m ${dateX} ${dateY} l ${dateX + dateW} ${dateY} l ${dateX + dateW} ${dateY + dateH} l ${dateX} ${dateY + dateH}{\\p0}`
        ));

        // Centered date/time text
        events.push(dialogueLine(2, startAssTime, endAssTime, 'CompactDash',
          `{\\an5\\pos(${Math.round(centerX)},${Math.round(centerY)})\\fs${dateFontSize}\\bord0\\shad0\\1c&HFFFFFF&\\1a&H00&}${dateTimeStr}`
        ));

        // Thin separator along the bottom edge
        const sepY = dateY + dateH - 1;
        events.push(dialogueLine(1, startAssTime, endAssTime, 'CompactDash',
          `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H333333&\\1a&H00&\\p1}` +
          `m ${dateX} ${sepY} l ${dateX + dateW} ${sepY} l ${dateX + dateW} ${sepY + 1} l ${dateX} ${sepY + 1}{\\p0}`
        ));
      }
      prevTimeSec = timeSec;
      eventStartFrame = frame;
    }
  }

  return events.join('\n');
}

function generateTeslaMobileDateAss(seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080, customPosition } = options;
  const dateH = customPosition ? Math.max(12, Math.round(customPosition.h)) : 60;
  // Font size in the V4+ Style table is a fallback; per-event \fs overrides it.
  const fontSize = Math.max(10, Math.round(dateH * 0.55));
  const header = generateTeslaMobileAssHeader(playResX, playResY, fontSize);
  const events = generateTeslaMobileDateEvents(seiData, startTimeMs, endTimeMs, options);
  return header + events;
}

async function writeTeslaMobileDateAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateTeslaMobileDateAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_tesla_mobile_date_${exportId}_${Date.now()}.ass`);
  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated Tesla Mobile date-bar subtitle: ${tempPath}`);
  return tempPath;
}

/**
 * Generate ONLY the dashboard-data dialogue (Tesla Mobile AE mode).
 * Reuses generateTeslaMobileDashboardEvents — it already honors customPosition
 * by forcing dateHeight = 0 and emitting only the dashboard bar at the tile's
 * absolute position. So writeTeslaMobileDataAss is essentially a thin wrapper
 * around the existing event generator, just with a more specific filename.
 *
 * (We keep this as its own export so the AE dispatch logic in main.js is
 * symmetric with writeTeslaMobileDateAss.)
 */
async function writeTeslaMobileDataAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080, customPosition } = options;
  if (!customPosition) {
    throw new Error('writeTeslaMobileDataAss requires options.customPosition');
  }
  const dashHeight = Math.max(20, Math.round(customPosition.h));
  const circleR = Math.round(dashHeight * 0.38);
  const fontSize = Math.round(circleR * 0.7);
  const header = generateTeslaMobileAssHeader(playResX, playResY, fontSize);
  const events = generateTeslaMobileDashboardEvents(seiData, startTimeMs, endTimeMs, options);
  const assContent = header + events;

  const tempPath = path.join(os.tmpdir(), `dashboard_tesla_mobile_data_${exportId}_${Date.now()}.ass`);
  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated Tesla Mobile data-bar subtitle: ${tempPath}`);
  return tempPath;
}

// ============================================
// TESLA SCREEN DASH
// In-car Tesla driving display look:
//   Top-left HUD: PRND row, big speed number, MPH/KPH unit, "Self-Driving"/"Manual"
//                 label, and a vertical regen/accel bar to the left of the speed.
//   Top-center:   wall-clock readout (matches the clip's actual time-of-day).
// Overlays the existing video frame; canvas is NOT padded. Designed to coexist
// with the existing minimap pipeline so the user sees a "Tesla Dash" full HUD.
// ============================================

const SCREEN_DASH_REF_W = 1920;
const SCREEN_DASH_REF_H = 1080;

function generateTeslaScreenDashAssHeader(playResX, playResY) {
  return `[Script Info]
Title: Tesla Screen Dash
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ScreenDash,Arial,40,${COLORS.white},${COLORS.white},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function generateTeslaScreenDashEvents(seiData, startTimeMs, endTimeMs, options) {
  const {
    playResX = 1920,
    playResY = 1080,
    useMetric = false,
    segments = [],
    cumStarts = [],
    language = 'en',
    timeFormat = '12h',
    customPosition = null
  } = options;

  // Advanced Editor: HUD is scaled + offset to the user's canvas tile.
  let scale, offsetX, offsetY;
  if (customPosition) {
    scale = Math.max(0.1, Math.min(customPosition.w / SCREEN_DASH_REF_W, customPosition.h / SCREEN_DASH_REF_H));
    offsetX = Math.round(customPosition.x);
    offsetY = Math.round(customPosition.y);
  } else {
    scale = Math.min(playResX / SCREEN_DASH_REF_W, playResY / SCREEN_DASH_REF_H);
    offsetX = 0;
    offsetY = 0;
  }
  // sx/sy: absolute positions (include offset). sd: scaled distance (no offset).
  const sx = v => offsetX + Math.round(v * scale);
  const sy = v => offsetY + Math.round(v * scale);
  const sd = v => Math.round(v * scale);
  const sf = v => Math.max(8, Math.round(v * scale));

  const durationMs = endTimeMs - startTimeMs;
  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const frameTimeMs = 1000 / FPS;

  // EMA smoothing for the regen/accel bar (~250 ms time constant).
  // A faster time constant lets autopilot's micro-throttle pulses leak through
  // visually as flickers — 250 ms is slow enough to read as "real" power but
  // still responsive enough to follow brake/regen transitions.
  let smoothedY = 0;
  const yFactor = 1 - Math.exp(-4 * (frameTimeMs / 1000));

  const events = [];
  let prevState = null;
  let eventStartFrame = 0;

  // Pre-compute fixed pixel positions once.
  const hudX = sx(40);
  const prndY = sy(60);
  const prndFs = sf(48);
  const prndGap = sd(48);
  const speedY = sy(110);
  const speedFs = sf(180);
  const unitY = sy(310);
  const unitFs = sf(48);
  const apY = sy(370);
  const apFs = sf(44);

  const barX = sx(18);
  const barW = sd(10);
  const barTop = sy(140);
  const barBottom = sy(330);
  const barHeight = barBottom - barTop;
  const barCenterY = Math.round((barTop + barBottom) / 2);

  const clockY = sy(40);
  const clockFs = sf(44);
  const clockX = customPosition
    ? Math.round(offsetX + customPosition.w / 2)
    : Math.round(playResX / 2);

  for (let frame = 0; frame <= totalFrames; frame++) {
    const currentTimeMs = startTimeMs + (frame * frameTimeMs);
    const sei = findSeiAtTime(seiData, currentTimeMs);

    // --- Telemetry ---
    const mps = Math.abs(getSeiValue(sei, 'vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedUnit = getSpeedUnit(useMetric, language);

    const gear = getSeiValue(sei, 'gearState', 'gear_state');
    const gearLetter = gear === 1 ? 'D' : gear === 2 ? 'R' : gear === 0 ? 'P' : gear === 3 ? 'N' : '--';

    const apState = getSeiValue(sei, 'autopilotState', 'autopilot_state');
    const apActive = apState === 1 || apState === 2;
    const apText = getApText(apState, language);

    const brakeActive = !!getSeiValue(sei, 'brakeApplied', 'brake_applied');
    const rawAccelPos = getSeiValue(sei, 'acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPedalFrac = rawAccelPos > 1 ? Math.min(1, rawAccelPos / 100) : Math.max(0, Math.min(1, rawAccelPos));
    const pedalActive = accelPedalFrac > 0.05;

    // Regen/accel bar driver. Empirically (Tesla SEI) `linear_acceleration_mps2_y`
    // is POSITIVE during deceleration — sign-flipped so positive bar = accel,
    // negative bar = regen, matching driver intuition.
    const rawY = getSeiValue(sei, 'linearAccelerationMps2Y', 'linear_acceleration_mps2_y');
    const lin_y_raw = Number.isFinite(rawY) ? rawY : 0;
    const lin_y = -lin_y_raw;
    smoothedY += (lin_y - smoothedY) * yFactor;
    const clipped = Math.max(-4, Math.min(4, smoothedY));
    // ±0.3 m/s² deadzone so coast/cruise reads as zero rather than wobbling.
    const dz = Math.abs(clipped) < 0.3 ? 0 : clipped;
    const signedFrac = dz / 4;

    // Clock — second-resolution wall-clock from segment timestamps.
    const actualTs = convertVideoTimeToTimestamp(currentTimeMs, segments, cumStarts);
    const timeSec = Math.floor(actualTs / 1000);

    // Bar fill direction is gated by pedals first (ground truth), then
    // falls back to longitudinal accel for regen detection during coast.
    let barMode;          // 'accel' | 'brake' | 'regen' | 'idle'
    let barMagnitude = 0; // 0..1
    if (brakeActive) {
      barMode = 'brake';
      barMagnitude = Math.max(Math.abs(signedFrac), 0.35);
    } else if (pedalActive) {
      barMode = 'accel';
      barMagnitude = accelPedalFrac;
    } else if (signedFrac < -0.05) {
      barMode = 'regen';
      barMagnitude = Math.min(1, Math.abs(signedFrac));
    } else if (signedFrac > 0.05) {
      barMode = 'accel';
      barMagnitude = Math.min(1, signedFrac);
    } else {
      barMode = 'idle';
    }
    const barMagRounded = Math.round(barMagnitude * 20) / 20;

    const currentState = JSON.stringify({
      speed,
      gearLetter,
      apActive,
      apText,
      barMode,
      barMag: barMagRounded,
      timeSec
    });

    if (currentState !== prevState || frame === totalFrames) {
      if (prevState !== null && eventStartFrame < frame) {
        const startAssTime = formatAssTime((eventStartFrame * frameTimeMs));
        const endAssTime = formatAssTime((frame * frameTimeMs));
        const prev = JSON.parse(prevState);

        // === HUD column (top-left) ===

        // PRND row at top of column. Active gear is bold blue, inactive is dim gray.
        const activeIdx = prev.gearLetter === 'P' ? 0
          : prev.gearLetter === 'R' ? 1
          : prev.gearLetter === 'N' ? 2
          : prev.gearLetter === 'D' ? 3 : -1;
        const prndChars = ['P', 'R', 'N', 'D'];
        for (let i = 0; i < prndChars.length; i++) {
          const cx = hudX + i * prndGap;
          const isActive = i === activeIdx;
          const color = isActive ? '&HFF4800&' : '&HFFFFFF&';
          const bold = isActive ? '\\b1' : '';
          events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
            `{\\an7\\pos(${cx},${prndY})\\bord0\\shad0\\fs${prndFs}\\1c${color}${bold}}${prndChars[i]}`
          ));
        }

        // Speed number — large bold white.
        events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
          `{\\an7\\pos(${hudX},${speedY})\\bord0\\shad0\\fs${speedFs}\\b1\\1c&HFFFFFF&}${prev.speed}`
        ));

        // Speed unit (MPH/KPH).
        events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
          `{\\an7\\pos(${hudX},${unitY})\\bord0\\shad0\\fs${unitFs}\\1c&HFFFFFF&}${speedUnit}`
        ));

        // Autopilot label — blue when Self-Driving/Autosteer, gray otherwise.
        const apColor = prev.apActive ? '&HFF4800&' : '&H808080&';
        events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
          `{\\an7\\pos(${hudX},${apY})\\bord0\\shad0\\fs${apFs}\\1c${apColor}}${prev.apText}`
        ));

        // Regen/accel bar — gray background pill always present.
        events.push(dialogueLine(1, startAssTime, endAssTime, 'ScreenDash',
          `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H404040&\\1a&H40&\\p1}` +
          `m ${barX} ${barTop} l ${barX + barW} ${barTop} l ${barX + barW} ${barBottom} l ${barX} ${barBottom}{\\p0}`
        ));

        if (prev.barMode === 'accel' && prev.barMag > 0) {
          // Gas pedal or positive longitudinal accel: blue fill from center upward.
          const fillTop = Math.round(barCenterY - (barHeight / 2) * prev.barMag);
          events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFF4800&\\p1}` +
            `m ${barX} ${fillTop} l ${barX + barW} ${fillTop} l ${barX + barW} ${barCenterY} l ${barX} ${barCenterY}{\\p0}`
          ));
        } else if (prev.barMode === 'regen' && prev.barMag > 0) {
          // Coasting deceleration: green fill from center downward.
          const fillBottom = Math.round(barCenterY + (barHeight / 2) * prev.barMag);
          events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H22C55E&\\p1}` +
            `m ${barX} ${barCenterY} l ${barX + barW} ${barCenterY} l ${barX + barW} ${fillBottom} l ${barX} ${fillBottom}{\\p0}`
          ));
        } else if (prev.barMode === 'brake' && prev.barMag > 0) {
          // Brake pedal: red fill from center downward (with floor for visibility).
          const fillBottom = Math.round(barCenterY + (barHeight / 2) * prev.barMag);
          events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
            `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H0000FF&\\p1}` +
            `m ${barX} ${barCenterY} l ${barX + barW} ${barCenterY} l ${barX + barW} ${fillBottom} l ${barX} ${fillBottom}{\\p0}`
          ));
        }

        // === Clock (top-center) ===
        // Centered above the canvas so it never collides with the minimap tile,
        // which the auto-config pins to top-right. Outline keeps it legible on
        // both bright sky and dark road backgrounds.
        const eventStartTimeMs = startTimeMs + (eventStartFrame * frameTimeMs);
        const evStartTs = convertVideoTimeToTimestamp(eventStartTimeMs, segments, cumStarts);
        const clockStr = formatDisplayTime(evStartTs, timeFormat);
        events.push(dialogueLine(2, startAssTime, endAssTime, 'ScreenDash',
          `{\\an8\\pos(${clockX},${clockY})\\bord2\\shad0\\3c&H000000&\\fs${clockFs}\\b1\\1c&HFFFFFF&}${clockStr}`
        ));
      }

      prevState = currentState;
      eventStartFrame = frame;
    }
  }

  return events.join('\n');
}

function generateTeslaScreenDashAss(seiData, startTimeMs, endTimeMs, options) {
  const { playResX = 1920, playResY = 1080 } = options;
  const header = generateTeslaScreenDashAssHeader(playResX, playResY);
  const events = generateTeslaScreenDashEvents(seiData, startTimeMs, endTimeMs, options);
  return header + events;
}

async function writeTeslaScreenDashAss(exportId, seiData, startTimeMs, endTimeMs, options) {
  const assContent = generateTeslaScreenDashAss(seiData, startTimeMs, endTimeMs, options);
  const tempPath = path.join(os.tmpdir(), `dashboard_tesla_screen_${exportId}_${Date.now()}.ass`);

  await fs.promises.writeFile(tempPath, assContent, 'utf8');
  console.log(`[ASS] Generated Tesla Screen Dash subtitle: ${tempPath}`);

  return tempPath;
}

module.exports = {
  findSeiAtTime,
  writeCompactDashboardAss,
  writeDefaultDashboardAss,
  writeDetailedDashboardAss,
  writeTeslaMobileDashboardAss,
  writeTeslaMobileDateAss,
  writeTeslaMobileDataAss,
  writeTeslaScreenDashAss,
  writeMinimapAss
};

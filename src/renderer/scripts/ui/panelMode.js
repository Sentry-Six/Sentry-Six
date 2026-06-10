import { CLIPS_MODE_KEY } from '../lib/storageKeys.js';
import { t } from '../lib/i18n.js';

const DEFAULT_SIDEBAR_WIDTH = 360;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 600;

// In-memory cache for layout style (loaded async from settings.json)
let cachedLayoutStyle = 'modern';
let cachedSidebarWidth = DEFAULT_SIDEBAR_WIDTH;

// Clips panel mode (floating/collapsed or docked/hidden based on layout style)
export function createClipsPanelMode({ map, clipsCollapseBtn } = {}) {
  
  // Get the current layout style from cache
  function getLayoutStyle() {
    return cachedLayoutStyle;
  }

  // Get the current sidebar width
  function getSidebarWidth() {
    return cachedSidebarWidth;
  }

  // Apply sidebar width to CSS variable
  function applySidebarWidth(width) {
    document.documentElement.style.setProperty('--clips-dock-width', `${width}px`);
  }

  function applyClipsMode(mode) {
    const layoutStyle = getLayoutStyle();
    let m;
    
    if (layoutStyle === 'classic') {
      // Classic layout: docked sidebar or hidden
      m = (mode === 'hidden' || mode === 'collapsed') ? 'hidden' : 'docked';
    } else {
      // Modern layout: floating or collapsed
      m = (mode === 'collapsed' || mode === 'hidden') ? 'collapsed' : 'floating';
    }
    
    document.body.classList.remove('clips-mode-floating', 'clips-mode-docked', 'clips-mode-collapsed', 'clips-mode-hidden');
    document.body.classList.add(`clips-mode-${m}`);
    localStorage.setItem(CLIPS_MODE_KEY, m);

    if (clipsCollapseBtn) {
      const isCollapsed = (m === 'collapsed' || m === 'hidden');
      if (layoutStyle === 'classic') {
        const titleText = isCollapsed ? t('ui.clipBrowser.showSidebar') : t('ui.clipBrowser.hideSidebar');
        clipsCollapseBtn.title = titleText;
        clipsCollapseBtn.setAttribute('aria-label', titleText);
      } else {
        const titleText = isCollapsed ? t('ui.clipBrowser.expandPanel') : t('ui.clipBrowser.collapsePanel');
        clipsCollapseBtn.title = titleText;
        clipsCollapseBtn.setAttribute('aria-label', titleText);
      }
    }

    // Leaflet sometimes needs a nudge when UI moves around.
    if (map) setTimeout(() => { try { map.invalidateSize(); } catch { } }, 150);
  }

  async function initClipsPanelMode() {
    // Load settings from settings.json
    if (window.electronAPI?.getSetting) {
      const savedStyle = await window.electronAPI.getSetting('layoutStyle');
      cachedLayoutStyle = savedStyle || 'modern';
      
      const savedWidth = await window.electronAPI.getSetting('sidebarWidth');
      cachedSidebarWidth = savedWidth || DEFAULT_SIDEBAR_WIDTH;
      applySidebarWidth(cachedSidebarWidth);
    }
    
    const layoutStyle = getLayoutStyle();
    const saved = localStorage.getItem(CLIPS_MODE_KEY);
    
    if (layoutStyle === 'classic') {
      applyClipsMode(saved === 'hidden' ? 'hidden' : 'docked');
      initResizeHandle();
    } else {
      applyClipsMode(saved === 'collapsed' ? 'collapsed' : 'floating');
    }
  }

  function toggleCollapsedMode() {
    const layoutStyle = getLayoutStyle();
    const current = localStorage.getItem(CLIPS_MODE_KEY);
    
    if (layoutStyle === 'classic') {
      if (current === 'hidden') {
        applyClipsMode('docked');
        // Ensure resize handle exists when showing sidebar
        initResizeHandle();
      } else {
        applyClipsMode('hidden');
      }
    } else {
      if (current === 'collapsed') {
        applyClipsMode('floating');
      } else {
        applyClipsMode('collapsed');
      }
    }
  }

  async function setLayoutStyle(style) {
    cachedLayoutStyle = style;
    // Save to settings.json
    if (window.electronAPI?.setSetting) {
      await window.electronAPI.setSetting('layoutStyle', style);
    }
    // Re-apply mode with new layout style
    const saved = localStorage.getItem(CLIPS_MODE_KEY);
    if (style === 'classic') {
      applyClipsMode(saved === 'hidden' ? 'hidden' : 'docked');
      initResizeHandle();
    } else {
      applyClipsMode(saved === 'collapsed' ? 'collapsed' : 'floating');
    }
  }

  async function setSidebarWidth(width) {
    const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    cachedSidebarWidth = clampedWidth;
    applySidebarWidth(clampedWidth);
    // Save to settings.json
    if (window.electronAPI?.setSetting) {
      await window.electronAPI.setSetting('sidebarWidth', clampedWidth);
    }
    // Nudge map
    if (map) setTimeout(() => { try { map.invalidateSize(); } catch { } }, 50);
  }

  // Document-level handlers from the most recent initResizeHandle() call.
  // initResizeHandle re-runs on every layout-style switch / sidebar toggle;
  // the old handle element dies with remove(), but document listeners would
  // accumulate for the session unless the previous pair is removed first.
  let resizeMoveHandler = null;
  let resizeUpHandler = null;

  // Initialize the resize handle for classic sidebar
  function initResizeHandle() {
    const clipBrowser = document.querySelector('.clip-browser');
    if (!clipBrowser) return;

    // Remove existing handle if any
    const existingHandle = clipBrowser.querySelector('.sidebar-resize-handle');
    if (existingHandle) existingHandle.remove();
    if (resizeMoveHandler) document.removeEventListener('mousemove', resizeMoveHandler);
    if (resizeUpHandler) document.removeEventListener('mouseup', resizeUpHandler);

    // Create resize handle
    const handle = document.createElement('div');
    handle.className = 'sidebar-resize-handle';
    clipBrowser.appendChild(handle);

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mousedown', (e) => {
      if (getLayoutStyle() !== 'classic') return;
      isResizing = true;
      startX = e.clientX;
      startWidth = cachedSidebarWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    // Apply at most one width per animation frame. mousemove fires faster
    // than the display refreshes (125Hz+ mice), and every --clips-dock-width
    // write relayouts the whole sidebar AND the video grid — unthrottled
    // drags do that several times per frame and visibly drop frames.
    let pendingWidth = null;
    let resizeRaf = 0;
    resizeMoveHandler = (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      pendingWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta));
      if (!resizeRaf) {
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (isResizing && pendingWidth !== null) applySidebarWidth(pendingWidth);
        });
      }
    };
    document.addEventListener('mousemove', resizeMoveHandler);

    resizeUpHandler = () => {
      if (!isResizing) return;
      isResizing = false;
      if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
      if (pendingWidth !== null) { applySidebarWidth(pendingWidth); pendingWidth = null; }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save the final width
      const computedWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--clips-dock-width'));
      if (!isNaN(computedWidth)) {
        setSidebarWidth(computedWidth);
      }
    };
    document.addEventListener('mouseup', resizeUpHandler);
  }

  return { 
    initClipsPanelMode, 
    applyClipsMode, 
    toggleCollapsedMode, 
    setLayoutStyle, 
    getLayoutStyle,
    setSidebarWidth,
    getSidebarWidth
  };
}

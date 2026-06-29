const { contextBridge, ipcRenderer } = require('electron');

// Map to track wrapper functions for proper listener removal
// Key: original callback, Value: wrapper function registered with ipcRenderer
const listenerWrappers = new Map();

contextBridge.exposeInMainWorld('electronAPI', {
  // Folder/file operations
  openFolder: (startPath) => ipcRenderer.invoke('dialog:openFolder', startPath),
  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  
  // File system operations
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  loadSentryUsbDrives: (filePath) => ipcRenderer.invoke('sentryUsb:loadAndGroup', filePath),
  getSentryUsbDriveDetail: (driveId) => ipcRenderer.invoke('sentryUsb:getDriveDetail', driveId),
  reverseGeocode: (coords) => ipcRenderer.invoke('geo:reverseGeocode', coords),
  exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('fs:showItemInFolder', filePath),
  deleteFolder: (folderPath) => ipcRenderer.invoke('fs:deleteFolder', folderPath),
  deleteFolderWithReload: (folderPath, baseFolderPath) => ipcRenderer.invoke('fs:deleteFolderWithReload', folderPath, baseFolderPath),
  checkPendingDelete: () => ipcRenderer.invoke('fs:checkPendingDelete'),
  
  // Export operations
  saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  startExport: (exportId, exportData) => ipcRenderer.invoke('export:start', exportId, exportData),
  cancelExport: (exportId) => ipcRenderer.invoke('export:cancel', exportId),
  checkFFmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
  
  // Clip sharing
  getShareConfig: () => ipcRenderer.invoke('share:getConfig'),
  reserveShareCode: (expirationHours) => ipcRenderer.invoke('share:reserve', expirationHours),
  uploadShareClip: (filePath, options) => ipcRenderer.invoke('share:upload', filePath, options),
  getSharedClips: () => ipcRenderer.invoke('share:getClips'),
  syncSharedClips: () => ipcRenderer.invoke('share:syncClips'),
  deleteSharedClip: (code, deleteToken) => ipcRenderer.invoke('share:deleteClip', code, deleteToken),
  
  // Update operations (using electron-updater)
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  installAndRestart: () => ipcRenderer.invoke('update:installAndRestart'),
  skipUpdate: () => ipcRenderer.invoke('update:skip'),
  exitApp: () => ipcRenderer.invoke('update:exit'),
  getChangelog: () => ipcRenderer.invoke('update:getChangelog'),
  
  // Developer settings operations
  devOpenDevTools: () => ipcRenderer.invoke('dev:openDevTools'),
  devResetSettings: () => ipcRenderer.invoke('dev:resetSettings'),
  devForceLatestVersion: () => ipcRenderer.invoke('dev:forceLatestVersion'),
  devSetOldVersion: () => ipcRenderer.invoke('dev:setOldVersion'),
  devGetCurrentVersion: () => ipcRenderer.invoke('dev:getCurrentVersion'),
  devGetAppPaths: () => ipcRenderer.invoke('dev:getAppPaths'),
  devReloadApp: () => ipcRenderer.invoke('dev:reloadApp'),
  // Pre-release testing: fetches the latest GitHub pre-release metadata
  // and installs it via electron-updater, bypassing the normal update-API
  // gate. Dev-tools only — see the warning in the Developer modal.
  devCheckPrerelease: () => ipcRenderer.invoke('dev:checkPrerelease'),
  devInstallPrerelease: (tag) => ipcRenderer.invoke('dev:installPrerelease', tag),
  
  // Settings storage (file-based for reliability)
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  // Relaunch the app (used by settings that only take effect at startup)
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  // Map tiles: renderer detected Google tile failure — main process flips
  // export tile downloads to the OSM fallback for the rest of the session
  notifyMapProviderFallback: () => ipcRenderer.send('map:provider-fallback'),
  
  // Build environment
  isMas: process.mas === true,

  // System info (for Settings "Learn More")
  getSystemInfo: () => ipcRenderer.invoke('system:getInfo'),
  
  // Diagnostics
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  
  // Support Chat
  createSupportTicket: (data) => ipcRenderer.invoke('support:createTicket', data),
  sendSupportMessage: (data) => ipcRenderer.invoke('support:sendMessage', data),
  uploadSupportMedia: (data) => ipcRenderer.invoke('support:uploadMedia', data),
  fetchSupportMessages: (data) => ipcRenderer.invoke('support:fetchMessages', data),
  closeSupportTicket: (data) => ipcRenderer.invoke('support:closeTicket', data),
  markSupportRead: (data) => ipcRenderer.invoke('support:markRead', data),
  
  // Event listeners
  on: (channel, callback) => {
    const allowedChannels = ['export:progress', 'share:progress', 'update:available', 'update:progress', 'update:downloaded', 'update:forceManual'];
    if (allowedChannels.includes(channel)) {
      const wrapper = (event, ...args) => callback(...args);
      listenerWrappers.set(callback, wrapper);
      ipcRenderer.on(channel, wrapper);
    }
  },
  
  off: (channel, callback) => {
    const wrapper = listenerWrappers.get(callback);
    if (wrapper) {
      ipcRenderer.removeListener(channel, wrapper);
      listenerWrappers.delete(callback);
    }
  },
  
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

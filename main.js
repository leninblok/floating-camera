const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

let mainWindow;

function createWindow(initialSize = 250) {
  mainWindow = new BrowserWindow({
    width: initialSize,
    height: initialSize,
    frame: false,
    transparent: true,
    resizable: true, // allow manual resize; slider will also control it
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      backgroundThrottling: false,
    },
  });

  // Stay above everything. On macOS use a higher level.
  try {
    // On macOS, set a high window level so it floats over fullscreen apps too.
    mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu');
    // Visible on all spaces for macOS
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  } catch (_) {}

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Avoid dark overlay effects on transparent windows
  try { nativeTheme.themeSource = 'light'; } catch (_) {}
  createWindow(250);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(250);
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, typical behavior is to keep app alive until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers
ipcMain.handle('app:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('app:setSize', (_event, width, height) => {
  if (!mainWindow) return;
  const clampedW = Math.max(100, Math.min(Number(width) || 200, 800));
  const clampedH = Math.max(100, Math.min(Number(height) || 200, 800));
  mainWindow.setSize(clampedW, clampedH);
});

ipcMain.handle('app:getBounds', () => {
  if (!mainWindow) return null;
  return mainWindow.getBounds();
});

ipcMain.handle('app:setBounds', (_event, bounds) => {
  if (!mainWindow || !bounds) return;
  const { x, y, width, height } = bounds;
  if (typeof width === 'number' && typeof height === 'number') {
    mainWindow.setSize(Math.max(100, width), Math.max(100, height));
  }
  if (typeof x === 'number' && typeof y === 'number') {
    mainWindow.setPosition(Math.floor(x), Math.floor(y));
  }
});

ipcMain.handle('app:centerWindow', (_event, size) => {
  if (!mainWindow) return;
  const target = Number(size) || 1000;
  mainWindow.setSize(target, target);
  mainWindow.center();
});

ipcMain.handle('app:setResizable', (_event, resizable) => {
  if (!mainWindow) return;
  try { mainWindow.setResizable(Boolean(resizable)); } catch (_) {}
});

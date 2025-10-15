const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;
let borderEnabled = true;
let mirrorEnabled = false;
function clampToPrimary(bounds) {
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  const marginX = 24;
  const marginY = 48;
  const insetX = wa.x + marginX;
  const insetY = wa.y + marginY;
  const insetW = Math.max(0, wa.width - marginX * 2);
  const insetH = Math.max(0, wa.height - marginY * 2);
  const width = Math.min(Math.max(100, Math.round(bounds.width || 0)), insetW || Math.max(100, Math.round(bounds.width || 0)));
  const height = Math.min(Math.max(100, Math.round(bounds.height || 0)), insetH || Math.max(100, Math.round(bounds.height || 0)));
  let x = Math.round(typeof bounds.x === 'number' ? bounds.x : insetX);
  let y = Math.round(typeof bounds.y === 'number' ? bounds.y : insetY);
  if (x < insetX) x = insetX;
  if (y < insetY) y = insetY;
  if (x + width > insetX + insetW) x = insetX + insetW - width;
  if (y + height > insetY + insetH) y = insetY + insetH - height;
  return { x, y, width, height };
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadLastState() {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw || '{}');
    const size = Math.max(100, Math.min(Number(data.lastSize) || 0, 2000));
    const x = typeof data.lastX === 'number' ? Math.floor(data.lastX) : null;
    const y = typeof data.lastY === 'number' ? Math.floor(data.lastY) : null;
    if (typeof data.borderEnabled === 'boolean') borderEnabled = data.borderEnabled;
    if (typeof data.mirrorEnabled === 'boolean') mirrorEnabled = data.mirrorEnabled;
    if (!size || x === null || y === null) return null;
    return { x, y, size };
  } catch (_) {
    return null;
  }
}

function saveLastState(bounds) {
  try {
    const p = getSettingsPath();
    const side = Math.max(100, Math.min(Math.min(bounds.width, bounds.height) || 0, 2000));
    const payload = { lastSize: side, lastX: bounds.x, lastY: bounds.y, borderEnabled: !!borderEnabled, mirrorEnabled: !!mirrorEnabled };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  } catch (_) {}
}

function createWindow(initialSize = 250) {
  mainWindow = new BrowserWindow({
    width: initialSize,
    height: initialSize,
    frame: false,
    transparent: true,
    resizable: false,
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

  try {
    mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu');
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  } catch (_) {}

  try { mainWindow.setAspectRatio(1); } catch (_) {}

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    const state = loadLastState();
    let clamped;
    if (state) {
      clamped = clampToPrimary({ x: state.x, y: state.y, width: state.size, height: state.size });
    } else {
      const primary = screen.getPrimaryDisplay();
      const wa = primary.workArea;
      const size = Math.max(100, initialSize);
      const x = Math.round(wa.x + wa.width - size);
      const y = Math.round(wa.y);
      clamped = clampToPrimary({ x, y, width: size, height: size });
    }
    try { mainWindow.setBounds(clamped, false); } catch (_) {}
    mainWindow.show();
  });

  mainWindow.on('close', () => {
    try {
      const b = mainWindow.getBounds();
      saveLastState(b);
    } catch (_) {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('move', () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    const clamped = clampToPrimary(b);
    if (b.x !== clamped.x || b.y !== clamped.y) {
      try { mainWindow.setBounds({ x: clamped.x, y: clamped.y, width: b.width, height: b.height }, false); } catch (_) {}
    }
  });

  mainWindow.on('will-resize', (event, newBounds) => {
    if (!mainWindow) return;
    event.preventDefault();
    const side = Math.max(100, Math.min(newBounds.width, newBounds.height));
    const current = mainWindow.getBounds();
    const target = clampToPrimary({ x: current.x, y: current.y, width: side, height: side });
    try { mainWindow.setBounds(target, false); } catch (_) {}
  });

  const handleDisplayChange = () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    const side = Math.max(100, Math.min(b.width, b.height));
    const clamped = clampToPrimary({ x: b.x, y: b.y, width: side, height: side });
    try { mainWindow.setBounds(clamped, false); } catch (_) {}
  };
  screen.on('display-metrics-changed', handleDisplayChange);
  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
}

app.whenReady().then(() => {
  try { nativeTheme.themeSource = 'light'; } catch (_) {}
  const state = loadLastState();
  createWindow((state && state.size) || 250);

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
ipcMain.handle('app:getBounds', () => {
  if (!mainWindow) return null;
  return mainWindow.getBounds();
});

ipcMain.handle('app:setBounds', (_event, bounds) => {
  if (!mainWindow || !bounds) return;
  // Enforce square size and clamp to primary display, then set via setBounds
  const side = Math.max(100, Math.min(Number(bounds.width) || 0, Number(bounds.height) || 0) || Math.max(bounds.width || 0, bounds.height || 0));
  const target = clampToPrimary({
    x: typeof bounds.x === 'number' ? Math.floor(bounds.x) : undefined,
    y: typeof bounds.y === 'number' ? Math.floor(bounds.y) : undefined,
    width: side || mainWindow.getBounds().width,
    height: side || mainWindow.getBounds().height,
  });
  try { mainWindow.setBounds(target, false); } catch (_) {}
});

ipcMain.handle('app:setResizable', (_event, resizable) => {
  if (!mainWindow) return;
  try { mainWindow.setResizable(false); } catch (_) {}
});

// Return target centered bounds for a given square size without moving the window
ipcMain.handle('app:getCenteredBounds', (_event, size) => {
  if (!mainWindow) return null;
  const s = Math.max(100, Number(size) || 750);
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  const x = Math.round(wa.x + (wa.width - s) / 2);
  const y = Math.round(wa.y + (wa.height - s) / 2);
  return clampToPrimary({ x, y, width: s, height: s });
});

ipcMain.handle('app:getBorderEnabled', () => {
  return !!borderEnabled;
});

ipcMain.handle('app:setBorderEnabled', (_event, enabled) => {
  borderEnabled = !!enabled;
  try {
    if (mainWindow) {
      const b = mainWindow.getBounds();
      saveLastState(b);
    }
  } catch (_) {}
});

ipcMain.handle('app:getMirrorEnabled', () => {
  return !!mirrorEnabled;
});

ipcMain.handle('app:setMirrorEnabled', (_event, enabled) => {
  mirrorEnabled = !!enabled;
  try {
    if (mainWindow) {
      const b = mainWindow.getBounds();
      saveLastState(b);
    }
  } catch (_) {}
});

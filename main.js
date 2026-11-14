const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
} = require('electron');
const fs = require('fs');
const path = require('path');

const MIN_SIZE = 100;
const MAX_SIZE = 2000;
// The shadow extends down by blur radius plus Y offset. Leave extra transparent
// room on every side so the native window never clips its soft edge.
const SHADOW_INSET = 44;
const CIRCLE_EDGE_MARGINS = { x: 24, y: 48 };
const RECTANGLE_EDGE_MARGINS = { x: 24, y: 16 };
const PROGRAMMATIC_LAYOUT_TOLERANCE = 16;
const OVERLAY_REASSERT_DELAY_MS = 350;
const EDGE_ANCHOR_TOLERANCE = 36;
// The value is the long side in pixels. Each set maps the same visual labels
// to a different footprint, rather than reusing square-window dimensions.
const SIZE_PRESET_SETS = {
  square: [
    { id: 'compact', label: 'Компактный', size: 250 },
    { id: 'normal', label: 'Обычный', size: 450 },
    { id: 'large', label: 'Большой', size: 600 },
    { id: 'very-large', label: 'Очень большой', size: 700 },
  ],
  '4:5': [
    { id: 'compact', label: 'Компактный', size: 300 },
    { id: 'normal', label: 'Обычный', size: 400 },
    { id: 'large', label: 'Большой', size: 550 },
  ],
  '9:16': [
    { id: 'compact', label: 'Компактный', size: 450 },
    { id: 'normal', label: 'Обычный', size: 700 },
    { id: 'large', label: 'Большой', size: 800 },
  ],
};
const ASPECT_RATIOS = [
  { label: '1:1', value: '1:1', width: 1, height: 1 },
  { label: '4:5', value: '4:5', width: 4, height: 5 },
  { label: '9:16', value: '9:16', width: 9, height: 16 },
];
const UPDATE_REPOSITORY = { owner: 'leninblok', repo: 'floating-camera' };
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/latest`;

let mainWindow;
let borderEnabled = true;
let shadowEnabled = true;
let mirrorEnabled = false;
let focusEnabled = false;
let shapeMode = 'circle';
let aspectRatio = '4:5';
let selectedSizePreset = 'compact';
let cameraDeviceId = null;
let cameraDevices = [];
let latestReleaseUrl = null;
let lastProgrammaticBounds = null;
let programmaticLayoutExpiresAt = 0;

function compactBounds(bounds) {
  if (!bounds) return null;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(number, maximum));
}

function selectedAspectRatio() {
  return ASPECT_RATIOS.find((item) => item.value === aspectRatio) || ASPECT_RATIOS[0];
}

function sizePresetsForCurrentShape() {
  if (shapeMode === 'circle' || aspectRatio === '1:1') return SIZE_PRESET_SETS.square;
  return SIZE_PRESET_SETS[aspectRatio] || SIZE_PRESET_SETS.square;
}

function activeSizePreset(size = null) {
  const presets = sizePresetsForCurrentShape();
  const selected = presets.find((preset) => preset.id === selectedSizePreset);
  if (selected) return selected;

  const referenceSize = clampNumber(size, MIN_SIZE, MAX_SIZE, presets[0].size);
  const closest = presets.reduce((nearest, preset) => (
    Math.abs(preset.size - referenceSize) < Math.abs(nearest.size - referenceSize) ? preset : nearest
  ));
  selectedSizePreset = closest.id;
  return closest;
}

function dimensionsForSize(size) {
  const maximumSide = clampNumber(size, MIN_SIZE, MAX_SIZE, 250);
  const inset = shadowEnabled ? SHADOW_INSET * 2 : 0;
  if (shapeMode === 'circle') return { width: maximumSide + inset, height: maximumSide + inset };
  const ratio = selectedAspectRatio().width / selectedAspectRatio().height;
  return ratio >= 1
    ? { width: maximumSide + inset, height: Math.max(1, Math.round(maximumSide / ratio)) + inset }
    : { width: Math.max(1, Math.round(maximumSide * ratio)) + inset, height: maximumSide + inset };
}

function largestSide(bounds) {
  const inset = shadowEnabled ? SHADOW_INSET * 2 : 0;
  return clampNumber(Math.max(bounds?.width, bounds?.height) - inset, MIN_SIZE, MAX_SIZE, 250);
}

function normalizeBoundsForCurrentShape(bounds) {
  const dimensions = dimensionsForSize(largestSide(bounds));
  return {
    x: Math.round(Number.isFinite(bounds?.x) ? bounds.x : 0),
    y: Math.round(Number.isFinite(bounds?.y) ? bounds.y : 0),
    ...dimensions,
  };
}

function displayForBounds(bounds) {
  const x = Number.isFinite(bounds?.x) ? bounds.x : 0;
  const y = Number.isFinite(bounds?.y) ? bounds.y : 0;
  const width = clampNumber(bounds?.width, MIN_SIZE, MAX_SIZE, 250);
  const height = clampNumber(bounds?.height, MIN_SIZE, MAX_SIZE, 250);
  return screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  });
}

function windowEdgeMargins() {
  return shapeMode === 'rectangle' ? RECTANGLE_EDGE_MARGINS : CIRCLE_EDGE_MARGINS;
}

function boundsWithSizePreservingAnchor(bounds, size) {
  const dimensions = dimensionsForSize(size);
  const display = displayForBounds(bounds);
  const workArea = display.workArea;
  const { x: marginX, y: marginY } = windowEdgeMargins();
  const left = workArea.x + marginX;
  const top = workArea.y + marginY;
  const right = workArea.x + workArea.width - marginX;
  const bottom = workArea.y + workArea.height - marginY;
  const current = compactBounds(bounds);

  const attachedToLeft = Math.abs(current.x - left) <= EDGE_ANCHOR_TOLERANCE;
  const attachedToRight = Math.abs(current.x + current.width - right) <= EDGE_ANCHOR_TOLERANCE;
  const attachedToTop = Math.abs(current.y - top) <= EDGE_ANCHOR_TOLERANCE;
  const attachedToBottom = Math.abs(current.y + current.height - bottom) <= EDGE_ANCHOR_TOLERANCE;

  // Preserve the corner or edge at which the camera is already resting.
  // Away from an edge, preserve its centre so an arbitrary placement also
  // feels stable while the form changes.
  const x = attachedToLeft
    ? left
    : attachedToRight
      ? right - dimensions.width
      : current.x + (current.width - dimensions.width) / 2;
  const y = attachedToTop
    ? top
    : attachedToBottom
      ? bottom - dimensions.height
      : current.y + (current.height - dimensions.height) / 2;

  return clampToVisibleDisplay({ x, y, ...dimensions });
}

function isRecentProgrammaticLayout(bounds) {
  return Date.now() < programmaticLayoutExpiresAt
    && sameWindowSize(bounds, lastProgrammaticBounds);
}

function setWindowBoundsProgrammatically(bounds, { animate = false, reason = 'layout' } = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || !bounds) return;
  // Electron delivers resize events asynchronously. Preserve the exact
  // requested size, so a real external stretch is never hidden merely
  // because it happened shortly after a camera drag or focus animation.
  lastProgrammaticBounds = { ...bounds };
  programmaticLayoutExpiresAt = Date.now() + (animate ? 1_250 : 750);
  // Electron animates this natively on macOS. The renderer uses object-fit:
  // cover, so the video is recropped while the bounds change rather than
  // being stretched into the new shape.
  mainWindow.setBounds(bounds, Boolean(animate && process.platform === 'darwin'));
}

function sameWindowSize(first, second, tolerance = PROGRAMMATIC_LAYOUT_TOLERANCE) {
  return Boolean(first && second
    && Math.abs(first.width - second.width) <= tolerance
    && Math.abs(first.height - second.height) <= tolerance);
}

function clampToVisibleDisplay(bounds) {
  const normalized = normalizeBoundsForCurrentShape(bounds);
  const display = displayForBounds(normalized);
  const workArea = display.workArea;
  const { x: marginX, y: marginY } = windowEdgeMargins();
  const insetX = workArea.x + marginX;
  const insetY = workArea.y + marginY;
  const insetWidth = Math.max(0, workArea.width - marginX * 2);
  const insetHeight = Math.max(0, workArea.height - marginY * 2);
  const scale = Math.min(
    1,
    insetWidth > 0 ? insetWidth / normalized.width : 1,
    insetHeight > 0 ? insetHeight / normalized.height : 1,
  );
  const width = Math.max(1, Math.round(normalized.width * scale));
  const height = Math.max(1, Math.round(normalized.height * scale));
  let x = Number.isFinite(normalized.x) ? normalized.x : insetX;
  let y = Number.isFinite(normalized.y) ? normalized.y : insetY;

  x = Math.max(insetX, Math.min(x, insetX + insetWidth - width));
  y = Math.max(insetY, Math.min(y, insetY + insetHeight - height));
  return { x, y, width, height };
}

function loadLastState() {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return null;
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}');
    borderEnabled = typeof data.borderEnabled === 'boolean' ? data.borderEnabled : true;
    shadowEnabled = typeof data.shadowEnabled === 'boolean' ? data.shadowEnabled : true;
    mirrorEnabled = typeof data.mirrorEnabled === 'boolean' ? data.mirrorEnabled : false;
    shapeMode = data.shapeMode === 'rectangle' ? 'rectangle' : 'circle';
    aspectRatio = ASPECT_RATIOS.some((item) => item.value === data.aspectRatio) ? data.aspectRatio : '4:5';
    const hasStoredSizePreset = typeof data.sizePresetId === 'string';
    selectedSizePreset = hasStoredSizePreset ? data.sizePresetId : null;
    cameraDeviceId = typeof data.cameraDeviceId === 'string' ? data.cameraDeviceId : null;

    const size = clampNumber(data.lastSize, MIN_SIZE, MAX_SIZE, 0);
    if (!size || !Number.isFinite(data.lastX) || !Number.isFinite(data.lastY)) return null;
    const preset = activeSizePreset(size);
    return {
      x: Math.floor(data.lastX),
      y: Math.floor(data.lastY),
      size: hasStoredSizePreset ? size : preset.size,
    };
  } catch (_) {
    return null;
  }
}

function saveLastState(bounds) {
  try {
    const side = largestSide(bounds);
    const data = {
      lastSize: side,
      lastX: Math.round(bounds?.x || 0),
      lastY: Math.round(bounds?.y || 0),
      borderEnabled: Boolean(borderEnabled),
      shadowEnabled: Boolean(shadowEnabled),
      mirrorEnabled: Boolean(mirrorEnabled),
      shapeMode,
      aspectRatio,
      sizePresetId: selectedSizePreset,
      cameraDeviceId,
    };
    const settingsPath = getSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(data), 'utf8');
  } catch (_) {
    // Persistence is optional; the camera remains usable if it fails.
  }
}

function cameraPermissionMessage(status) {
  if (status === 'denied' || status === 'restricted') {
    return 'Доступ к камере отключён. Разрешите Floating Camera в «Системные настройки → Конфиденциальность и безопасность → Камера», затем перезапустите приложение.';
  }
  return 'Не удалось получить разрешение на камеру.';
}

async function ensureCameraAccess() {
  if (process.platform !== 'darwin') return { granted: true };
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') return { granted: true };
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('camera');
    return granted ? { granted: true } : { granted: false, message: cameraPermissionMessage('denied') };
  }
  return { granted: false, message: cameraPermissionMessage(status) };
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function enforceFloatingOverlay(reason, { skipProcessTransform = false, bringToFront = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // `visibleOnFullScreen` is distinct from always-on-top on macOS: it adds
    // the native FullScreenAuxiliary collection behaviour required to live in
    // another app's full-screen Space. Reassert it after the window is shown
    // and whenever the camera loses focus, as AppKit can drop that behaviour
    // while transitioning between Spaces.
    mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu');
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        // The first call sets the process type. Later calls only restore the
        // window collection flags and must not make the Dock flicker.
        skipTransformProcessType: skipProcessTransform,
      });
    }
    if (bringToFront) mainWindow.moveTop();
  } catch (_) {
    // The camera remains functional if a platform does not implement one of
    // these optional window-level APIs.
  }
}

function scheduleFloatingOverlayEnforcement(reason, delay = OVERLAY_REASSERT_DELAY_MS) {
  setTimeout(() => enforceFloatingOverlay(reason, {
    skipProcessTransform: true,
    bringToFront: true,
  }), delay);
}

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function handleTrusted(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error(`Rejected untrusted IPC sender for ${channel}.`);
    return listener(event, ...args);
  });
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
}

function isTrustedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com'
      && url.pathname.startsWith(`/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/`);
  } catch (_) {
    return false;
  }
}

async function checkForUpdates() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(UPDATE_API_URL, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Floating-Camera/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) return { status: 'unavailable', message: 'Пока нет опубликованного релиза.' };
    if (!response.ok) return { status: 'unavailable', message: `Не удалось проверить обновления (HTTP ${response.status}).` };
    const release = await response.json();
    const version = String(release?.tag_name || '').replace(/^v/, '');
    const releaseUrl = release?.html_url;
    const hasMacArtifact = Array.isArray(release?.assets)
      && release.assets.some((asset) => /\.(dmg|zip)$/i.test(String(asset?.name || '')));
    if (!isTrustedReleaseUrl(releaseUrl) || !parseVersion(version) || !hasMacArtifact) {
      return { status: 'unavailable', message: 'Последний GitHub Release не содержит готовой macOS-сборки.' };
    }
    latestReleaseUrl = releaseUrl;
    if (isNewerVersion(version, app.getVersion())) return { status: 'update', version };
    return { status: 'up-to-date', version: app.getVersion() };
  } catch (_) {
    return { status: 'unavailable', message: 'Не удалось связаться с сервером обновлений.' };
  } finally {
    clearTimeout(timeout);
  }
}

async function openLatestReleasePage() {
  if (!latestReleaseUrl || !isTrustedReleaseUrl(latestReleaseUrl)) await checkForUpdates();
  if (!latestReleaseUrl || !isTrustedReleaseUrl(latestReleaseUrl)) return false;
  await shell.openExternal(latestReleaseUrl);
  return true;
}

async function presentUpdateCheck() {
  const result = await checkForUpdates();
  if (result.status === 'update') {
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: `Доступна версия ${result.version}.`,
      buttons: ['Открыть страницу релиза', 'Не сейчас'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response.response === 0) await openLatestReleasePage();
    return;
  }
  await dialog.showMessageBox(mainWindow, {
    type: result.status === 'up-to-date' ? 'info' : 'warning',
    message: result.status === 'up-to-date'
      ? `У вас последняя версия (${result.version}).`
      : result.message,
    buttons: ['ОК'],
  });
}

function currentWindowSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const bounds = mainWindow.getBounds();
  return largestSide(bounds);
}

function focusSizeForCurrentShape() {
  if (!mainWindow || mainWindow.isDestroyed()) return 750;
  const workArea = displayForBounds(mainWindow.getBounds()).workArea;
  const margins = windowEdgeMargins();
  const shadowSpace = shadowEnabled ? SHADOW_INSET * 2 : 0;
  const usableHeight = Math.max(MIN_SIZE, workArea.height - margins.y * 2 - shadowSpace);

  if (shapeMode === 'rectangle' && aspectRatio === '9:16') {
    return clampNumber(Math.min(usableHeight, 1200), MIN_SIZE, MAX_SIZE, 960);
  }
  if (shapeMode === 'rectangle' && aspectRatio === '4:5') {
    return clampNumber(Math.min(Math.round(workArea.height * 0.78) - shadowSpace, 900), MIN_SIZE, MAX_SIZE, 760);
  }
  return clampNumber(Math.min(750, usableHeight), MIN_SIZE, MAX_SIZE, 750);
}

function centeredBoundsForSize(size) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const dimensions = dimensionsForSize(size);
  const workArea = displayForBounds(mainWindow.getBounds()).workArea;
  return clampToVisibleDisplay({
    x: workArea.x + (workArea.width - dimensions.width) / 2,
    y: workArea.y + (workArea.height - dimensions.height) / 2,
    ...dimensions,
  });
}

function setMainWindowSize(preset) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  selectedSizePreset = preset.id;
  const bounds = boundsWithSizePreservingAnchor(current, preset.size);
  setWindowBoundsProgrammatically(bounds, { animate: true, reason: 'size-preset' });
  focusEnabled = false;
  saveLastState(bounds);
  sendToRenderer('camera:size-changed', largestSide(bounds));
  buildApplicationMenu();
}

function setMirrorEnabled(enabled) {
  mirrorEnabled = Boolean(enabled);
  if (mainWindow && !mainWindow.isDestroyed()) saveLastState(mainWindow.getBounds());
  sendToRenderer('camera:set-mirror', mirrorEnabled);
  buildApplicationMenu();
}

function setBorderEnabled(enabled) {
  borderEnabled = Boolean(enabled);
  if (mainWindow && !mainWindow.isDestroyed()) saveLastState(mainWindow.getBounds());
  sendToRenderer('camera:set-border', borderEnabled);
  buildApplicationMenu();
}

function setShadowEnabled(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    shadowEnabled = Boolean(enabled);
    buildApplicationMenu();
    return;
  }

  const current = mainWindow.getBounds();
  const contentSize = largestSide(current);
  shadowEnabled = Boolean(enabled);
  const bounds = boundsWithSizePreservingAnchor(current, contentSize);
  // Start the visual transition before the native bounds animation.
  sendToRenderer('camera:set-shadow', shadowEnabled);
  setWindowBoundsProgrammatically(bounds, { animate: true, reason: 'shadow' });
  saveLastState(bounds);
  buildApplicationMenu();
}

function setFocusEnabled(enabled, notifyRenderer = true) {
  focusEnabled = Boolean(enabled);
  if (notifyRenderer) sendToRenderer('camera:set-focus', focusEnabled);
  buildApplicationMenu();
}

function setShapeMode(mode) {
  if (mode !== 'circle' && mode !== 'rectangle') return;
  shapeMode = mode;
  focusEnabled = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const current = mainWindow.getBounds();
    const preset = activeSizePreset(largestSide(current));
    const bounds = boundsWithSizePreservingAnchor(current, preset.size);
    // Change the mask first so its CSS transition begins together with the
    // macOS window animation below.
    sendToRenderer('camera:set-shape', { shapeMode, aspectRatio });
    setWindowBoundsProgrammatically(bounds, { animate: true, reason: 'shape' });
    saveLastState(bounds);
    sendToRenderer('camera:size-changed', largestSide(bounds));
  }
  buildApplicationMenu();
}

function setAspectRatio(value) {
  if (!ASPECT_RATIOS.some((item) => item.value === value)) return;
  aspectRatio = value;
  if (shapeMode === 'rectangle') setShapeMode('rectangle');
  else buildApplicationMenu();
}

function setCameraDeviceId(deviceId, notifyRenderer = false) {
  cameraDeviceId = typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length <= 1024 ? deviceId : null;
  if (mainWindow && !mainWindow.isDestroyed()) saveLastState(mainWindow.getBounds());
  if (notifyRenderer) sendToRenderer('camera:set-device', cameraDeviceId);
  buildApplicationMenu();
}

function cameraMenuItems() {
  const items = [{
    label: 'Автоматически',
    type: 'radio',
    checked: cameraDeviceId === null,
    click: () => setCameraDeviceId(null, true),
  }];

  for (const device of cameraDevices) {
    items.push({
      label: device.label,
      type: 'radio',
      checked: device.id === cameraDeviceId,
      click: () => setCameraDeviceId(device.id, true),
    });
  }
  return items;
}

function shapeMenuItems() {
  return [
    {
      label: 'Круг',
      type: 'radio',
      checked: shapeMode === 'circle',
      click: () => setShapeMode('circle'),
    },
    {
      label: 'Прямоугольник',
      type: 'radio',
      checked: shapeMode === 'rectangle',
      click: () => setShapeMode('rectangle'),
    },
  ];
}

function aspectRatioMenuItems() {
  return ASPECT_RATIOS.map((ratio) => ({
    label: ratio.label,
    type: 'radio',
    checked: aspectRatio === ratio.value,
    click: () => setAspectRatio(ratio.value),
  }));
}

function sizeMenuItems() {
  const activePreset = activeSizePreset(currentWindowSize());
  return sizePresetsForCurrentShape().map((preset) => ({
    label: preset.label,
    type: 'radio',
    checked: activePreset.id === preset.id,
    click: () => setMainWindowSize(preset),
  }));
}

function controlMenuItems(includeClose = false) {
  const items = [
    { label: 'Источник', submenu: cameraMenuItems() },
    { type: 'separator' },
  ];

  items.push({ label: 'Форма', submenu: shapeMenuItems() });

  if (shapeMode === 'rectangle') {
    items.push({ label: 'Соотношение сторон', submenu: aspectRatioMenuItems() });
  }

  items.push(
    { label: 'Размер', submenu: sizeMenuItems() },
    {
      label: 'Оформление',
      submenu: [
        {
          label: 'Контур',
          type: 'checkbox',
          checked: borderEnabled,
          click: (item) => setBorderEnabled(item.checked),
        },
        {
          label: 'Тень',
          type: 'checkbox',
          checked: shadowEnabled,
          click: (item) => setShadowEnabled(item.checked),
        },
      ],
    },
    {
      label: 'Отразить по горизонтали',
      type: 'checkbox',
      checked: mirrorEnabled,
      click: (item) => setMirrorEnabled(item.checked),
    },
    {
      label: 'Режим фокуса',
      type: 'checkbox',
      checked: focusEnabled,
      click: (item) => setFocusEnabled(item.checked),
    },
  );

  if (includeClose) {
    items.push(
      { type: 'separator' },
      { label: 'Закрыть камеру', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    );
  }
  return items;
}

function showControlContextMenu(x, y) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  Menu.buildFromTemplate(controlMenuItems(true)).popup({ window: mainWindow, x, y });
}

function buildApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Завершить Floating Camera' },
      ],
    },
    {
      label: 'Камера',
      submenu: controlMenuItems(true),
    },
    {
      label: 'Обновления',
      submenu: [
        { label: 'Проверить обновления', click: () => { void presentUpdateCheck(); } },
        { label: 'Открыть последний релиз', click: () => { void openLatestReleasePage(); } },
      ],
    },
    { label: 'Окно', submenu: [{ role: 'front' }] },
  ]));
}

function createWindow(initialSize = 250, restoredBounds = null) {
  mainWindow = new BrowserWindow({
    width: initialSize,
    height: initialSize,
    frame: false,
    transparent: true,
    // This is a fixed-shape floating camera. Its only size changes come from
    // the app's own controls, never from the standard macOS window controls.
    resizable: false,
    maximizable: false,
    minimizable: false,
    // Keep Electron's normal full-screen-compatible collection behaviour for
    // the overlay. User entry to full screen / Split View is separately
    // removed: this frameless fixed window has no Zoom control and is hidden
    // from Mission Control, where macOS exposes tile targets.
    fullscreenable: true,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    // The camera's rounded shape is drawn by CSS. Disabling native rounded
    // corners makes Electron create a genuinely borderless AppKit window;
    // otherwise macOS can leave a thin title-frame divider after Split View.
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    showControlContextMenu(params.x, params.y);
  });
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestedMedia = details?.mediaTypes || [];
    callback(Boolean(
      mainWindow
      && webContents === mainWindow.webContents
      && permission === 'media'
      && requestedMedia.length > 0
      && requestedMedia.every((mediaType) => mediaType === 'video')
    ));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => Boolean(
    mainWindow
    && webContents === mainWindow.webContents
    && permission === 'media'
    && details?.mediaType === 'video'
  ));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    const state = loadLastState();
    const bounds = restoredBounds
      ? clampToVisibleDisplay(restoredBounds)
      : state
      ? clampToVisibleDisplay({ x: state.x, y: state.y, ...dimensionsForSize(state.size) })
      : (() => {
          const workArea = screen.getPrimaryDisplay().workArea;
          const size = clampNumber(initialSize, MIN_SIZE, MAX_SIZE, 250);
          const dimensions = dimensionsForSize(size);
          return clampToVisibleDisplay({
            x: workArea.x + workArea.width - dimensions.width,
            y: workArea.y,
            ...dimensions,
          });
        })();
    setWindowBoundsProgrammatically(bounds);
    mainWindow.show();
    // This must happen after `show()`: macOS may otherwise discard the
    // collection behaviour while creating the transparent window surface.
    enforceFloatingOverlay('initial-show', { bringToFront: true });
    scheduleFloatingOverlayEnforcement('initial-show-settled');
  });

  mainWindow.on('close', () => saveLastState(mainWindow.getBounds()));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('blur', () => {
    // Entering another app's full-screen Space starts with the camera losing
    // key status. Reapply the native overlay flags shortly afterwards so the
    // camera remains visible without taking keyboard focus back.
    scheduleFloatingOverlayEnforcement('window-blur');
  });
  mainWindow.on('will-resize', (event, newBounds) => {
    const allowedSystemResize = isRecentProgrammaticLayout(newBounds);

    // Do not turn ordinary window resizing back on as a side effect of a
    // system transition. The window is moved through the app's presets and
    // drag handling; the native resize edge must never be interactive.
    if (!allowedSystemResize) event.preventDefault();
  });
}

function keepWindowVisible() {
  if (!mainWindow) return;
  const current = mainWindow.getBounds();
  const clamped = clampToVisibleDisplay(current);
  setWindowBoundsProgrammatically(clamped);
}

app.whenReady().then(() => {
  app.setName('Floating Camera');
  nativeTheme.themeSource = 'light';
  // Make the process an accessory application before creating the overlay.
  // Electron uses the same AppKit mode for windows visible above existing
  // full-screen Spaces; doing it once avoids later Space-role transitions.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  const state = loadLastState();
  buildApplicationMenu();
  createWindow((state && state.size) || 250);
  void checkForUpdates();
  screen.on('display-metrics-changed', keepWindowVisible);
  screen.on('display-added', keepWindowVisible);
  screen.on('display-removed', keepWindowVisible);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(250);
    }
  });
}).catch((error) => {
  console.error('Floating Camera could not start:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

handleTrusted('app:getBounds', () => (mainWindow ? mainWindow.getBounds() : null));
handleTrusted('app:setBounds', (_event, bounds) => {
  if (!mainWindow || !bounds) return;
  const nextBounds = clampToVisibleDisplay(bounds);
  setWindowBoundsProgrammatically(nextBounds);
});
handleTrusted('app:getCenteredBounds', (_event, size) => {
  return centeredBoundsForSize(size);
});
handleTrusted('app:getFocusBounds', () => centeredBoundsForSize(focusSizeForCurrentShape()));
handleTrusted('app:getBorderEnabled', () => borderEnabled);
handleTrusted('app:getShadowEnabled', () => shadowEnabled);
handleTrusted('app:getMirrorEnabled', () => mirrorEnabled);
handleTrusted('app:getShape', () => ({ shapeMode, aspectRatio }));
handleTrusted('app:setFocusEnabled', (_event, enabled) => {
  setFocusEnabled(enabled, false);
});
handleTrusted('app:ensureCameraAccess', ensureCameraAccess);
handleTrusted('app:openCameraPrivacySettings', () => (
  process.platform === 'darwin'
    ? shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
    : false
));
handleTrusted('camera:getDeviceId', () => cameraDeviceId);
handleTrusted('camera:setDeviceId', (_event, deviceId) => {
  setCameraDeviceId(deviceId);
});
handleTrusted('camera:syncDevices', (_event, devices) => {
  if (!Array.isArray(devices)) return;
  const uniqueIds = new Set();
  cameraDevices = devices.reduce((result, device, index) => {
    const id = typeof device?.id === 'string' ? device.id : '';
    if (!id || id.length > 1024 || uniqueIds.has(id)) return result;
    uniqueIds.add(id);
    const rawLabel = typeof device?.label === 'string' ? device.label.trim() : '';
    result.push({ id, label: (rawLabel || `Камера ${index + 1}`).slice(0, 256) });
    return result;
  }, []);
  buildApplicationMenu();
});

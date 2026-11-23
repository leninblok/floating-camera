const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ reducedMotion = false, appDefaults = false } = {}) {
  const displays = [
    { id: 1, workArea: { x: 0, y: 30, width: 1440, height: 870 } },
    { id: 2, workArea: { x: -1920, y: -200, width: 1920, height: 1080 } },
  ];
  const app = new EventEmitter();
  Object.assign(app, { whenReady: () => new Promise(() => {}), getPath: () => '/settings', quit: () => { app.quitCalls++; }, quitCalls: 0 });
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, fn) => handlers.set(name, fn);
  const writes = [];
  const timers = new Map();
  let timerId = 0;
  let nowMs = 0;
  let nextFrameAt = 1000 / 120;
  const advance = (ms) => {
    const end = nowMs + ms;
    for (let count = 0; count < 10000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      const timerAt = next ? next[1].at : Infinity;
      if (Math.min(timerAt, nextFrameAt) > end) break;
      if (timerAt < nextFrameAt) {
        timers.delete(next[0]);
        nowMs = timerAt;
        next[1].fn();
      } else {
        nowMs = nextFrameAt;
        context.frameTime = nowMs;
        vm.runInContext('if (boundsAnimation) stepBoundsAnimation(boundsAnimation.id, frameTime)', context);
        nextFrameAt += 1000 / 120;
      }
    }
    nowMs = end;
  };
  let menuBuilds = 0;
  let lastMenu = null;
  let bounds = { x: 900, y: 400, width: 338, height: 338 };
  const layoutCalls = [];
  const positionCalls = [];
  const messages = [];
  const mouseHitCalls = [];
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    setHasShadow: () => {},
    setIgnoreMouseEvents: (ignore, options) => mouseHitCalls.push({ ignore, options }),
    invalidateShadow: () => {},
    getBounds: () => ({ ...bounds }),
    setBounds: (next, animate) => { bounds = { ...next }; layoutCalls.push({ next, animate }); },
    setPosition: (x, y) => { bounds.x = x; bounds.y = y; positionCalls.push({ x, y }); },
    webContents: { send: (channel, ...args) => messages.push({ channel, args }) },
  };
  const electron = {
    app, ipcMain: ipc,
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: reducedMotion }) },
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: (menu) => { menuBuilds++; lastMenu = menu; } },
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      getDisplayNearestPoint: ({ x }) => x < 0 ? displays[1] : displays[0],
    },
  };
  const fakeFs = { promises: {
    mkdir: async () => {},
    writeFile: async (file, data) => { writes.push({ file, data: JSON.parse(data) }); },
    rename: async () => {},
  } };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === 'fs' ? fakeFs : require(name),
    __dirname: path.resolve(__dirname, '..'), process: { env: {}, platform: process.platform, pid: process.pid, hrtime: { bigint: () => BigInt(Math.round(nowMs * 1e6)) } }, console,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: nowMs + ms }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'reference/electron-main.cjs'), 'utf8'), context);
  // Existing geometry regressions use a saved square profile. The fresh
  // launch profile is checked separately and in the Electron smoke test.
  if (!appDefaults) vm.runInContext("shapeMode = 'circle'; aspectRatio = '4:5'; selectedSizePreset = 'compact'; borderEnabled = true", context);
  context.testWindow = window;
  vm.runInContext('mainWindow = testWindow', context);
  const run = (code) => vm.runInContext(code, context);
  return {
    run, advance, displays, app, writes, timers, layoutCalls, positionCalls, messages, mouseHitCalls,
    bounds: () => ({ ...bounds }), menuBuilds: () => menuBuilds, menu: () => lastMenu,
    move: (position, sender = window.webContents) => ipc.emit('app:move', { sender }, position),
    setMouseHit: (enabled, sender = window.webContents) => ipc.emit('app:setMouseEventsEnabled', { sender }, enabled),
    invoke: (name, ...args) => handlers.get(name)({ sender: window.webContents }, ...args),
  };
}

test('shadow input passes through and camera input is restored only on a real state change', { skip: !['darwin', 'win32'].includes(process.platform) }, () => {
  const h = harness();
  h.setMouseHit(false);
  h.setMouseHit(false);
  h.setMouseHit(true);
  h.setMouseHit(true);
  h.setMouseHit(false);
  h.setMouseHit(true, {});
  h.setMouseHit('true');
  assert.equal(h.mouseHitCalls.length, 3);
  assert.equal(h.mouseHitCalls[0].ignore, true);
  assert.equal(h.mouseHitCalls[0].options.forward, true);
  assert.equal(h.mouseHitCalls[1].ignore, false);
  assert.equal(h.mouseHitCalls[2].ignore, true);
});

test('fresh launch uses a large 9:16 rectangle with shadow and no border', () => {
  const h = harness({ appDefaults: true });
  assert.equal(h.run('shapeMode'), 'rectangle');
  assert.equal(h.run('aspectRatio'), '9:16');
  assert.equal(h.run('selectedSizePreset'), 'large');
  assert.equal(h.run('shadowEnabled'), true);
  assert.equal(h.run('borderEnabled'), false);
  assert.equal(h.run('mirrorEnabled'), false);
  assert.equal(h.run('focusEnabled'), false);
});

test('quit shortcut appears in the app and context menus without a second camera menu exit', () => {
  const h = harness();
  h.run('buildApplicationMenu()');
  const appQuit = h.menu()[0].submenu.find((item) => item.role === 'quit');
  const cameraMenu = h.menu()[1].submenu;
  const contextQuit = h.run('controlMenuItems(true)').at(-1);
  assert.equal(appQuit.accelerator, 'CommandOrControl+Q');
  assert.equal(contextQuit.accelerator, 'CommandOrControl+Q');
  assert.equal(contextQuit.label, 'Закрыть');
  assert.equal(contextQuit.role, undefined);
  assert.equal(contextQuit.icon, undefined);
  contextQuit.click();
  assert.equal(h.app.quitCalls, 1);
  assert.ok(cameraMenu.every((item) => item.role !== 'quit'));
  assert.ok(cameraMenu.some((item) => item.label === 'Выбрать камеру'));
  assert.ok(cameraMenu.some((item) => item.label === 'Фокус'));
});

for (const shape of ['circle', 'rectangle']) {
  for (const ratio of ['1:1', '4:5', '9:16']) {
    test(`shadow toggles preserve native bounds and preset sizes: ${shape} ${ratio}`, () => {
      const h = harness();
      h.run(`shapeMode = '${shape}'; aspectRatio = '${ratio}'`);
      const before = h.bounds();
      const preset = h.run('sizeForPreset(sizePresetsForCurrentShape()[0])');
      for (let i = 0; i < 100; i++) h.run(`setShadowEnabled(${i % 2 === 0})`);
      assert.deepEqual(h.bounds(), before);
      assert.equal(h.layoutCalls.length, 0);
      assert.equal(h.run('sizeForPreset(sizePresetsForCurrentShape()[0])'), preset);
    });
  }
}

test('focus round trip restores exact bounds and shadow toggle cannot overwrite them', () => {
  const h = harness();
  const before = h.bounds();
  h.run('setFocusEnabled(true); setShadowEnabled(false); setBorderEnabled(false)');
  assert.equal(h.run('pendingSettings.lastX'), before.x);
  assert.equal(h.run('pendingSettings.lastY'), before.y);
  h.advance(240);
  assert.notDeepEqual(h.bounds(), before);
  h.run('setFocusEnabled(false)');
  h.advance(240);
  assert.deepEqual(h.bounds(), before);
  assert.ok(h.layoutCalls.length >= 28 && h.layoutCalls.length <= 50);
  assert.ok(h.layoutCalls.every((call) => call.animate === false));
});

test('preset selected in focus mode uses the previous camera position', () => {
  const h = harness();
  h.run('setFocusEnabled(true); setMainWindowSize(SIZE_PRESET_SETS.square[0])');
  h.advance(240);
  assert.equal(h.run('focusEnabled'), false);
  assert.equal(h.run('focusRestoreBounds'), null);
  const after = h.bounds();
  assert.ok(Math.abs(after.x + after.width / 2 - 1069) <= 0.5);
  assert.ok(Math.abs(after.y + after.height / 2 - 569) <= 0.5);
});

test('drag hot path only moves: no layout, menu rebuild or disk writes; foreign/invalid IPC ignored', () => {
  const h = harness();
  const before = h.bounds();
  for (let i = 0; i < 500; i++) h.move({ x: -500 + i, y: 200 + i });
  assert.equal(h.positionCalls.length, 500);
  assert.equal(h.layoutCalls.length, 0);
  assert.equal(h.menuBuilds(), 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.bounds().width, before.width);
  h.move({ x: NaN, y: 0 });
  h.move({ x: 1e9, y: 0 });
  h.move({ x: 20, y: 20 }, {});
  h.run('setFocusEnabled(true)');
  h.move({ x: 20, y: 20 });
  assert.equal(h.positionCalls.length, 500);
});

test('releasing a drag adapts the preset to a second display with negative coordinates', () => {
  const h = harness();
  h.move({ x: -900, y: -100 });
  h.invoke('app:finishMove');
  h.advance(240);
  const bounds = h.bounds();
  assert.ok(bounds.x < 0);
  assert.equal(bounds.height - 88, Math.round((1080 - 96 - 88) * 0.22));
  assert.ok(h.layoutCalls.length > 1 && h.layoutCalls.length <= 20);
});

test('clamping an oversized portrait preserves content aspect ratio on a small display', () => {
  const h = harness();
  h.displays[0].workArea = { x: 0, y: 30, width: 360, height: 300 };
  h.run("shapeMode = 'rectangle'; aspectRatio = '9:16'");
  const bounds = h.run('clampToVisibleDisplay({ x: 9000, y: 9000, width: 10000, height: 10000 })');
  assert.ok(bounds.x >= 24 && bounds.x + bounds.width <= 336);
  assert.ok(bounds.y >= 46 && bounds.y + bounds.height <= 314);
  assert.ok(Math.abs((bounds.width - 88) - (bounds.height - 88) * 9 / 16) <= 1);
});

test('repeated appearance changes coalesce into one asynchronous settings write', async () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.run(`setShadowEnabled(${i % 2 === 0})`);
  assert.equal(h.writes.length, 0);
  assert.equal([...h.timers.values()].filter((timer) => timer.at === 150).length, 1);
  await h.run('flushSettings()');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data.shadowEnabled, false);
  assert.match(h.writes[0].file, /\.tmp$/);
});

test('queued settings writes finish in order and quit waits for final preferences', async () => {
  const h = harness();
  h.run('setShadowEnabled(false); flushSettings(); setShadowEnabled(true)');
  let prevented = false;
  h.app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  await h.run('settingsWrite');
  await Promise.resolve();
  assert.deepEqual(h.writes.map((item) => item.data.shadowEnabled), [false, true]);
  assert.equal(h.app.quitCalls, 1);
});


test('ordinary release near an edge never snaps to that edge', () => {
  const h = harness();
  h.run('setMainWindowSize(SIZE_PRESET_SETS.square[0])');
  h.advance(240);
  h.move({ x: 50, y: 200 });
  const before = h.bounds();
  const layouts = h.layoutCalls.length;
  h.invoke('app:finishMove');
  assert.deepEqual(h.bounds(), before);
  assert.equal(h.layoutCalls.length, layouts);
});

test('outer screen edge has bounded elastic give and release eases back without a teleport', () => {
  const h = harness();
  h.displays.splice(1);
  h.run('setMainWindowSize(SIZE_PRESET_SETS.square[0])');
  h.advance(240);
  h.move({ x: -200, y: 200 });
  assert.ok(h.bounds().x >= 2 && h.bounds().x < 24);
  const stretchedX = h.bounds().x;
  h.invoke('app:finishMove');
  assert.equal(h.bounds().x, stretchedX);
  h.advance(80);
  assert.ok(h.bounds().x > stretchedX && h.bounds().x < 24);
  h.advance(160);
  assert.equal(h.bounds().x, 24);
  assert.equal(h.layoutCalls.at(-1).animate, false);
});

test('shared monitor edge is traversable in both directions without rubber banding', () => {
  const h = harness();
  for (const x of [-100, -200, -100, 20]) {
    h.move({ x, y: 200 });
    assert.equal(h.bounds().x, x);
  }
});

test('a gap or a non-overlapping part of a staggered monitor is an outer edge', () => {
  for (const placement of [{ x: -2120, y: -200 }, { x: -1920, y: 600 }]) {
    const h = harness();
    Object.assign(h.displays[1].workArea, placement);
    h.move({ x: -100, y: 200 });
    assert.ok(h.bounds().x >= 2);
  }
});

test('animation intermediate sizes are allowed and unrelated system resize is rejected', () => {
  const h = harness();
  h.run('setFocusEnabled(true)');
  const target = h.run('boundsAnimation.target');
  const intermediate = { width: (338 + target.width) / 2, height: (338 + target.height) / 2 };
  assert.equal(h.run(`isRecentProgrammaticLayout(${JSON.stringify(intermediate)})`), true);
  assert.equal(h.run('isRecentProgrammaticLayout({ width: 5000, height: 100 })'), false);
});

test('transitions respect the system reduced-motion preference', () => {
  const h = harness({ reducedMotion: true });
  h.run('setFocusEnabled(true); setFocusEnabled(false)');
  assert.ok(h.layoutCalls.every((call) => call.animate === false));
});


test('rapid retargeting keeps one transition and starts from the current frame', () => {
  const h = harness();
  const original = h.bounds();
  h.run('setFocusEnabled(true)');
  h.advance(70);
  const intermediate = h.bounds();
  assert.notDeepEqual(intermediate, original);
  h.run('setFocusEnabled(false)');
  assert.deepEqual(h.bounds(), intermediate);
  assert.equal(h.timers.size, 0);
  h.advance(240);
  assert.deepEqual(h.bounds(), original);
  assert.equal(h.timers.size, 0);
});

test('pointer down interrupts an in-flight transition without replaying its final frame', () => {
  const h = harness();
  h.run('setMainWindowSize(SIZE_PRESET_SETS.square[0])');
  h.advance(70);
  const intermediate = h.bounds();
  h.invoke('app:getBounds');
  assert.equal(h.run('boundsAnimation'), null);
  h.move({ x: 300, y: 200 });
  h.advance(400);
  assert.equal(h.bounds().x, 300);
  assert.equal(h.bounds().y, 200);
  assert.equal(h.bounds().width, intermediate.width);
});


test('changing shape during focus returns to the normal placement without an intermediate focus restore', () => {
  const h = harness();
  const original = h.bounds();
  h.run('setFocusEnabled(true)');
  h.advance(240);
  h.run("setShapeMode('rectangle'); setAspectRatio('9:16')");
  h.advance(240);
  const after = h.bounds();
  assert.equal(h.run('focusEnabled'), false);
  assert.ok(Math.abs(after.x + after.width / 2 - original.x - original.width / 2) <= 1);
  assert.ok(Math.abs(after.y + after.height / 2 - original.y - original.height / 2) <= 1);
  assert.equal(h.run('boundsAnimation'), null);
});


test('layout has no timer and cannot advance without an acknowledged rendering frame', () => {
  const h = harness();
  h.run('setFocusEnabled(true)');
  const original = h.bounds();
  assert.equal(h.timers.size, 0);
  const id = h.run('boundsAnimation.id');
  assert.equal(h.invoke('app:stepLayout', id + 1, 20), false);
  assert.deepEqual(h.bounds(), original);
  h.invoke('app:stepLayout', id, 0);
  h.invoke('app:stepLayout', id, 1000 / 60);
  const target = h.run('boundsAnimation.target');
  assert.ok(Math.abs(h.bounds().x - original.x) / Math.abs(target.x - original.x) < 0.05);
  assert.ok(h.bounds().width > original.width);
  const current = h.bounds();
  h.invoke('app:stepLayout', id, 1);
  assert.deepEqual(h.bounds(), current);
});


test('a stalled frame cannot teleport the window to the animation destination', () => {
  const h = harness();
  h.run('setFocusEnabled(true)');
  const id = h.run('boundsAnimation.id');
  const original = h.bounds();
  h.invoke('app:stepLayout', id, 0);
  h.invoke('app:stepLayout', id, 16);
  const beforeStall = h.bounds();
  h.invoke('app:stepLayout', id, 1000);
  const afterStall = h.bounds();
  const target = h.run('boundsAnimation.target');
  assert.notDeepEqual(afterStall, target);
  assert.ok(Math.abs(afterStall.x - beforeStall.x) / Math.abs(target.x - original.x) < 0.1);
});


test('focus fills the available display while preserving shape and a visible margin', () => {
  for (const [shape, ratio, fill] of [
    ['circle', '1:1', 0.92],
    ['rectangle', '1:1', 0.92],
    ['rectangle', '4:5', 0.94],
    ['rectangle', '9:16', 0.98],
  ]) {
    const h = harness();
    h.run(`shapeMode = '${shape}'; aspectRatio = '${ratio}'`);
    for (const position of [{ x: 900, y: 400 }, { x: -900, y: -100 }]) {
      h.move(position);
      h.run("setWindowBoundsProgrammatically(normalizeBoundsForCurrentShape(mainWindow.getBounds()), { animate: false })");
      const original = h.bounds();
      const expected = h.run('focusSizeForCurrentShape()');
      h.run('setFocusEnabled(true)');
      h.advance(240);
      const focused = h.bounds();
      const area = h.displays[position.x < 0 ? 1 : 0].workArea;
      assert.ok(Math.abs(Math.max(focused.width, focused.height) - 88 - expected) <= 1, `${shape} ${ratio}`);
      assert.ok(focused.x >= area.x && focused.y >= area.y);
      assert.ok(focused.x + focused.width <= area.x + area.width);
      assert.ok(focused.y + focused.height <= area.y + area.height);
      assert.ok(Math.abs(focused.x + focused.width / 2 - area.x - area.width / 2) <= 1);
      assert.ok(Math.abs(focused.y + focused.height / 2 - area.y - area.height / 2) <= 1);
      h.run('setFocusEnabled(false)');
      h.advance(240);
      assert.deepEqual(h.bounds(), original);
    }
    assert.ok(Math.abs(h.run(`focusSizeForCurrentShape() / maximumContentSizeForDisplay()`) - fill) < 0.002);
  }
});

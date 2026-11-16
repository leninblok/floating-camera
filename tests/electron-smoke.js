// Run with Electron. Uses generated video, isolated settings, and no network.
const { app, Menu, systemPreferences, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kruzhok-smoke-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
// Deliberately slow permission response: the shell must still appear first.
systemPreferences.getMediaAccessStatus = () => 'not-determined';
systemPreferences.askForMediaAccess = async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return true; };
process.env.KRUZHOK_PROFILE_STARTUP = '1';
global.fetch = async () => { throw new Error('Network disabled in smoke test'); };
const startedAt = performance.now();
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('Electron smoke timed out');
  app.exit(1);
}, 45000);

function cameraMenu() { return Menu.getApplicationMenu().items[1].submenu; }
function click(submenuLabel, label) {
  const parent = cameraMenu().items.find((item) => item.label === submenuLabel);
  const item = parent.submenu.items.find((entry) => entry.label === label);
  assert.ok(item, `Missing menu item ${submenuLabel} / ${label}`);
  item.click(item);
}
function toggle(label, checked) {
  const parent = cameraMenu().items.find((item) => item.label === 'Оформление');
  const item = parent.submenu.items.find((entry) => entry.label === label);
  if (item.checked !== checked) item.click(item);
}
function focus(checked) {
  const item = cameraMenu().items.find((entry) => entry.label === 'Фокус');
  if (item.checked !== checked) item.click(item);
}

app.on('browser-window-created', (_event, win) => {
  let layouts = 0;
  let blockingNativeAnimations = 0;
  let visibleMs = null;
  win.once('show', () => {
    visibleMs = Math.round(performance.now() - startedAt);
    void win.webContents.capturePage().then((image) => {
      fs.writeFileSync(path.join(profile, 'camera-starting.png'), image.toPNG());
    });
  });
  const setBounds = win.setBounds.bind(win);
  win.setBounds = (...args) => { layouts++; if (args[1]) blockingNativeAnimations++; return setBounds(...args); };
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const metrics = () => evaluate(`(() => {
        const rect = (id) => {
          const { x, y, width, height } = document.getElementById(id).getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          camera: rect('circle'), video: rect('cam'),
          radius: getComputedStyle(document.getElementById('circle')).borderRadius,
          shadow: getComputedStyle(document.getElementById('cameraShell'), '::before').opacity,
          error: !document.getElementById('err').hidden,
          ready: document.getElementById('cam').readyState >= 2,
        };
      })()`);
      for (let i = 0; i < 120; i++) {
        const state = await metrics();
        if (state.error) throw new Error(await evaluate("document.getElementById('errText').textContent"));
        if (state.ready && win.isVisible()) break;
        await delay(50);
      }
      assert.equal(await evaluate("document.querySelector('.loading, .loading-spinner')"), null);
      const initial = await metrics();
      assert.equal(initial.ready, true);
      assert.equal(win.isVisible(), true);
      const startupMs = Math.round(performance.now() - startedAt);
      assert.ok(visibleMs < startupMs - 1000, `Shell waited for camera: shell=${visibleMs}ms, video=${startupMs}ms`);
      // Exercise the live video layer at Full HD, not only the compact
      // camera's low-resolution startup tier.
      const captureSettings = await evaluate(`(async () => {
        const track = document.getElementById('cam').srcObject.getVideoTracks()[0];
        await track.applyConstraints({ width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { ideal: 30, max: 30 } });
        const { width, height, frameRate } = track.getSettings();
        return { width, height, frameRate };
      })()`);
      assert.equal(captureSettings.width, 1920);
      assert.equal(captureSettings.height, 1080);
      const motionStats = [];
      const recordMotion = async (label, action) => {
        await evaluate(`window.__motion = []; requestAnimationFrame(function sample(now) {
          const rect = document.getElementById('circle').getBoundingClientRect();
          window.__motion.push({ time: now, x: window.screenX + rect.x, y: window.screenY + rect.y, width: rect.width, height: rect.height });
          if (now - window.__motion[0].time < 650) requestAnimationFrame(sample);
        });`);
        action();
        await delay(750);
        const frames = await evaluate('window.__motion');
        fs.writeFileSync(path.join(profile, `${label}.json`), JSON.stringify(frames));
        const start = frames[0];
        const end = frames.at(-1);
        let maxStep = 0;
        let backwards = 0;
        for (const key of ['x', 'y', 'width', 'height']) {
          const distance = end[key] - start[key];
          if (Math.abs(distance) < 10) continue;
          for (let i = 1; i < frames.length; i++) {
            const step = (frames[i][key] - frames[i - 1][key]) / distance;
            maxStep = Math.max(maxStep, step);
            if (step < -2 / Math.abs(distance)) backwards++;
          }
        }
        const stats = { label, frames: frames.length, distinctSizes: new Set(frames.map((frame) => frame.width)).size, maxStep: Number(maxStep.toFixed(3)), backwards };
        motionStats.push(stats);
        assert.ok(stats.distinctSizes >= 8 && stats.maxStep < 0.18 && !backwards, `Camera jumps: ${JSON.stringify(stats)}`);
      };
      await recordMotion('resize-grow', () => click('Размер', 'Большой'));
      await recordMotion('resize-shrink', () => click('Размер', 'Компактный'));
      await recordMotion('focus-enter', () => focus(true));
      await recordMotion('focus-leave', () => focus(false));
      const scenarios = [];
      for (const shape of ['Круг', 'Прямоугольник']) {
        click('Форма', shape);
        for (const ratio of shape === 'Круг' ? ['1:1'] : ['1:1', '4:5', '9:16']) {
          if (shape !== 'Круг') click('Соотношение сторон', ratio);
          for (const size of ['Компактный', 'Обычный', 'Большой']) {
            click('Размер', size);
            await delay(380);
            const before = await metrics();
            const nativeBefore = win.getBounds();
            const previousLayouts = layouts;
            for (let i = 0; i < 20; i++) {
              toggle('Тень', i % 2 === 0);
              toggle('Контур', i % 2 === 0);
            }
            await delay(230);
            if (process.platform === 'darwin') assert.equal(win.hasShadow(), false);
            const after = await metrics();
            assert.deepEqual(after.camera, before.camera);
            assert.deepEqual(after.video, before.video);
            assert.deepEqual(win.getBounds(), nativeBefore);
            assert.equal(layouts, previousLayouts);
            assert.equal(after.shadow, '0');
            const [a, b] = ratio.split(':').map(Number);
            assert.ok(Math.abs(after.camera.width - after.camera.height * a / b) <= 1);
            if (shape === 'Прямоугольник') assert.notEqual(after.radius, '50%');
            focus(true);
            await delay(380);
            focus(false);
            await delay(380);
            assert.deepEqual(win.getBounds(), nativeBefore);
            scenarios.push(`${shape} ${ratio} ${size}`);
          }
        }
      }
      toggle('Тень', true);
      toggle('Контур', true);
      await delay(380);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(profile, 'portrait.png'), image.toPNG());
      click('Форма', 'Круг');
      click('Размер', 'Обычный');
      await delay(380);
      fs.writeFileSync(path.join(profile, 'circle.png'), (await win.webContents.capturePage()).toPNG());
      // Exercise the real move IPC and settling animation at an outer edge.
      click('Размер', 'Компактный');
      await delay(380);
      const outerDisplay = screen.getAllDisplays().reduce((left, item) => item.bounds.x < left.bounds.x ? item : left);
      const area = outerDisplay.workArea;
      await evaluate(`window.electronAPI.moveWindow(${JSON.stringify({ x: area.x - 100, y: area.y + Math.round((area.height - win.getBounds().height) / 2) })})`);
      await delay(30);
      const elasticX = win.getBounds().x;
      assert.ok(elasticX >= area.x + 2 && elasticX < area.x + 24);
      await evaluate('window.electronAPI.finishMove()');
      const releasedX = win.getBounds().x;
      assert.ok(Math.abs(releasedX - elasticX) <= 1, 'Release teleported before the animation started');
      await delay(70);
      assert.ok(win.getBounds().x > elasticX, 'Return animation did not start');
      await delay(260);
      assert.equal(win.getBounds().x, area.x + 24);
      assert.equal(win.hasShadow(), process.platform === 'darwin');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ result: 'PASS', visibleMs, startupMs, blockingNativeAnimations, captureSettings, motionStats, scenarios: scenarios.length, shadowToggles: scenarios.length * 20, profile, layouts }));
      clearTimeout(watchdog);
      app.quit();
    })().catch((error) => {
      console.error(error);
      clearTimeout(watchdog);
      app.exit(1);
    });
  });
});
require('../main');

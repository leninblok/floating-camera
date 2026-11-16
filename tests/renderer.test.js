const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = () => new Promise((resolve) => setImmediate(resolve));

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) || new Set();
    list.add(fn);
    this.listeners.set(name, list);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, props = {}) { return Promise.all([...(this.listeners.get(name) || [])].map((fn) => fn(props))); }
}

function element() {
  const item = new Target();
  const classes = new Set();
  item.classList = { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: (name) => classes.has(name) };
  item.style = { setProperty: (name, value) => { item.style[name] = value; } };
  const captures = new Set();
  item.setPointerCapture = (id) => captures.add(id);
  item.hasPointerCapture = (id) => captures.has(id);
  item.releasePointerCapture = (id) => captures.delete(id);
  return item;
}

function stream(id) {
  const track = new Target();
  Object.assign(track, {
    id, stopped: false, constraints: [],
    stop() { this.stopped = true; },
    async applyConstraints(value) { this.constraints.push(value); },
  });
  return { id, track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function harness({ autoFrame = true, selectedDeviceId = null, boundsPromise = null, layoutStep = async () => false } = {}) {
  const elements = Object.fromEntries(['cam', 'circle', 'cameraShell', 'err', 'errText', 'retryButton', 'privacyButton'].map((id) => [id, element()]));
  elements.err.hidden = true;
  const video = elements.cam;
  const frames = new Map();
  let frameId = 0;
  video.requestVideoFrameCallback = (fn) => { frames.set(++frameId, fn); return frameId; };
  video.cancelVideoFrameCallback = (id) => frames.delete(id);
  const deliverFrame = () => { for (const [id, fn] of frames) { frames.delete(id); fn(); } };
  video.play = async () => { if (autoFrame) queueMicrotask(deliverFrame); };
  const rafs = new Map();
  const timers = new Map();
  let id = 0;
  const handlers = {};
  const moves = [];
  const requests = [];
  const selected = [];
  const layoutSteps = [];
  let finishedMoves = 0;
  let reveals = 0;
  const api = {
    stepLayout: (id, timestamp) => { layoutSteps.push({ id, timestamp }); return layoutStep(id, timestamp); },
    markStartup: () => {},
    getInitialState: async () => ({ borderEnabled: true, shadowEnabled: true, mirrorEnabled: false, shapeMode: 'circle', aspectRatio: '4:5', cameraDeviceId: selectedDeviceId }),
    getBounds: () => boundsPromise || Promise.resolve({ x: 100, y: 100, width: 338, height: 338 }),
    ensureCameraAccess: async () => ({ granted: true }),
    revealWindow: async () => { reveals++; },
    syncCameraDevices: async () => {},
    setCameraDeviceId: async (value) => { selected.push(value); },
    moveWindow: (position) => moves.push(position),
    finishMove: async () => { finishedMoves++; },
    toggleFocus: async () => {},
  };
  for (const name of ['AnimateLayout', 'CancelLayout', 'SetMirror', 'SetBorder', 'SetShadow', 'SizeChanged', 'SetShape', 'SetFocus', 'SetCameraDevice']) {
    api[`on${name}`] = (fn) => { handlers[name] = fn; };
  }
  const media = new Target();
  media.enumerateDevices = async () => ['a', 'b', 'c'].map((deviceId) => ({ kind: 'videoinput', deviceId, label: deviceId }));
  media.getUserMedia = (constraints) => new Promise((resolve, reject) => requests.push({ constraints, resolve, reject }));
  const window = Object.assign(new Target(), { electronAPI: api, innerWidth: 338, innerHeight: 338, devicePixelRatio: 1 });
  let observerCallback;
  const context = vm.createContext({
    window, document: { getElementById: (id) => elements[id], body: element() }, navigator: { mediaDevices: media },
    AbortController, DOMException, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    ResizeObserver: class { constructor(fn) { observerCallback = fn; } observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (value) => timers.delete(value),
    requestAnimationFrame: (fn) => { rafs.set(++id, fn); return id; },
    cancelAnimationFrame: (value) => rafs.delete(value),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8'), context);
  return {
    elements, window, handlers, moves, requests, selected, rafs, frames, timers, media, deliverFrame, layoutSteps,
    finishedMoves: () => finishedMoves, reveals: () => reveals,
    resize: (width, height) => observerCallback([{ contentRect: { width, height } }]),
    flushQuality: async () => {
      for (const [key, timer] of [...timers]) if (timer.ms === 800) { timers.delete(key); timer.fn(); }
      await settle();
    },
    flushRaf: (timestamp = 0) => { for (const [key, fn] of [...rafs]) { rafs.delete(key); fn(timestamp); } },
  };
}

const pointer = (screenX, screenY) => ({ pointerId: 1, button: 0, screenX, screenY });

test('100 pointer events produce one move per frame; release flushes the final position', async () => {
  const h = harness();
  await h.elements.circle.emit('pointerdown', pointer(10, 20));
  for (let i = 0; i < 100; i++) await h.elements.circle.emit('pointermove', pointer(10 + i, 20 + i));
  assert.equal(h.moves.length, 0);
  assert.equal(h.rafs.size, 1);
  h.flushRaf();
  assert.equal(h.moves.length, 1);
  assert.equal(h.moves[0].x, 199);
  await h.elements.circle.emit('pointermove', pointer(200, 200));
  await h.elements.circle.emit('pointerup', pointer(200, 200));
  assert.equal(h.moves.length, 2);
  assert.equal(h.moves[1].x, 290);
  assert.equal(h.rafs.size, 0);
  assert.equal(h.finishedMoves(), 1);
});

test('a click does not trigger monitor fitting; delayed getBounds cannot start a released drag', async () => {
  let resolveBounds;
  const h = harness({ boundsPromise: new Promise((resolve) => { resolveBounds = resolve; }) });
  const down = h.elements.circle.emit('pointerdown', pointer(10, 20));
  await h.elements.circle.emit('pointerup', pointer(10, 20));
  resolveBounds({ x: 0, y: 0, width: 338, height: 338 });
  await down;
  await h.elements.circle.emit('pointermove', pointer(100, 100));
  h.flushRaf();
  assert.equal(h.moves.length, 0);
  assert.equal(h.finishedMoves(), 0);
});

test('shape/focus updates cancel queued pointer movement', async () => {
  const h = harness();
  await h.elements.circle.emit('pointerdown', pointer(10, 20));
  await h.elements.circle.emit('pointermove', pointer(100, 100));
  h.handlers.SetFocus(true);
  h.flushRaf();
  assert.equal(h.moves.length, 0);
  assert.equal(h.elements.circle.classList.contains('locked'), true);
});

test('rapid camera selections discard the pending source and open only the latest device', async () => {
  const h = harness();
  await settle();
  assert.equal(h.requests.length, 1);
  h.handlers.SetCameraDevice('b');
  h.handlers.SetCameraDevice('c');
  const old = stream('a');
  h.requests[0].resolve(old);
  await settle();
  assert.equal(old.track.stopped, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].constraints.video.deviceId.exact, 'c');
  const latest = stream('c');
  h.requests[1].resolve(latest);
  await settle();
  assert.equal(h.elements.cam.srcObject, latest);
  assert.equal(h.reveals(), 1);
  assert.equal(h.elements.err.hidden, true);
  assert.equal(h.frames.size, 0);
});

test('changing source while waiting for a frame cancels the obsolete callback', async () => {
  const h = harness({ autoFrame: false });
  await settle();
  const old = stream('a');
  h.requests[0].resolve(old);
  await settle();
  assert.equal(h.frames.size, 1);
  h.handlers.SetCameraDevice('b');
  await settle();
  assert.equal(h.frames.size, 0);
  assert.equal(old.track.stopped, true);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(stream('b'));
  await settle();
  h.deliverFrame();
  await settle();
  assert.equal(h.reveals(), 1);
});

test('missing saved camera falls back to the automatic source', async () => {
  const h = harness({ selectedDeviceId: 'missing-usb-camera' });
  await settle();
  h.requests[0].reject(new DOMException('Device is absent', 'OverconstrainedError'));
  await settle();
  assert.deepEqual(h.selected, [null]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].constraints.video.deviceId, undefined);
  h.requests[1].resolve(stream('a'));
  await settle();
  assert.equal(h.elements.err.hidden, true);
  assert.equal(h.reveals(), 1);
});

test('unloading stops a stream that arrives after the window has been closed', async () => {
  const h = harness();
  await settle();
  await h.window.emit('beforeunload');
  const late = stream('a');
  h.requests[0].resolve(late);
  await settle();
  assert.equal(late.track.stopped, true);
  assert.equal(h.reveals(), 1);
});

test('capture uses 30fps cap and debounced tiers; decoration toggles do not renegotiate', async () => {
  const h = harness();
  await settle();
  assert.equal(h.requests[0].constraints.video.width.ideal, 640);
  assert.equal(h.requests[0].constraints.video.frameRate.max, 30);
  const current = stream('a');
  h.requests[0].resolve(current);
  await settle();
  for (let i = 0; i < 50; i++) {
    h.handlers.SetShadow(i % 2 === 0);
    h.handlers.SetBorder(i % 2 === 0);
  }
  await h.flushQuality();
  assert.equal(current.track.constraints.length, 0);
  h.resize(1000, 1000);
  h.resize(500, 500);
  h.resize(510, 510);
  await h.flushQuality();
  assert.equal(current.track.constraints.length, 1);
  assert.equal(current.track.constraints[0].width.ideal, 1280);
  assert.equal(h.requests.length, 1);
  h.resize(520, 520);
  await h.flushQuality();
  assert.equal(current.track.constraints.length, 1);
});

test('frame timeout releases the camera and displays a recoverable error', async () => {
  const h = harness({ autoFrame: false });
  await settle();
  const current = stream('a');
  h.requests[0].resolve(current);
  await settle();
  for (const [key, timer] of [...h.timers]) if (timer.ms === 8000) { h.timers.delete(key); timer.fn(); }
  await settle();
  assert.equal(current.track.stopped, true);
  assert.equal(h.frames.size, 0);
  assert.equal(h.elements.err.hidden, false);
  assert.match(h.elements.errText.textContent, /не передала изображение/);
});


test('startup reveals the saved shell before a slow camera produces a stream', async () => {
  const h = harness({ autoFrame: false });
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.reveals(), 1);
  assert.equal(h.elements.cam.srcObject, null);
  const current = stream('a');
  h.requests[0].resolve(current);
  await settle();
  assert.equal(h.frames.size, 1);
  h.elements.cam.readyState = 2;
  h.elements.cam.videoWidth = 640;
  await h.elements.cam.emit('loadeddata');
  await settle();
  assert.equal(h.frames.size, 0);
  assert.equal(h.reveals(), 1);
  assert.equal(h.elements.err.hidden, true);
});

test('already decoded video starts without waiting for another compositor callback', async () => {
  const h = harness({ autoFrame: false });
  await settle();
  h.elements.cam.readyState = 2;
  h.elements.cam.videoWidth = 640;
  h.requests[0].resolve(stream('a'));
  await settle();
  assert.equal(h.frames.size, 0);
  assert.equal(h.elements.err.hidden, true);
  assert.equal(h.reveals(), 1);
});


test('resize steps have backpressure and retargeting never queues an obsolete frame', async () => {
  const replies = [];
  const h = harness({ layoutStep: () => new Promise((resolve) => replies.push(resolve)) });
  h.handlers.AnimateLayout(1);
  h.flushRaf(0);
  for (let i = 1; i < 20; i++) h.flushRaf(i * 8.3);
  assert.equal(h.layoutSteps.length, 1);
  h.handlers.AnimateLayout(2);
  replies[0](true);
  await settle();
  assert.equal(h.rafs.size, 1);
  h.flushRaf(180);
  assert.equal(h.layoutSteps.length, 2);
  assert.equal(h.layoutSteps[1].id, 2);
  replies[1](false);
  await settle();
  assert.equal(h.rafs.size, 0);
});

test('camera format negotiation waits until the layout and drag have finished', async () => {
  const h = harness({ layoutStep: async () => true });
  await settle();
  const current = stream('a');
  h.requests[0].resolve(current);
  await settle();
  h.handlers.AnimateLayout(1);
  h.resize(900, 900);
  await h.flushQuality();
  assert.equal(current.track.constraints.length, 0);
  h.handlers.CancelLayout(1);
  await h.elements.circle.emit('pointerdown', pointer(10, 20));
  h.resize(950, 950);
  await h.flushQuality();
  assert.equal(current.track.constraints.length, 0);
  await h.elements.circle.emit('pointerup', pointer(10, 20));
  await h.flushQuality();
  assert.equal(current.track.constraints.length, 1);
});

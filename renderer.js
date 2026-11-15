(() => {
  const video = document.getElementById('cam');
  const circle = document.getElementById('circle');
  const errBox = document.getElementById('err');
  const errText = document.getElementById('errText');
  const retryButton = document.getElementById('retryButton');
  const privacyButton = document.getElementById('privacyButton');

  const DURATION = 200;
  let enlarged = false;
  let focusTransitioning = false;
  let prevBounds = null;
  let isDragging = false;
  let activePointerId = null;
  let dragRequestId = 0;
  let dragStartMouse = null;
  let dragStartWindow = null;
  let borderEnabled = true;
  let shadowEnabled = true;
  let mirrorEnabled = false;
  let shapeMode = 'circle';
  let aspectRatio = '4:5';
  let activeStream = null;
  let selectedDeviceId = null;
  let cameraStarting = false;

  // The radius must always be tied to the actual short side of the rendered
  // camera, not to its height. Native macOS window animations can temporarily
  // give CSS container units an outdated value; an explicit pixel value keeps
  // a tall 9:16 camera a soft rectangle instead of a capsule.
  const CORNER_RADIUS_FRACTIONS = {
    '1:1': 0.286,
    '4:5': 0.22,
    '9:16': 0.16,
  };

  function isInteractiveTarget(target) {
    return Boolean(target?.closest?.('button, input, select, textarea, label, a'));
  }

  function showError(message, canOpenPrivacy = false) {
    errText.textContent = message;
    privacyButton.hidden = !canOpenPrivacy;
    errBox.hidden = false;
    // On failure there may be no camera frame to trigger the normal reveal,
    // but the user still needs to see the recovery controls.
    void window.electronAPI.revealWindow();
  }

  function hideError() {
    errBox.hidden = true;
    errText.textContent = '';
  }

  function stopCamera() {
    if (activeStream) activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
    if (video) video.srcObject = null;
  }

  function waitForFirstVideoFrame(timeoutMs = 8000) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      let timeoutId = null;
      const finish = (error = null) => {
        if (finished) return;
        finished = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('playing', onReady);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) finish();
      };

      video.addEventListener('loadeddata', onReady);
      video.addEventListener('playing', onReady);
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish());
      }
      timeoutId = window.setTimeout(() => {
        finish(new Error('Камера не передала изображение.'));
      }, timeoutMs);
    });
  }

  function applyBorderForSide(side) {
    if (!circle || !Number.isFinite(side)) return;
    circle.style.borderWidth = borderEnabled ? (side >= 350 ? '4px' : side >= 250 ? '3px' : '2px') : '0px';
  }

  function applyMirror() {
    video.classList.toggle('mirror', mirrorEnabled);
  }

  function applyShadow() {
    document.body.classList.toggle('shadow-enabled', shadowEnabled);
    requestAnimationFrame(applyCornerRadius);
  }

  function applyCornerRadius() {
    if (!circle) return;
    if (shapeMode !== 'rectangle') {
      circle.style.borderRadius = '50%';
      return;
    }
    const bounds = circle.getBoundingClientRect();
    const shortSide = Math.min(bounds.width, bounds.height);
    if (!Number.isFinite(shortSide) || shortSide <= 0) return;
    const fraction = CORNER_RADIUS_FRACTIONS[aspectRatio] || CORNER_RADIUS_FRACTIONS['4:5'];
    // Use the property itself rather than a CSS custom-property fallback.
    // That makes the intended rectangle win even if an older Chromium frame
    // has cached the base 50% rule while macOS changes window bounds.
    circle.style.borderRadius = `${Math.round(shortSide * fraction)}px`;
  }

  function applyShape() {
    circle.classList.toggle('rectangle', shapeMode === 'rectangle');
    circle.dataset.aspectRatio = aspectRatio;
    requestAnimationFrame(applyCornerRadius);
  }

  function resetFocusForManualSize(side) {
    enlarged = false;
    focusTransitioning = false;
    prevBounds = null;
    circle.classList.remove('locked');
    applyBorderForSide(side);
  }

  function cancelDrag() {
    // `getBounds()` is asynchronous. A double-click can finish before the
    // pointer-down handler receives its result, so invalidate any pending
    // request as well as an active drag. Without this, that stale handler can
    // start dragging after the camera has already entered focus mode.
    dragRequestId += 1;
    activePointerId = null;
    isDragging = false;
    dragStartMouse = null;
    dragStartWindow = null;
  }

  async function refreshCameraDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    const found = devices.some((device) => device.deviceId === selectedDeviceId);
    if (selectedDeviceId && !found) {
      selectedDeviceId = null;
      await window.electronAPI.setCameraDeviceId(null);
    }
    await window.electronAPI.syncCameraDevices(devices.map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Камера ${index + 1}`,
    })));
  }

  async function startCamera() {
    if (cameraStarting) return;
    cameraStarting = true;
    hideError();
    try {
      const access = await window.electronAPI.ensureCameraAccess();
      if (!access?.granted) {
        showError(access?.message || 'Нет доступа к камере.', true);
        return;
      }
      stopCamera();
      const videoConstraints = selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        : { facingMode: { ideal: 'user' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      video.srcObject = activeStream;
      await video.play();
      await waitForFirstVideoFrame();
      // Do not reveal a temporary black default state. At this moment both
      // the stored appearance and the first actual camera frame are ready.
      await window.electronAPI.revealWindow();
      await refreshCameraDevices();
      hideError();
    } catch (error) {
      const detail = error?.name === 'NotAllowedError'
        ? 'Доступ к камере запрещён. Разрешите его в настройках macOS и перезапустите приложение.'
        : error?.name === 'NotFoundError'
          ? 'Камера не найдена. Подключите камеру или выберите другую через меню «Источник».'
          : `Не удалось включить камеру: ${error?.message || 'неизвестная ошибка'}`;
      showError(detail, error?.name === 'NotAllowedError');
    } finally {
      cameraStarting = false;
    }
  }

  function easeInOutCubic(value) {
    return value < 0.5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
  }

  function animateBounds(start, end, duration = DURATION) {
    if (!start || !end) return Promise.resolve();
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / Math.max(1, duration));
        const eased = easeInOutCubic(progress);
        const width = Math.round(start.width + (end.width - start.width) * eased);
        const height = Math.round(start.height + (end.height - start.height) * eased);
        window.electronAPI.setBounds({
          x: Math.round(start.x + (end.x - start.x) * eased),
          y: Math.round(start.y + (end.y - start.y) * eased),
          width,
          height,
        });
        applyBorderForSide(Math.min(width, height));
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function setFocus(enabled) {
    if (enabled === enlarged || focusTransitioning) return;
    focusTransitioning = true;
    // Block dragging from the very first frame of the transition, not only
    // once its destination bounds have been calculated.
    cancelDrag();
    try {
      if (enabled) {
        const start = await window.electronAPI.getBounds();
        const end = await window.electronAPI.getFocusBounds();
        prevBounds = start;
        circle.classList.add('locked');
        await animateBounds(start, end);
        enlarged = true;
        applyBorderForSide(750);
        await window.electronAPI.setFocusEnabled(true);
        return;
      }
      const start = await window.electronAPI.getBounds();
      const end = prevBounds || await window.electronAPI.getCenteredBounds(250);
      await animateBounds(start, end);
      circle.classList.remove('locked');
      enlarged = false;
      applyBorderForSide(Math.min(end.width, end.height));
      await window.electronAPI.setFocusEnabled(false);
    } finally {
      focusTransitioning = false;
    }
  }

  function toggleFocus() {
    return setFocus(!enlarged);
  }

  circle.addEventListener('dblclick', (event) => {
    if (!isInteractiveTarget(event.target)) toggleFocus().catch(() => {});
  });
  circle.addEventListener('pointerdown', async (event) => {
    if (enlarged || focusTransitioning || event.button !== 0 || isInteractiveTarget(event.target)) return;
    const requestId = ++dragRequestId;
    activePointerId = event.pointerId;
    const bounds = await window.electronAPI.getBounds();
    // Never begin a drag after the button has been released or after focus
    // mode has started. This is especially important for the second click of
    // a double-click, whose IPC response can arrive after `pointerup`.
    if (!bounds
      || requestId !== dragRequestId
      || activePointerId !== event.pointerId
      || enlarged
      || focusTransitioning
      || circle.classList.contains('locked')) return;
    isDragging = true;
    dragStartMouse = { x: event.screenX, y: event.screenY };
    dragStartWindow = bounds;
    circle.setPointerCapture?.(event.pointerId);
  });
  circle.addEventListener('pointermove', (event) => {
    if (!isDragging || !dragStartMouse || !dragStartWindow) return;
    window.electronAPI.setBounds({
      x: Math.round(dragStartWindow.x + event.screenX - dragStartMouse.x),
      y: Math.round(dragStartWindow.y + event.screenY - dragStartMouse.y),
      width: dragStartWindow.width,
      height: dragStartWindow.height,
    });
  });
  const endDrag = (event) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const didDrag = isDragging;
    cancelDrag();
    try { circle.releasePointerCapture?.(event.pointerId); } catch (_) {}
    if (didDrag) window.electronAPI.finishMove().catch(() => {});
  };
  circle.addEventListener('pointerup', endDrag);
  circle.addEventListener('pointercancel', endDrag);

  retryButton.addEventListener('click', startCamera);
  privacyButton.addEventListener('click', () => window.electronAPI.openCameraPrivacySettings());
  window.addEventListener('beforeunload', stopCamera);

  window.electronAPI.onSetMirror((enabled) => {
    mirrorEnabled = enabled;
    applyMirror();
  });
  window.electronAPI.onSetBorder(async (enabled) => {
    borderEnabled = enabled;
    const bounds = await window.electronAPI.getBounds();
    if (bounds) applyBorderForSide(Math.min(bounds.width, bounds.height));
  });
  window.electronAPI.onSetShadow((enabled) => {
    shadowEnabled = enabled;
    applyShadow();
  });
  window.electronAPI.onSizeChanged((size) => {
    if (Number.isFinite(size)) resetFocusForManualSize(size);
  });
  window.electronAPI.onSetShape((shape) => {
    shapeMode = shape.shapeMode;
    aspectRatio = shape.aspectRatio;
    applyShape();
  });
  window.electronAPI.onSetFocus((enabled) => {
    setFocus(enabled).catch(() => {});
  });
  window.electronAPI.onSetCameraDevice((deviceId) => {
    selectedDeviceId = deviceId;
    startCamera();
  });

  const cornerResizeObserver = new ResizeObserver(() => applyCornerRadius());
  cornerResizeObserver.observe(circle);

  (async () => {
    // Fetch everything in one IPC round trip while the hidden window warms
    // up. It shortens startup and makes the first visible frame final rather
    // than a sequence of circle/border/shadow corrections.
    const initialState = await window.electronAPI.getInitialState();
    borderEnabled = Boolean(initialState?.borderEnabled);
    shadowEnabled = Boolean(initialState?.shadowEnabled);
    mirrorEnabled = Boolean(initialState?.mirrorEnabled);
    shapeMode = initialState?.shapeMode === 'rectangle' ? 'rectangle' : 'circle';
    aspectRatio = typeof initialState?.aspectRatio === 'string' ? initialState.aspectRatio : '4:5';
    applyShape();
    selectedDeviceId = typeof initialState?.cameraDeviceId === 'string' ? initialState.cameraDeviceId : null;
    applyMirror();
    applyShadow();
    const bounds = await window.electronAPI.getBounds();
    if (bounds) applyBorderForSide(Math.min(bounds.width, bounds.height));
    await startCamera();
  })().catch((error) => showError(`Ошибка запуска: ${error?.message || error}`));
})();

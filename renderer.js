(() => {
  const video = document.getElementById('cam');
  const circle = document.getElementById('circle');
  const errBox = document.getElementById('err');
  const errText = document.getElementById('errText');
  const retryButton = document.getElementById('retryButton');
  const privacyButton = document.getElementById('privacyButton');

  const DURATION = 200;
  let enlarged = false;
  let prevBounds = null;
  let isDragging = false;
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

  function isInteractiveTarget(target) {
    return Boolean(target?.closest?.('button, input, select, textarea, label, a'));
  }

  function showError(message, canOpenPrivacy = false) {
    errText.textContent = message;
    privacyButton.hidden = !canOpenPrivacy;
    errBox.hidden = false;
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

  function applyBorderForSide(side) {
    if (!circle || !Number.isFinite(side)) return;
    circle.style.borderWidth = borderEnabled ? (side >= 350 ? '4px' : side >= 250 ? '3px' : '2px') : '0px';
  }

  function applyMirror() {
    video.classList.toggle('mirror', mirrorEnabled);
  }

  function applyShadow() {
    document.body.classList.toggle('shadow-enabled', shadowEnabled);
  }

  function applyShape() {
    circle.classList.toggle('rectangle', shapeMode === 'rectangle');
    circle.dataset.aspectRatio = aspectRatio;
  }

  function resetFocusForManualSize(side) {
    enlarged = false;
    prevBounds = null;
    circle.classList.remove('locked');
    applyBorderForSide(side);
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
    if (enabled === enlarged) return;
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
  }

  function toggleFocus() {
    return setFocus(!enlarged);
  }

  circle.addEventListener('dblclick', (event) => {
    if (!isInteractiveTarget(event.target)) toggleFocus().catch(() => {});
  });
  circle.addEventListener('pointerdown', async (event) => {
    if (enlarged || event.button !== 0 || isInteractiveTarget(event.target)) return;
    const bounds = await window.electronAPI.getBounds();
    if (!bounds) return;
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
    isDragging = false;
    dragStartMouse = null;
    dragStartWindow = null;
    try { circle.releasePointerCapture?.(event.pointerId); } catch (_) {}
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

  (async () => {
    borderEnabled = await window.electronAPI.getBorderEnabled();
    shadowEnabled = await window.electronAPI.getShadowEnabled();
    mirrorEnabled = await window.electronAPI.getMirrorEnabled();
    ({ shapeMode, aspectRatio } = await window.electronAPI.getShape());
    applyShape();
    selectedDeviceId = await window.electronAPI.getCameraDeviceId();
    applyMirror();
    applyShadow();
    const bounds = await window.electronAPI.getBounds();
    if (bounds) applyBorderForSide(Math.min(bounds.width, bounds.height));
    await startCamera();
  })().catch((error) => showError(`Ошибка запуска: ${error?.message || error}`));
})();

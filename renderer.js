(() => {
  const video = document.getElementById('cam');
  const closeBtn = document.getElementById('close');
  const circle = document.getElementById('circle');
  const errBox = document.getElementById('err');
  
  let enlarged = false;
  let prevBounds = null; // { x, y, width, height }
  const DURATION = 200; // ms
  let isDragging = false;
  let dragStartMouse = null; // { x, y }
  let dragStartWin = null;   // { x, y, width, height }
  let borderEnabled = true;

  async function startCamera() {
    try {
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'user' }, // prefer front camera
          width: { ideal: 640 },
          height: { ideal: 640 },
          frameRate: { ideal: 30 }
        }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      hideError();
    } catch (err) {
      showError('Не удалось получить доступ к камере. Проверьте разрешения в системе. ' + String(err && err.message ? err.message : err));
    }
  }

  function showError(msg) {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.style.display = 'block';
  }

  function hideError() {
    if (!errBox) return;
    errBox.textContent = '';
    errBox.style.display = 'none';
  }

  function applyBorderForSide(side) {
    if (!circle || !Number.isFinite(side)) return;
    if (!borderEnabled) {
      circle.style.borderWidth = '0px';
      circle.style.borderStyle = 'solid';
      return;
    }
    let w = '1px';
    if (side >= 450) w = '2px';
    else if (side >= 250) w = '1px';
    circle.style.borderWidth = w;
    circle.style.borderStyle = 'solid';
  }

  // Close app
  closeBtn?.addEventListener('click', () => {
    window.electronAPI?.closeApp?.();
  });
  // Avoid bubbling clicks on close to circle dblclick
  closeBtn?.addEventListener('dblclick', (e) => e.stopPropagation());

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function animateBounds(start, end, duration = DURATION) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        const p = Math.min(1, (now - t0) / Math.max(1, duration));
        const e = easeInOutCubic(p);
        const x = Math.round(start.x + (end.x - start.x) * e);
        const y = Math.round(start.y + (end.y - start.y) * e);
        const w = Math.round(start.width + (end.width - start.width) * e);
        const h = Math.round(start.height + (end.height - start.height) * e);
        window.electronAPI?.setBounds?.({ x, y, width: w, height: h });
        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  // Toggle enlarge on double-click anywhere on circle
  circle?.addEventListener('dblclick', async () => {
    try {
      if (!enlarged) {
        // Save current bounds
        const start = await window.electronAPI?.getBounds?.();
        prevBounds = start;
        // Compute centered target bounds for 750
        const end = await window.electronAPI?.getCenteredBounds?.(750);
        // Lock resizing and dragging, then animate
        await window.electronAPI?.setResizable?.(false);
        circle?.classList.add('locked');
        await animateBounds(start, end, DURATION);
        enlarged = true;
        applyBorderForSide(750);
      } else {
        // Restore to previous position with size 250
        const current = await window.electronAPI?.getBounds?.();
        const end = prevBounds && typeof prevBounds.x === 'number' && typeof prevBounds.y === 'number'
          ? { x: prevBounds.x, y: prevBounds.y, width: prevBounds.width, height: prevBounds.height }
          : await window.electronAPI?.getCenteredBounds?.(250);
        await animateBounds(current, end, DURATION);
        circle?.classList.remove('locked');
        await window.electronAPI?.setResizable?.(true);
        enlarged = false;
        const restoredSide = end && end.width ? Math.min(end.width, end.height) : 250;
        applyBorderForSide(restoredSide);
      }
    } catch (_) { /* noop */ }
  });

  // Custom dragging over the full circle (disabled when enlarged)
  circle?.addEventListener('pointerdown', async (e) => {
    if (enlarged) return; // locked while enlarged
    // ignore right/middle clicks
    if (e.button !== 0) return;
    try {
      const b = await window.electronAPI?.getBounds?.();
      isDragging = true;
      dragStartMouse = { x: e.screenX, y: e.screenY };
      dragStartWin = { x: b.x, y: b.y, width: b.width, height: b.height };
      circle.style.cursor = 'default';
      circle.setPointerCapture?.(e.pointerId);
    } catch (_) {}
  });

  circle?.addEventListener('pointermove', (e) => {
    if (!isDragging || !dragStartMouse || !dragStartWin) return;
    const dx = e.screenX - dragStartMouse.x;
    const dy = e.screenY - dragStartMouse.y;
    const nx = Math.round(dragStartWin.x + dx);
    const ny = Math.round(dragStartWin.y + dy);
    window.electronAPI?.setBounds?.({ x: nx, y: ny, width: dragStartWin.width, height: dragStartWin.height });
  });

  const endDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    dragStartMouse = null;
    dragStartWin = null;
    circle.style.cursor = '';
    try { circle.releasePointerCapture?.(e.pointerId); } catch (_) {}
  };

  circle?.addEventListener('pointerup', endDrag);
  circle?.addEventListener('pointercancel', endDrag);

  const SIZE_PRESETS = [150, 250, 350, 450, 550];
  window.addEventListener('keydown', async (e) => {
    if (e.code === 'KeyB') {
      try {
        borderEnabled = !borderEnabled;
        await window.electronAPI?.setBorderEnabled?.(borderEnabled);
        const b = await window.electronAPI?.getBounds?.();
        if (b) applyBorderForSide(Math.min(b.width, b.height));
      } catch (_) {}
      return;
    }
    if (e.code !== 'KeyS') return;
    if (enlarged) return;
    try {
      const b = await window.electronAPI?.getBounds?.();
      if (!b) return;
      const side = Math.min(b.width, b.height);
      const exactIndex = SIZE_PRESETS.indexOf(side);
      if (exactIndex === -1) {
        let nearest = SIZE_PRESETS[0];
        let minDiff = Math.abs(SIZE_PRESETS[0] - side);
        for (let i = 1; i < SIZE_PRESETS.length; i++) {
          const d = Math.abs(SIZE_PRESETS[i] - side);
          if (d < minDiff) { minDiff = d; nearest = SIZE_PRESETS[i]; }
        }
        await window.electronAPI?.setBounds?.({ x: b.x, y: b.y, width: nearest, height: nearest });
        applyBorderForSide(nearest);
        return;
      }
      const next = SIZE_PRESETS[(exactIndex + 1) % SIZE_PRESETS.length];
      await window.electronAPI?.setBounds?.({ x: b.x, y: b.y, width: next, height: next });
      applyBorderForSide(next);
    } catch (_) {}
  });

  // Start immediately
  startCamera();
  (async () => {
    try {
      const stored = await window.electronAPI?.getBorderEnabled?.();
      if (typeof stored === 'boolean') borderEnabled = stored;
      const b = await window.electronAPI?.getBounds?.();
      if (b) applyBorderForSide(Math.min(b.width, b.height));
    } catch (_) {}
  })();
})();

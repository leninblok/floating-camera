(() => {
  const video = document.getElementById('cam');
  const closeBtn = document.getElementById('close');
  const circle = document.getElementById('circle');
  const errBox = document.getElementById('err');

  let enlarged = false;
  let prevBounds = null; // { x, y, width, height }

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

  // Close app
  closeBtn?.addEventListener('click', () => {
    window.electronAPI?.closeApp?.();
  });

  // Toggle enlarge on key "S"
  document.addEventListener('keydown', async (e) => {
    if ((e.key || '').toLowerCase() !== 's') return;
    try {
      if (!enlarged) {
        // Save current position and size
        prevBounds = await window.electronAPI?.getBounds?.();
        // Lock resizing and dragging
        await window.electronAPI?.setResizable?.(false);
        circle?.classList.add('locked');
        // Center and enlarge to 1000x1000
        await window.electronAPI?.centerWindow?.(750);
        enlarged = true;
      } else {
        // Restore drag and resizing
        circle?.classList.remove('locked');
        await window.electronAPI?.setResizable?.(true);
        // Restore previous position, set size to 250x250
        if (prevBounds && typeof prevBounds.x === 'number' && typeof prevBounds.y === 'number') {
          await window.electronAPI?.setBounds?.({ x: prevBounds.x, y: prevBounds.y, width: 250, height: 250 });
        } else {
          await window.electronAPI?.setSize?.(250, 250);
        }
        enlarged = false;
      }
    } catch (_) { /* noop */ }
  });

  // Start immediately
  startCamera();
})();

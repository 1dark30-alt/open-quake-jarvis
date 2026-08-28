'use strict';

(function () {
  const params = new URLSearchParams(location.search);
  const readBool = (key, fallback) => {
    const value = params.get(key);
    return value == null ? fallback : value === '1' || value === 'true';
  };
  const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  const numberInRange = (value, minimum, maximum, fallback) => {
    if (value == null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  };
  const settings = {
    intervalMs: numberInRange(params.get('interval'), 3, 3600, 15) * 1000,
    shuffle: params.get('order') === 'shuffle',
    mode: oneOf(params.get('mode'), ['single', 'strip'], 'strip'),
    fit: oneOf(params.get('fit'), ['cover', 'contain'], 'cover'),
    transition: oneOf(params.get('transition'), ['fade', 'slide', 'none'], 'fade'),
    transitionDuration: numberInRange(params.get('transitionDuration'), 0, 2000, 250),
    kenBurns: readBool('kenBurns', false),
    showMetadata: readBool('showMetadata', false),
    dark: readBool('_dark', true),
    accent: params.get('_accent') || '#5ea2ff',
  };

  const byId = id => document.getElementById(id);
  const elements = {
    app: byId('app'),
    singleStage: byId('singleStage'),
    singleCurrent: byId('singleCurrent'),
    singleIncoming: byId('singleIncoming'),
    stripStage: byId('stripStage'),
    stripCards: Array.from(document.querySelectorAll('.strip-card')),
    empty: byId('emptyState'),
    emptyTitle: byId('emptyTitle'),
    emptyMessage: byId('emptyMessage'),
    metadata: byId('metadata'),
    fileName: byId('fileName'),
    photoDate: byId('photoDate'),
    shade: byId('controlShade'),
    controls: byId('controls'),
    previous: byId('previousButton'),
    pause: byId('pauseButton'),
    pauseIcon: byId('pauseIcon'),
    pauseLabel: byId('pauseLabel'),
    next: byId('nextButton'),
    settings: byId('settingsButton'),
    settingsPanel: byId('settingsPanel'),
    settingsSummary: byId('settingsSummary'),
    refresh: byId('refreshButton'),
    closeSettings: byId('closeSettingsButton'),
    toast: byId('toast'),
  };

  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--fit', settings.fit);
  document.documentElement.style.setProperty('--transition-ms', `${settings.transitionDuration}ms`);
  elements.app.classList.toggle('ken-burns', settings.kenBurns && settings.mode === 'single');

  const state = {
    library: null,
    images: [],
    imageCache: new Map(),
    requestControllers: new Set(),
    controlsTimer: null,
    transitionTimer: null,
    toastTimer: null,
    renderToken: 0,
    paused: false,
    settingsOpen: false,
    disposed: false,
  };

  const controller = new PhotoStripSlideshow.SlideshowController({
    intervalMs: settings.intervalMs,
    shuffle: settings.shuffle,
    onChange: renderPhoto,
  });

  function fetchJson(url) {
    const abort = new AbortController();
    state.requestControllers.add(abort);
    return fetch(url, { cache: 'no-store', signal: abort.signal })
      .then(response => response.json())
      .finally(() => state.requestControllers.delete(abort));
  }

  function loadLibrary(refresh) {
    showEmpty('Loading photos…', refresh ? 'Refreshing your photo library.' : 'Scanning your configured folders.');
    const suffix = refresh ? '?refresh=1' : '';
    return fetchJson('/app-api/library' + suffix).then(result => {
      if (!(result && result.ok)) throw new Error((result && result.error) || 'Library scan failed');
      state.library = result;
      state.images = result.images || [];
      state.imageCache.clear();
      updateSettingsSummary();
      if (!state.images.length) {
        renderLibraryState(result);
        controller.setItems([]);
        return;
      }
      hideEmpty();
      controller.setItems(state.images);
      controller.setPaused(state.paused);
      controller.setVisible(!document.hidden && !state.settingsOpen);
    }).catch(error => {
      if (error.name === 'AbortError') return;
      console.error('Photo Strip library error:', error);
      showEmpty('Photos unavailable', 'The library could not be loaded. Open Settings to retry.');
      showToast('Photo library could not be loaded.');
    });
  }

  function renderLibraryState(library) {
    const extra = library.messages && library.messages.length ? ' ' + library.messages.join(' ') : '';
    if (library.status === 'unconfigured') {
      showEmpty('Choose a photo folder', 'Open this page’s App settings in the open-quake editor and use Browse… to select one or more folders.');
    } else if (library.status === 'unavailable') {
      showEmpty('Photo folders unavailable', 'The configured folders may have moved, been deleted, or are not currently accessible.' + extra);
    } else {
      showEmpty('No supported photos found', 'Add JPEG, PNG, WebP, or GIF images to a selected folder.' + extra);
    }
  }

  function showEmpty(title, message) {
    elements.emptyTitle.textContent = title;
    elements.emptyMessage.textContent = message;
    elements.empty.hidden = false;
    elements.singleStage.hidden = true;
    elements.stripStage.hidden = true;
    elements.metadata.hidden = true;
  }

  function hideEmpty() {
    elements.empty.hidden = true;
    elements.singleStage.hidden = settings.mode !== 'single';
    elements.stripStage.hidden = settings.mode !== 'strip';
  }

  function imageData(id) {
    const existing = state.imageCache.get(id);
    if (existing) {
      existing.usedAt = Date.now();
      return existing.promise;
    }
    const record = { usedAt: Date.now(), dataUrl: '', promise: null };
    record.promise = fetchJson('/app-api/image?id=' + encodeURIComponent(id)).then(result => {
      if (!(result && result.ok && result.dataUrl)) throw new Error((result && result.error) || 'Image unavailable');
      record.dataUrl = result.dataUrl;
      return result.dataUrl;
    }).catch(error => {
      state.imageCache.delete(id);
      throw error;
    });
    state.imageCache.set(id, record);
    return record.promise;
  }

  function renderPhoto(index, direction) {
    const item = state.images[index];
    if (!item || state.disposed) return;
    const token = ++state.renderToken;
    updateMetadata(item);
    const offsets = settings.mode === 'strip' ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
    const keepIds = new Set(offsets.map(offset => state.images[controller.relativeIndex(offset)]).filter(Boolean).map(image => image.id));
    const loads = offsets.map(offset => {
      const relativeIndex = controller.relativeIndex(offset);
      const relative = state.images[relativeIndex];
      return relative ? imageData(relative.id).then(dataUrl => ({ offset, item: relative, dataUrl })) : Promise.resolve(null);
    });
    Promise.all(loads).then(loaded => {
      if (token !== state.renderToken || state.disposed) return;
      if (settings.mode === 'single') renderSingle(loaded.find(entry => entry && entry.offset === 0), direction);
      else renderStrip(loaded, direction);
      releaseUnusedImages(keepIds);
    }).catch(() => {
      if (token === state.renderToken) showToast('This photo could not be displayed.');
    });
  }

  function renderSingle(entry, direction) {
    if (!entry) return;
    const first = !elements.singleCurrent.src;
    if (first || settings.transition === 'none' || !direction) {
      elements.singleCurrent.src = entry.dataUrl;
      elements.singleCurrent.alt = entry.item.name;
      elements.singleIncoming.src = '';
      elements.singleIncoming.className = 'single-photo incoming';
      restartKenBurns();
      return;
    }
    clearTimeout(state.transitionTimer);
    elements.singleIncoming.src = entry.dataUrl;
    elements.singleIncoming.alt = entry.item.name;
    elements.singleIncoming.className = `single-photo incoming ready transition-${settings.transition} ${direction < 0 ? 'backward' : 'forward'}`;
    state.transitionTimer = setTimeout(() => {
      elements.singleCurrent.src = entry.dataUrl;
      elements.singleCurrent.alt = entry.item.name;
      elements.singleIncoming.src = '';
      elements.singleIncoming.className = 'single-photo incoming';
      restartKenBurns();
    }, settings.transitionDuration + 30);
  }

  function restartKenBurns() {
    if (!(settings.kenBurns && settings.mode === 'single')) return;
    elements.singleCurrent.style.animation = 'none';
    void elements.singleCurrent.offsetWidth;
    elements.singleCurrent.style.animation = '';
  }

  function renderStrip(loaded, direction) {
    const byOffset = new Map(loaded.filter(Boolean).map(entry => [entry.offset, entry]));
    elements.stripCards.forEach(card => {
      const offset = Number(card.dataset.offset);
      const entry = byOffset.get(offset);
      const image = card.querySelector('img');
      if (!entry) {
        image.removeAttribute('src');
        image.alt = '';
        card.hidden = true;
        return;
      }
      card.hidden = false;
      image.src = entry.dataUrl;
      image.alt = entry.item.name;
    });
    elements.stripStage.classList.remove('step-forward', 'step-backward');
    if (direction) {
      void elements.stripStage.offsetWidth;
      elements.stripStage.classList.add(direction < 0 ? 'step-backward' : 'step-forward');
    }
  }

  function releaseUnusedImages(keepIds) {
    state.imageCache.forEach((record, id) => {
      if (!keepIds.has(id)) state.imageCache.delete(id);
    });
  }

  function updateMetadata(item) {
    if (!settings.showMetadata) {
      elements.metadata.hidden = true;
      return;
    }
    elements.fileName.textContent = item.name;
    const date = new Date(item.date);
    elements.photoDate.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
    elements.metadata.hidden = false;
  }

  function togglePause() {
    state.paused = !state.paused;
    controller.setPaused(state.paused);
    elements.pauseIcon.textContent = state.paused ? '▶' : 'Ⅱ';
    elements.pauseLabel.textContent = state.paused ? 'Play' : 'Pause';
    elements.pause.setAttribute('aria-label', state.paused ? 'Resume slideshow' : 'Pause slideshow');
    showControls();
  }

  function showControls() {
    if (state.settingsOpen) return;
    elements.controls.classList.add('visible');
    elements.shade.classList.add('visible');
    elements.controls.setAttribute('aria-hidden', 'false');
    clearTimeout(state.controlsTimer);
    state.controlsTimer = setTimeout(hideControls, 5000);
  }

  function hideControls() {
    clearTimeout(state.controlsTimer);
    state.controlsTimer = null;
    elements.controls.classList.remove('visible');
    elements.shade.classList.remove('visible');
    elements.controls.setAttribute('aria-hidden', 'true');
  }

  function openSettings() {
    hideControls();
    state.settingsOpen = true;
    controller.setVisible(false);
    updateSettingsSummary();
    elements.settingsPanel.hidden = false;
  }

  function closeSettings() {
    state.settingsOpen = false;
    elements.settingsPanel.hidden = true;
    controller.setVisible(!document.hidden);
    showControls();
  }

  function updateSettingsSummary() {
    const library = state.library;
    const photoCount = library ? library.count : 0;
    const folderCount = library ? library.availableFolders : 0;
    elements.settingsSummary.textContent = `${photoCount.toLocaleString()} photo${photoCount === 1 ? '' : 's'} from ${folderCount} available folder${folderCount === 1 ? '' : 's'} · ${settings.mode === 'strip' ? 'Photo Strip' : 'Single Photo'} · ${settings.shuffle ? 'Shuffle' : 'Sequential'} · ${Math.round(settings.intervalMs / 1000)}s`;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
  }

  function onBackgroundPointer(event) {
    if (event.target.closest('button') || event.target.closest('.settings-panel')) return;
    showControls();
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowRight') { event.preventDefault(); controller.next(); showControls(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); controller.previous(); showControls(); }
    else if (event.key === ' ') { event.preventDefault(); togglePause(); }
    else if (event.key === 'Escape' && state.settingsOpen) closeSettings();
  }

  function onVisibilityChange() {
    controller.setVisible(!document.hidden && !state.settingsOpen);
    if (document.hidden) hideControls();
  }

  function cleanup() {
    if (state.disposed) return;
    state.disposed = true;
    controller.dispose();
    clearTimeout(state.controlsTimer);
    clearTimeout(state.transitionTimer);
    clearTimeout(state.toastTimer);
    state.requestControllers.forEach(abort => abort.abort());
    state.requestControllers.clear();
    state.imageCache.clear();
    elements.singleCurrent.src = '';
    elements.singleIncoming.src = '';
    elements.stripCards.forEach(card => card.querySelector('img').removeAttribute('src'));
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pagehide', cleanup);
  }

  elements.app.addEventListener('pointerup', onBackgroundPointer);
  elements.previous.addEventListener('click', event => { event.stopPropagation(); controller.previous(); showControls(); });
  elements.pause.addEventListener('click', event => { event.stopPropagation(); togglePause(); });
  elements.next.addEventListener('click', event => { event.stopPropagation(); controller.next(); showControls(); });
  elements.settings.addEventListener('click', event => { event.stopPropagation(); openSettings(); });
  elements.closeSettings.addEventListener('click', closeSettings);
  elements.refresh.addEventListener('click', () => loadLibrary(true));
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pagehide', cleanup);

  window.oqKnob = function (event) {
    if (!event || state.settingsOpen) return false;
    if (event.type === 'rotate') {
      if (event.dir < 0) controller.previous(); else controller.next();
      showControls();
      return true;
    }
    if (event.type === 'press' && event.index === 1) { togglePause(); return true; }
    if (event.type === 'press' && event.index === 2) { openSettings(); return true; }
    return false;
  };

  loadLibrary(false);
})();

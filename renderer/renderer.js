(function () {
  const S = window.APP_SETTINGS;
  if (!S) {
    console.error(
      '[renderer] window.APP_SETTINGS is undefined at load time — preload.js ' +
      'did not finish successfully (check the app\'s DevTools Console above ' +
      'this message for the actual preload error).'
    );
  }
  // Fallback keeps module-level state construction from throwing outright
  // if config failed to load; init() logs a clearer error and the UI still
  // becomes minimally interactive rather than a blank dead script.
  const SAFE_S = S || { SENTIMENTS: [], STYLINGS: [], default_styling_map: {}, default_sensitivity: 0.5 };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    filePath: null,
    mediaKind: null,            // 'audio' | 'video'
    mediaEl: null,              // <video> or <audio> element currently in use
    analysis: null,             // full backend analyze.py result
    guid: null,
    savedPath: null,

    // Active (saved) styling configuration
    config: {
      stylingMap: Object.assign({}, SAFE_S.default_styling_map),
      sensitivity: Object.fromEntries(SAFE_S.SENTIMENTS.map((s) => [s, SAFE_S.default_sensitivity]))
    },
    // Working copy edited live in the Settings modal, committed on Save
    pendingConfig: null,

    wordEls: [],                 // flat list of {el, start, end} for playhead sync + seeking
    isSeeking: false
  };

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const sourceEmpty = el('source-empty');
  const sourceLoaded = el('source-loaded');
  const mediaTitleEl = el('media-title');
  const mediaSubtitleEl = el('media-subtitle');
  const videoWrap = el('video-wrap');
  const videoEl = el('video-el');
  const audioEl = el('audio-el');
  const progressTrack = el('progress-track');
  const progressSamplesCanvas = el('progress-samples');
  const progressFill = el('progress-fill');
  const progressHandle = el('progress-handle');
  const timeCurrent = el('time-current');
  const timeTotal = el('time-total');
  const speedSelect = el('speed-select');
  const btnRewind = el('btn-rewind');
  const btnForward = el('btn-forward');
  const btnPlayPause = el('btn-playpause');
  const iconPlay = el('icon-play');
  const iconPause = el('icon-pause');

  const transcriptEmpty = el('transcript-empty');
  const transcriptProcessing = el('transcript-processing');
  const transcriptError = el('transcript-error');
  const transcriptErrorText = el('transcript-error-text');
  const transcriptBody = el('transcript-body');
  const btnSettings = el('btn-settings');

  const settingsOverlay = el('settings-overlay');
  const settingsTableBody = el('settings-table-body');
  const btnRestoreDefaults = el('btn-restore-defaults');
  const btnSettingsCancel = el('btn-settings-cancel');
  const btnSettingsSave = el('btn-settings-save');

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    // Wire up all button/click handlers FIRST, unconditionally — a failure
    // in anything below (preload bridge, shared config) must not prevent
    // basic UI interactivity like the settings gear from working.
    wireSourceControls();
    wireSettingsModal();

    if (!window.electronAPI) {
      console.error(
        '[renderer] window.electronAPI is undefined — the preload script ' +
        '(preload.js) did not run successfully. Check the main process ' +
        'console (the terminal running `npm start`) for a preload error.'
      );
    } else {
      window.electronAPI.onMediaOpened(({ filePath }) => openMedia(filePath));
      window.electronAPI.onMenuSave(({ saveAs }) => saveTranscript(saveAs));
      window.electronAPI.onTranscriptLoaded(({ sidecarPath, sidecar }) => loadFromSidecar(sidecarPath, sidecar));
    }

    if (!S) {
      console.error(
        '[renderer] window.APP_SETTINGS is undefined — preload.js failed ' +
        'to load config/settings.json. Playback speed options will be empty.'
      );
    } else {
      speedSelect.innerHTML = S.playback_speeds
        .map((s) => `<option value="${s}" ${s === S.default_speed ? 'selected' : ''}>${s}x</option>`)
        .join('');
    }
  }

  // ---------------------------------------------------------------------
  // Opening + analyzing media
  // ---------------------------------------------------------------------
  async function openMedia(filePath) {
    state.filePath = filePath;
    state.guid = null;
    state.savedPath = null;

    const ext = filePath.split('.').pop().toLowerCase();
    const videoExts = ['mp4', 'mov', 'mkv', 'webm'];
    state.mediaKind = videoExts.includes(ext) ? 'video' : 'audio';

    sourceEmpty.classList.add('hidden');
    sourceLoaded.classList.remove('hidden');
    videoWrap.classList.toggle('hidden', state.mediaKind !== 'video');

    state.mediaEl = state.mediaKind === 'video' ? videoEl : audioEl;
    const fileUrl = 'file://' + encodeURI(filePath).replace(/#/g, '%23');
    state.mediaEl.src = fileUrl;
    attachMediaElEvents();

    mediaTitleEl.textContent = filePath.split(/[\\/]/).pop();
    mediaSubtitleEl.textContent = 'Loading…';

    showTranscriptState('processing', 'Transcribing speech and scoring sentiment locally…');

    try {
      const result = await window.electronAPI.analyzeMedia(filePath);
      state.analysis = result;
      applyAnalysisResult(result);
    } catch (err) {
      showTranscriptState('error', `Backend error: ${err.message}`);
    }
  }

  function applyAnalysisResult(result) {
    const meta = result.metadata || {};
    mediaTitleEl.textContent = meta.title || state.filePath.split(/[\\/]/).pop();
    mediaSubtitleEl.textContent = [meta.date, formatDuration(result.durationSec)].filter(Boolean).join(' · ');

    drawProgressSamples(result.waveform || []);

    if (result.status === 'unprocessable') {
      showTranscriptState('error', result.error || S.error_fully_unprocessable);
      return;
    }

    renderTranscript(result.segments || []);
    showTranscriptState('body');
  }

  function showTranscriptState(which, message) {
    transcriptEmpty.classList.add('hidden');
    transcriptProcessing.classList.add('hidden');
    transcriptError.classList.add('hidden');
    transcriptBody.classList.add('hidden');

    if (which === 'processing') {
      transcriptProcessing.classList.remove('hidden');
      if (message) el('processing-detail').textContent = message;
    } else if (which === 'error') {
      transcriptError.classList.remove('hidden');
      transcriptErrorText.textContent = message;
    } else if (which === 'body') {
      transcriptBody.classList.remove('hidden');
    } else {
      transcriptEmpty.classList.remove('hidden');
    }
  }

  // ---------------------------------------------------------------------
  // Transcript rendering
  // ---------------------------------------------------------------------
  function renderTranscript(segments) {
    transcriptBody.innerHTML = '';
    state.wordEls = [];

    segments.forEach((seg) => {
      if (seg.type === 'words') {
        seg.words.forEach((w) => appendWord(w));
      } else if (seg.type === 'silence') {
        appendSilenceDashes(seg);
      } else if (seg.type === 'gap') {
        appendInlineError(seg);
      }
    });
  }

  function appendWord(w) {
    const span = document.createElement('span');
    span.className = 't-word';
    span.textContent = w.word + ' ';
    span.dataset.start = w.start;
    span.dataset.end = w.end;

    const { cssStyle, lineHeightEm } = StylingEngine.computeWordStyle(w.sentiment || {}, state.config);
    Object.assign(span.style, cssStyle);
    span.style.lineHeight = `${lineHeightEm}em`;

    span.addEventListener('click', () => seekTo(w.start));
    transcriptBody.appendChild(span);
    state.wordEls.push({ el: span, start: w.start, end: w.end });
  }

  function appendSilenceDashes(seg) {
    const step = S.wordless_sample_rate_sec;
    for (let t = seg.start; t < seg.end; t += step) {
      const span = document.createElement('span');
      span.className = 't-word t-gap-marker';
      span.textContent = ' — ';
      span.dataset.start = t;
      span.dataset.end = Math.min(t + step, seg.end);

      const sentimentAtT = (seg.sentimentSamples && seg.sentimentSamples[Math.floor((t - seg.start) / step)]) || {};
      const { cssStyle, lineHeightEm } = StylingEngine.computeWordStyle(sentimentAtT, state.config);
      Object.assign(span.style, cssStyle);
      span.style.lineHeight = `${lineHeightEm}em`;

      span.addEventListener('click', () => seekTo(t));
      transcriptBody.appendChild(span);
      state.wordEls.push({ el: span, start: t, end: t + step });
    }
  }

  function appendInlineError(seg) {
    const div = document.createElement('div');
    div.className = 't-inline-error';
    div.textContent = S.error_partial_gap_inline;
    div.title = 'Jump to this point in the source';
    div.addEventListener('click', () => seekTo(seg.start));
    transcriptBody.appendChild(div);
  }

  function reRenderTranscriptStyles() {
    // Settings changed but words/timing didn't — just recompute styles in place.
    if (!state.analysis || !state.analysis.segments) return;
    renderTranscript(state.analysis.segments);
  }

  // ---------------------------------------------------------------------
  // Source pane: playback controls
  // ---------------------------------------------------------------------
  function wireSourceControls() {
    progressTrack.addEventListener('mousedown', (e) => {
      state.isSeeking = true;
      seekFromClientX(e.clientX);
    });
    window.addEventListener('mousemove', (e) => {
      if (state.isSeeking) seekFromClientX(e.clientX);
    });
    window.addEventListener('mouseup', () => { state.isSeeking = false; });

    btnPlayPause.addEventListener('click', togglePlayPause);
    btnRewind.addEventListener('click', () => nudge(-S.seek_step_sec));
    btnForward.addEventListener('click', () => nudge(S.seek_step_sec));
    speedSelect.addEventListener('change', () => {
      if (state.mediaEl) state.mediaEl.playbackRate = parseFloat(speedSelect.value);
    });
  }

  function attachMediaElEvents() {
    const m = state.mediaEl;
    m.playbackRate = parseFloat(speedSelect.value);
    m.addEventListener('timeupdate', onTimeUpdate);
    m.addEventListener('play', () => setPlayIcon(true));
    m.addEventListener('pause', () => setPlayIcon(false));
    m.addEventListener('loadedmetadata', () => {
      timeTotal.textContent = formatDuration(m.duration);
    });
  }

  function togglePlayPause() {
    if (!state.mediaEl) return;
    if (state.mediaEl.paused) state.mediaEl.play(); else state.mediaEl.pause();
  }

  function setPlayIcon(playing) {
    iconPlay.classList.toggle('hidden', playing);
    iconPause.classList.toggle('hidden', !playing);
  }

  function nudge(deltaSec) {
    if (!state.mediaEl) return;
    seekTo(Math.max(0, Math.min(state.mediaEl.duration || Infinity, state.mediaEl.currentTime + deltaSec)));
  }

  function seekFromClientX(clientX) {
    if (!state.mediaEl || !state.mediaEl.duration) return;
    const rect = progressTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekTo(ratio * state.mediaEl.duration);
  }

  function seekTo(seconds) {
    if (!state.mediaEl) return;
    state.mediaEl.currentTime = seconds;
    onTimeUpdate();
  }

  function onTimeUpdate() {
    const m = state.mediaEl;
    if (!m || !m.duration) return;
    const ratio = m.currentTime / m.duration;
    progressFill.style.width = `${ratio * 100}%`;
    progressHandle.style.left = `${ratio * 100}%`;
    timeCurrent.textContent = formatDuration(m.currentTime);
    updateCurrentWordHighlight(m.currentTime);
  }

  function updateCurrentWordHighlight(t) {
    let activeEl = null;
    state.wordEls.forEach(({ el: wEl, start, end }) => {
      const isCurrent = t >= start && t < end;
      wEl.classList.toggle('current', isCurrent);
      if (isCurrent) activeEl = wEl;
    });
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function drawProgressSamples(waveform) {
    const canvas = progressSamplesCanvas;
    const ctx = canvas.getContext('2d');
    const rect = progressTrack.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Per spec: only the audio player shows sampled-volume tick lines;
    // video's progress bar stays plain since the video screen itself
    // is the visual counterpart.
    if (state.mediaKind !== 'audio' || !waveform.length) return;

    const midY = canvas.height / 2;
    const barWidth = canvas.width / waveform.length;
    ctx.strokeStyle = 'rgba(139, 144, 156, 0.5)';
    ctx.lineWidth = Math.max(1, barWidth * 0.4);
    waveform.forEach((v, i) => {
      const x = i * barWidth + barWidth / 2;
      const h = Math.max(2, v * (canvas.height * 0.8));
      ctx.beginPath();
      ctx.moveTo(x, midY - h / 2);
      ctx.lineTo(x, midY + h / 2);
      ctx.stroke();
    });
  }

  function formatDuration(sec) {
    if (!isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ---------------------------------------------------------------------
  // Settings modal
  // ---------------------------------------------------------------------
  function wireSettingsModal() {
    btnSettings.addEventListener('click', openSettings);
    btnSettingsCancel.addEventListener('click', closeSettingsWithoutSaving);
    btnSettingsSave.addEventListener('click', saveSettings);
    btnRestoreDefaults.addEventListener('click', restoreDefaultsInPlace);
  }

  function openSettings() {
    state.pendingConfig = {
      stylingMap: Object.assign({}, state.config.stylingMap),
      sensitivity: Object.assign({}, state.config.sensitivity)
    };
    renderSettingsTable();
    settingsOverlay.classList.remove('hidden');
  }

  function renderSettingsTable() {
    settingsTableBody.innerHTML = '';
    S.SENTIMENTS.forEach((sentiment) => {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = sentiment;

      const tdStyling = document.createElement('td');
      const select = document.createElement('select');
      S.STYLINGS.forEach((styling) => {
        const opt = document.createElement('option');
        opt.value = styling;
        opt.textContent = styling;
        if (state.pendingConfig.stylingMap[sentiment] === styling) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        state.pendingConfig.stylingMap[sentiment] = select.value;
      });
      tdStyling.appendChild(select);

      const tdSensitivity = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'sensitivity-cell';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      slider.value = state.pendingConfig.sensitivity[sentiment];
      const valueLabel = document.createElement('span');
      valueLabel.className = 'sensitivity-value';
      valueLabel.textContent = Number(slider.value).toFixed(2);
      slider.addEventListener('input', () => {
        state.pendingConfig.sensitivity[sentiment] = parseFloat(slider.value);
        valueLabel.textContent = Number(slider.value).toFixed(2);
      });
      wrap.appendChild(slider);
      wrap.appendChild(valueLabel);
      tdSensitivity.appendChild(wrap);

      tr.appendChild(tdName);
      tr.appendChild(tdStyling);
      tr.appendChild(tdSensitivity);
      settingsTableBody.appendChild(tr);
    });
  }

  function restoreDefaultsInPlace() {
    // Per spec: Restore Defaults leaves the pane open but resets values.
    state.pendingConfig = {
      stylingMap: Object.assign({}, S.default_styling_map),
      sensitivity: Object.fromEntries(S.SENTIMENTS.map((s) => [s, S.default_sensitivity]))
    };
    renderSettingsTable();
  }

  function closeSettingsWithoutSaving() {
    state.pendingConfig = null;
    settingsOverlay.classList.add('hidden');
  }

  function saveSettings() {
    state.config = state.pendingConfig;
    state.pendingConfig = null;
    settingsOverlay.classList.add('hidden');
    reRenderTranscriptStyles();
  }

  // ---------------------------------------------------------------------
  // Save / load transcript files
  // ---------------------------------------------------------------------
  async function saveTranscript(forceDialog) {
    if (!state.analysis) return;

    const markdown = buildMarkdown(state.analysis.segments || []);
    const sidecar = {
      guid: state.guid,
      savedPath: state.savedPath,
      sourceFilePath: state.filePath,
      mediaKind: state.mediaKind,
      metadata: state.analysis.metadata || {},
      durationSec: state.analysis.durationSec,
      segments: state.analysis.segments,
      config: state.config
    };

    const suggestedName = (state.filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'transcript') + '.md';
    const result = await window.electronAPI.saveTranscript({ markdown, sidecar, suggestedName, forceDialog });
    if (!result.canceled) {
      state.guid = result.guid;
      state.savedPath = result.jsonPath;
    }
  }

  function buildMarkdown(segments) {
    const lines = [];
    segments.forEach((seg) => {
      if (seg.type === 'words') {
        lines.push(seg.words.map((w) => w.word).join(' '));
      } else if (seg.type === 'silence') {
        lines.push('*(non-speech sound)*');
      } else if (seg.type === 'gap') {
        lines.push(`> ${S.error_partial_gap_inline}`);
      }
    });
    return lines.join('\n\n');
  }

  function loadFromSidecar(sidecarPath, sidecar) {
    state.guid = sidecar.guid;
    state.savedPath = sidecarPath;
    state.filePath = sidecar.sourceFilePath;
    state.mediaKind = sidecar.mediaKind;
    state.config = sidecar.config || state.config;
    state.analysis = {
      metadata: sidecar.metadata,
      durationSec: sidecar.durationSec,
      segments: sidecar.segments,
      status: 'ok'
    };

    if (sidecar.sourceFilePath) {
      sourceEmpty.classList.add('hidden');
      sourceLoaded.classList.remove('hidden');
      videoWrap.classList.toggle('hidden', state.mediaKind !== 'video');
      state.mediaEl = state.mediaKind === 'video' ? videoEl : audioEl;
      state.mediaEl.src = 'file://' + encodeURI(sidecar.sourceFilePath).replace(/#/g, '%23');
      attachMediaElEvents();
    }

    applyAnalysisResult(state.analysis);
  }

  init();
})();

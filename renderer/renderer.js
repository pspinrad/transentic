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
  const SAFE_S = S || { SENTIMENTS: [], STYLINGS: [], default_styling_map: {}, default_sensitivity: 0.5, default_audio_video_mix: 50 };

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

    // Active styling configuration — session-level, not tied to any
    // particular source file or senticscript (see saveTranscript() /
    // loadFromSidecar(), which deliberately never touch this). The
    // Settings sidebar edits this object directly — no separate draft/
    // pending-vs-committed state, since there's no Save/Cancel anymore;
    // changes apply live (see scheduleLiveRestyle()).
    config: {
      stylingMap: Object.assign({}, SAFE_S.default_styling_map),
      sensitivity: Object.fromEntries(SAFE_S.SENTIMENTS.map((s) => [s, SAFE_S.default_sensitivity])),
      // 0-100. 0 = audio only, 100 = video only. Only has any effect on
      // words that carry separate audioSentiment/videoSentiment fields
      // (video files analyzed after this feature was added) — see
      // blendAudioVideoSentiment().
      audioVideoMix: SAFE_S.default_audio_video_mix
    },

    // Per-sentiment {baseline, spread} computed once whenever a new
    // analysis loads, used by normalizeSentimentVector() — see its comment
    // block for what this does and why it's applied unconditionally.
    normalizationStats: null,

    // {el, start, end, kind, raw} per rendered word/silence-marker span.
    // kind is 'word' | 'silence'; raw is the underlying word object (for
    // 'word') or bare sentiment dict (for 'silence') — used by
    // restyleTranscriptInPlace() to recompute each element's style
    // in-place without rebuilding the DOM. Also used for playhead sync and
    // search.
    wordEls: [],
    isSeeking: false,

    // Transcript search
    search: {
      query: '',
      matches: [],        // array of word span elements currently matching
      currentIndex: -1    // index into matches; -1 means no active selection
    }
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
  const processingProgressFill = el('processing-progress-fill');
  const processingProgressText = el('processing-progress-text');
  const btnCancelAnalysis = el('btn-cancel-analysis');
  const transcriptCancelled = el('transcript-cancelled');
  const transcriptError = el('transcript-error');
  const transcriptErrorText = el('transcript-error-text');
  const transcriptBody = el('transcript-body');
  const btnSettings = el('btn-settings');

  const transcriptSearchBar = el('transcript-search-bar');
  const transcriptSearchInput = el('transcript-search-input');
  const searchCountEl = el('search-count');
  const btnSearchPrev = el('btn-search-prev');
  const btnSearchNext = el('btn-search-next');
  const btnSearchClose = el('btn-search-close');

  const settingsSidebar = el('settings-sidebar');
  const settingsTableBody = el('settings-table-body');
  const btnRestoreDefaults = el('btn-restore-defaults');
  const avMixSlider = el('av-mix-slider');
  const avMixValue = el('av-mix-value');
  const avMixRow = el('av-mix-row');
  const btnCloseSidebar = el('btn-close-sidebar');
  const appEl = el('app');

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    // Wire up all button/click handlers FIRST, unconditionally — a failure
    // in anything below (preload bridge, shared config) must not prevent
    // basic UI interactivity like the settings gear from working.
    wireSourceControls();
    wireSettingsModal();
    wireSearchBar();
    btnCancelAnalysis.addEventListener('click', handleCancelAnalysis);

    // The sidebar is persistent now (not a modal rebuilt each time it
    // opens), so the styling table needs populating once up front rather
    // than on open — this was the actual cause of the dropdowns/sliders
    // appearing to be missing.
    renderSettingsTable();

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
      window.electronAPI.onAnalysisProgress(updateProcessingProgress);
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
    closeSearchBar(); // genuinely new content — an old search's matches/query wouldn't make sense here

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

    resetProcessingProgress();
    showTranscriptState('processing', 'Transcribing speech and scoring sentiment locally…');

    try {
      const result = await window.electronAPI.analyzeMedia(filePath);
      if (result.status === 'cancelled') {
        showTranscriptState('cancelled');
        return;
      }
      state.analysis = result;
      applyAnalysisResult(result);
    } catch (err) {
      showTranscriptState('error', `Backend error: ${err.message}`);
    }
  }

  async function handleCancelAnalysis() {
    btnCancelAnalysis.disabled = true; // prevent double-clicks while the request is in flight
    processingProgressText.textContent = 'Cancelling…';
    await window.electronAPI.cancelAnalysis();
    // The pending analyzeMedia() promise in openMedia() resolves with
    // {status: 'cancelled'} once the killed process actually exits, and
    // that's what actually transitions the UI to the cancelled state —
    // this handler just requests the kill and gives immediate feedback.
  }

  function applyAnalysisResult(result) {
    const meta = result.metadata || {};
    mediaTitleEl.textContent = meta.title || state.filePath.split(/[\\/]/).pop();
    mediaSubtitleEl.textContent = [meta.date, formatDuration(result.durationSec)].filter(Boolean).join(' · ');

    // The sidebar can stay open continuously now (it's not a modal that
    // gets rebuilt each time it opens), so its Audio / Video Mix control
    // needs to be kept in sync with whichever file is currently loaded,
    // not just refreshed on open.
    updateAvMixControl();

    drawProgressSamples(result.waveform || []);

    if (result.status === 'unprocessable') {
      showTranscriptState('error', result.error || S.error_fully_unprocessable);
      return;
    }

    state.normalizationStats = computeNormalizationStats(result.segments || []);
    renderTranscript(result.segments || []);
    showTranscriptState('body');
  }

  // ---------------------------------------------------------------------
  // Per-file sentiment normalization
  //
  // Three stages: (1) figure out, per sentiment, what counts as "elevated"
  // for THIS FILE specifically; (2) dampen a sentiment in proportion to
  // how often it crosses that bar; (3) hard-gate and rescale so only
  // genuine outliers produce any visible styling at all.
  //
  // Stage 1 — adaptive per-sentiment elevated threshold:
  // Some speakers show one sentiment (e.g. Disgusted) elevated across most
  // of a file regardless of content — likely a facial-structure bias in
  // the expression model for that person, not real per-word signal. A
  // single fixed threshold for all six sentiments doesn't account for how
  // differently each one is naturally distributed (both across sentiments,
  // and from file to file). Instead, each sentiment's own median and MAD
  // (median absolute deviation) — how far its TYPICAL value deviates from
  // its own middle — set its threshold: median + k * MAD. This is a
  // standard robust-outlier statistic (a "modified z-score"; k=3.5 follows
  // a commonly cited convention, Iglewicz & Hoaglin). It adapts upward for
  // a sentiment whose normal baseline in this file is already high, and
  // stays low for one that's normally near-zero — floored at
  // normalization_elevated_threshold so a sentiment that's genuinely flat
  // throughout never has tiny noise misread as "elevated" just because
  // it's slightly above its own negligible baseline.
  //
  // Stage 2 — frequency-based dampening:
  // Measures how often a sentiment crosses its (now adaptive) threshold,
  // and applies a single multiplier: 1 - frequency. Elevated on most words
  // -> strongly suppressed; rarely elevated -> left essentially untouched,
  // since rarity itself isn't suspicious, only *constant* elevation is.
  //
  // (An earlier version of stage 1 used a fixed 90th-percentile rescale
  // instead of a comparison threshold. That backfired for genuinely sparse
  // sentiments: when real spikes affect well under 10% of words, the 90th
  // percentile lands inside the normal cluster rather than out at the rare
  // spikes, producing a near-zero spread that then massively amplified
  // ordinary values once divided by it. The median+MAD approach here is a
  // comparison, not a division, so it doesn't have that failure mode.)
  //
  // Stage 3 — hard gate, no rescale (see normalizeSentimentVector()):
  // Even after dampening, a value might survive at some middling level
  // without representing a real outlier. Anything below
  // normalized_min_style_threshold is zeroed out entirely — no styling at
  // all — and anything that clears the bar passes through at its own
  // dampened value unchanged. (A gate-then-rescale variant, remapping
  // [floor,1] back to [0,1], was tried first but made typical outliers
  // look weaker, not stronger — see normalizeSentimentVector()'s comment
  // for why.)
  //
  // Applied unconditionally to every senticscript — this started as an
  // experimental toggle (raw vs. normalized) to evaluate against
  // clause-based chunking, but proved to genuinely help, so it's now just
  // how sentiment values are computed, not an optional mode.
  // ---------------------------------------------------------------------
  function median(sortedValues) {
    const n = sortedValues.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
  }

  // First stage of the pipeline (blend -> calibrate -> normalize): mixes a
  // word's separately-saved audioSentiment/videoSentiment at the current
  // Audio / Video Mix setting when both are present (a video file). When
  // only one component is available, the mix slider simply doesn't apply
  // and that single value is used as-is — covering audio-only files
  // (audioSentiment only, no video ever existed), silence-gap samples
  // (video-only by design, passed as a bare sentiment dict rather than a
  // word object — see appendSilenceDashes()), and senticscripts saved
  // before audioSentiment/videoSentiment existed at all (a plain
  // `sentiment` field only, checked last as the oldest fallback).
  function blendAudioVideoSentiment(word) {
    if (!word || !word.audioSentiment || !word.videoSentiment) {
      return (word && (word.audioSentiment || word.sentiment)) || {};
    }
    const videoWeight = state.config.audioVideoMix / 100;
    const audioWeight = 1 - videoWeight;
    const out = {};
    S.SENTIMENTS.forEach((s) => {
      const a = (word.audioSentiment && word.audioSentiment[s]) || 0;
      const v = (word.videoSentiment && word.videoSentiment[s]) || 0;
      out[s] = audioWeight * a + videoWeight * v;
    });
    return out;
  }

  // Cross-file, fixed per-sentiment bias correction — distinct from (and
  // applied before) the adaptive per-file normalization above. That
  // normalization compares a sentiment against ITS OWN file's typical
  // level, so it can't catch a bias that shows up consistently across many
  // different files/speakers, only a per-file/per-speaker quirk. Sad in
  // particular is a documented weak point for both underlying models:
  // the audio SER model was trained on RAVDESS (actors reading fixed lines
  // in different emotional styles), where "sad" is mainly characterized by
  // slow/quiet/low-pitched delivery — indistinguishable from plain calm or
  // serious conversational speech to a model trained mostly on theatrical
  // readings. Facial "sad" expressions are also a commonly-confused Ekman
  // category against a plain neutral/resting face in general, not specific
  // to any one person's face shape. Neither DeepFace nor the wav2vec2 model
  // expose any built-in way to recalibrate a specific output class, so this
  // is a fixed multiplier applied on our side instead. Starting values are
  // a reasoned guess, not an empirical calibration — tune per sentiment in
  // config/settings.json based on what you actually observe.
  function applyCalibration(rawSentiment) {
    const out = {};
    S.SENTIMENTS.forEach((s) => {
      const raw = (rawSentiment && rawSentiment[s]) || 0;
      const multiplier = (S.sentiment_calibration_multipliers && S.sentiment_calibration_multipliers[s] != null)
        ? S.sentiment_calibration_multipliers[s] : 1.0;
      out[s] = Math.max(0, Math.min(1, raw * multiplier));
    });
    return out;
  }

  function computeNormalizationStats(segments) {
    const valuesBySentiment = {};
    S.SENTIMENTS.forEach((s) => { valuesBySentiment[s] = []; });

    segments.forEach((seg) => {
      if (seg.type === 'words') {
        seg.words.forEach((w) => {
          const calibrated = applyCalibration(blendAudioVideoSentiment(w));
          S.SENTIMENTS.forEach((s) => valuesBySentiment[s].push(calibrated[s]));
        });
      } else if (seg.type === 'silence' && seg.sentimentSamples) {
        seg.sentimentSamples.forEach((sample) => {
          const calibrated = applyCalibration(sample);
          S.SENTIMENTS.forEach((s) => valuesBySentiment[s].push(calibrated[s]));
        });
      }
    });

    const stats = {};
    S.SENTIMENTS.forEach((s) => {
      const values = valuesBySentiment[s];
      if (values.length === 0) {
        stats[s] = { dampening: 1 };
        return;
      }

      const sortedValues = values.slice().sort((a, b) => a - b);
      const med = median(sortedValues);
      const deviations = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
      const mad = median(deviations);
      const adaptiveThreshold = med + S.normalization_mad_multiplier * mad;
      const elevatedThreshold = Math.max(S.normalization_elevated_threshold, adaptiveThreshold);

      const elevatedCount = values.filter((v) => v > elevatedThreshold).length;
      const frequency = elevatedCount / values.length;
      stats[s] = { dampening: 1 - frequency };
    });
    return stats;
  }

  function normalizeSentimentVector(rawSentiment) {
    const stats = state.normalizationStats;
    const floor = S.normalized_min_style_threshold;
    const calibrated = applyCalibration(rawSentiment);
    const out = {};
    S.SENTIMENTS.forEach((s) => {
      const raw = calibrated[s];
      const dampening = (stats && stats[s] && stats[s].dampening != null) ? stats[s].dampening : 1;
      const dampened = Math.max(0, Math.min(1, raw * dampening));
      // Hard gate, no rescale: anything below the floor is zeroed, anything
      // above passes through at its own dampened value unchanged. Tried
      // gate-then-rescale first (remapping [floor,1] back to [0,1]) on the
      // reasoning that a genuine outlier should get to use the full visual
      // range — but that rescale actually COMPRESSES anything short of an
      // extreme value: a dampened 0.7 rescales down to just 0.4, weaker
      // than showing 0.7 directly. Only near-1.0 values benefited from
      // rescaling; everything more moderately-elevated looked more subdued
      // than it should have. Passing the value through directly reads as
      // more prominent for the common case of "clearly elevated but not
      // extreme," which is most real outliers.
      out[s] = dampened < floor ? 0 : dampened;
    });
    return out;
  }

  function showTranscriptState(which, message) {
    transcriptEmpty.classList.add('hidden');
    transcriptProcessing.classList.add('hidden');
    transcriptCancelled.classList.add('hidden');
    transcriptError.classList.add('hidden');
    transcriptBody.classList.add('hidden');

    if (which === 'processing') {
      transcriptProcessing.classList.remove('hidden');
      if (message) el('processing-detail').textContent = message;
    } else if (which === 'cancelled') {
      transcriptCancelled.classList.remove('hidden');
    } else if (which === 'error') {
      transcriptError.classList.remove('hidden');
      transcriptErrorText.textContent = message;
    } else if (which === 'body') {
      transcriptBody.classList.remove('hidden');
    } else {
      transcriptEmpty.classList.remove('hidden');
    }
  }

  function resetProcessingProgress() {
    processingProgressFill.style.width = '0%';
    processingProgressText.textContent = 'Starting…';
    btnCancelAnalysis.disabled = false;
  }

  function updateProcessingProgress({ phase, percent, detail, current, total }) {
    processingProgressFill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
    if (phase === 'scoring' && total > 0) {
      processingProgressText.textContent = `Processed word ${current} of ${total}`;
    } else if (detail) {
      processingProgressText.textContent = detail;
    }
  }

  // ---------------------------------------------------------------------
  // Transcript rendering
  // ---------------------------------------------------------------------
  function renderTranscript(segments) {
    transcriptBody.innerHTML = '';
    state.wordEls = [];

    const sentenceBreaks = computeSentenceBreakWords(segments);

    segments.forEach((seg) => {
      if (seg.type === 'words') {
        seg.words.forEach((w) => appendWord(w, sentenceBreaks));
      } else if (seg.type === 'silence') {
        appendSilenceDashes(seg);
      } else if (seg.type === 'gap') {
        appendInlineError(seg);
      }
    });

    // Re-render (e.g. after a Settings save) rebuilds every word span from
    // scratch, so any active search's element references are now stale/
    // detached — re-running it against the fresh DOM keeps it working
    // rather than silently going dead. Genuinely new content (a different
    // file opened) explicitly closes the search bar first instead — see
    // openMedia()/loadFromSidecar().
    if (state.search.query) {
      performSearch(state.search.query);
    }
  }

  // ---------------------------------------------------------------------
  // Transcript search (Cmd/Ctrl+F)
  // ---------------------------------------------------------------------
  // Each match is now an ARRAY of word elements (usually one, but a
  // multi-word phrase query spans several) — matching against a single
  // word's text in isolation (the original implementation) could never
  // find a phrase crossing a word boundary at all.
  function buildSearchIndex() {
    // Joins every word's text with single spaces into one big lowercase
    // string, tracking the [start,end) character range each word occupies
    // within it — lets a plain substring search naturally span multiple
    // words, then map a found match back to exactly which word(s) it hit.
    let text = '';
    const wordRanges = [];
    state.wordEls.forEach(({ el: wEl }) => {
      if (wEl.classList.contains('t-gap-marker')) {
        // A character no query can ever contain, so a phrase can't bridge
        // across a silence marker and match as if it were spoken
        // continuously — insert it as its own "word" with a normal space
        // on each side so it can't accidentally fuse adjacent real words
        // together either.
        text += (text ? ' ' : '') + '\u0000';
        return;
      }
      const wordText = wEl.textContent.trim().toLowerCase();
      if (text) text += ' ';
      const start = text.length;
      text += wordText;
      wordRanges.push({ el: wEl, start, end: text.length });
    });
    return { text, wordRanges };
  }

  function performSearch(query) {
    clearSearchHighlights();
    state.search.query = query;
    state.search.matches = [];
    state.search.currentIndex = -1;

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      updateSearchCount();
      return;
    }

    const { text, wordRanges } = buildSearchIndex();
    const matches = [];
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(trimmed, searchFrom);
      if (idx === -1) break;
      const matchEnd = idx + trimmed.length;
      const matchedEls = wordRanges
        .filter((wr) => wr.start < matchEnd && wr.end > idx)
        .map((wr) => wr.el);
      if (matchedEls.length > 0) {
        matches.push(matchedEls);
        matchedEls.forEach((wEl) => wEl.classList.add('search-match'));
      }
      searchFrom = idx + 1; // +1 (not matchEnd) so overlapping occurrences are still all found
    }

    state.search.matches = matches;
    if (matches.length > 0) {
      state.search.currentIndex = 0;
      highlightCurrentMatch();
    }
    updateSearchCount();
  }

  function clearSearchHighlights() {
    state.search.matches.forEach((matchEls) => {
      matchEls.forEach((wEl) => wEl.classList.remove('search-match', 'search-match-current'));
    });
  }

  function highlightCurrentMatch() {
    state.search.matches.forEach((matchEls) => {
      matchEls.forEach((wEl) => wEl.classList.remove('search-match-current'));
    });
    const current = state.search.matches[state.search.currentIndex];
    if (current) {
      current.forEach((wEl) => wEl.classList.add('search-match-current'));
      current[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function updateSearchCount() {
    if (state.search.matches.length === 0) {
      searchCountEl.textContent = state.search.query.trim() ? '0 of 0' : '';
    } else {
      searchCountEl.textContent = `${state.search.currentIndex + 1} of ${state.search.matches.length}`;
    }
  }

  function goToNextMatch() {
    if (state.search.matches.length === 0) return;
    state.search.currentIndex = (state.search.currentIndex + 1) % state.search.matches.length;
    highlightCurrentMatch();
    updateSearchCount();
  }

  function goToPrevMatch() {
    if (state.search.matches.length === 0) return;
    state.search.currentIndex = (state.search.currentIndex - 1 + state.search.matches.length) % state.search.matches.length;
    highlightCurrentMatch();
    updateSearchCount();
  }

  function openSearchBar() {
    transcriptSearchBar.classList.remove('hidden');
    transcriptSearchInput.focus();
    transcriptSearchInput.select();
  }

  function closeSearchBar() {
    transcriptSearchBar.classList.add('hidden');
    clearSearchHighlights();
    transcriptSearchInput.value = '';
    state.search.query = '';
    state.search.matches = [];
    state.search.currentIndex = -1;
    updateSearchCount();
  }

  function wireSearchBar() {
    let debounceTimer = null;
    transcriptSearchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      // Light debounce: a full linear scan over every word on each
      // keystroke is cheap for typical transcripts, but this keeps typing
      // responsive even on very long (multi-thousand-word) ones.
      debounceTimer = setTimeout(() => performSearch(transcriptSearchInput.value), 120);
    });
    transcriptSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) goToPrevMatch(); else goToNextMatch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchBar();
      }
    });
    btnSearchNext.addEventListener('click', goToNextMatch);
    btnSearchPrev.addEventListener('click', goToPrevMatch);
    btnSearchClose.addEventListener('click', closeSearchBar);

    // Global shortcut — Electron has no built-in find bar (that's a Chrome
    // browser UI feature, not something a bare BrowserWindow provides), so
    // Cmd/Ctrl+F does nothing at all unless we bind it ourselves. Bound
    // globally rather than only while the transcript pane has focus, so it
    // works no matter where the user's attention currently is.
    document.addEventListener('keydown', (e) => {
      const isFindShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f';
      if (isFindShortcut) {
        e.preventDefault();
        openSearchBar();
      }
    });
  }

  // Sentence-end detection is a punctuation heuristic, not true NLP sentence
  // tokenization — it can occasionally misfire on abbreviations or decimals
  // (e.g. "3.5", "Mr.") that happen to be followed by a capitalized word.
  // Good enough for a readability line break; not guaranteed perfect.
  // Returns a Set of word objects (by reference) that should get a line
  // break after them — computed over a flattened, cross-segment word list
  // so a sentence continuing into the next whisper segment is still
  // detected correctly, not just sentence ends that happen to land on a
  // segment boundary.
  function computeSentenceBreakWords(segments) {
    const flatWords = [];
    segments.forEach((seg) => {
      if (seg.type === 'words') {
        seg.words.forEach((w) => flatWords.push(w));
      }
    });

    const SENTENCE_END_RE = /[.!?]+["'”’)\]]*$/;
    const breakAfter = new Set();
    for (let i = 0; i < flatWords.length; i++) {
      const w = flatWords[i];
      if (!SENTENCE_END_RE.test(w.word)) continue;
      const next = flatWords[i + 1];
      if (!next || /^[A-Z]/.test(next.word)) {
        breakAfter.add(w);
      }
    }
    return breakAfter;
  }

  function appendWord(w, sentenceBreaks) {
    const span = document.createElement('span');
    span.className = 't-word';
    span.textContent = w.word + ' ';
    span.dataset.start = w.start;
    span.dataset.end = w.end;

    const { cssStyle, lineHeightEm } = StylingEngine.computeWordStyle(normalizeSentimentVector(blendAudioVideoSentiment(w)), state.config);
    Object.assign(span.style, cssStyle);
    span.style.lineHeight = `${lineHeightEm}em`;

    span.addEventListener('click', () => seekTo(w.start));
    transcriptBody.appendChild(span);
    state.wordEls.push({ el: span, start: w.start, end: w.end, kind: 'word', raw: w });

    if (sentenceBreaks && sentenceBreaks.has(w)) {
      transcriptBody.appendChild(document.createElement('br'));
    }
  }

  function appendSilenceDashes(seg) {
    const step = S.wordless_sample_rate_sec;
    for (let t = seg.start; t < seg.end; t += step) {
      const span = document.createElement('span');
      span.className = 't-word t-gap-marker';
      // U+25A1 WHITE SQUARE rather than a dash: a thin horizontal dash
      // barely shows slant, weight, or other shape-based stylings at all,
      // while a filled/outlined square has real width and height for them
      // to visibly act on. Applied uniformly (not just for video, where
      // these markers actually carry styled sentiment via DeepFace) since
      // audio-only files' markers are always neutral anyway — one
      // consistent marker character everywhere is simpler than switching
      // between two depending on media kind.
      span.textContent = ' \u25A1 ';
      span.dataset.start = t;
      span.dataset.end = Math.min(t + step, seg.end);

      const sentimentAtT = (seg.sentimentSamples && seg.sentimentSamples[Math.floor((t - seg.start) / step)]) || {};
      const { cssStyle, lineHeightEm } = StylingEngine.computeWordStyle(normalizeSentimentVector(sentimentAtT), state.config);
      Object.assign(span.style, cssStyle);
      span.style.lineHeight = `${lineHeightEm}em`;

      span.addEventListener('click', () => seekTo(t));
      transcriptBody.appendChild(span);
      state.wordEls.push({ el: span, start: t, end: t + step, kind: 'silence', raw: sentimentAtT });
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

  // Applies the current state.config to every already-rendered word/
  // silence-marker span IN PLACE — updates each element's .style
  // properties directly rather than tearing down and recreating the DOM
  // (which is what renderTranscript() does). Only ever changes styling,
  // never text/structure/listeners, so it's safe to reuse existing
  // elements: computeWordStyle() always returns a fully exhaustive style
  // object (every property explicitly set on every call, even when a
  // sentiment is inactive), so there's no risk of a property left stuck
  // from a previous styling. Search highlights (a separate classList
  // state, untouched by .style assignment) survive this automatically —
  // no need to re-run search afterward the way a full render does.
  function restyleTranscriptInPlace() {
    state.wordEls.forEach(({ el: wEl, kind, raw }) => {
      const rawSentiment = kind === 'word' ? blendAudioVideoSentiment(raw) : raw;
      const { cssStyle, lineHeightEm } = StylingEngine.computeWordStyle(normalizeSentimentVector(rawSentiment), state.config);
      Object.assign(wEl.style, cssStyle);
      wEl.style.lineHeight = `${lineHeightEm}em`;
    });
  }

  let liveRestyleDebounceTimer = null;
  // Called on every Settings sidebar interaction (a styling dropdown, a
  // sensitivity slider, the Audio / Video Mix slider). The debounce here
  // is what makes "live" feel safe rather than risky: a dragged slider can
  // fire input events dozens of times a second, and normalization stats
  // (a couple of array sorts per sentiment across every word) plus a full
  // style pass across every rendered span isn't free on a long transcript.
  // Waiting for a short pause in activity means dragging always feels
  // instantly responsive (the slider's own position is native/immediate,
  // independent of this), while the transcript catches up a beat after you
  // stop, rather than queuing up dozens of expensive updates per second of
  // dragging. Same pattern already used for the search input's debounce.
  function scheduleLiveRestyle() {
    clearTimeout(liveRestyleDebounceTimer);
    liveRestyleDebounceTimer = setTimeout(() => {
      if (!state.analysis || !state.analysis.segments) return;
      state.normalizationStats = computeNormalizationStats(state.analysis.segments);
      restyleTranscriptInPlace();
    }, 120);
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
  // Settings sidebar
  // ---------------------------------------------------------------------
  function wireSettingsModal() {
    btnSettings.addEventListener('click', toggleSettingsSidebar);
    // Reuses the same toggle rather than a dedicated "close" function —
    // this button is only ever reachable while the sidebar is already
    // open, so toggling always means closing from here, and reusing it
    // keeps the gear icon's active-highlight state in sync automatically.
    btnCloseSidebar.addEventListener('click', toggleSettingsSidebar);
    btnRestoreDefaults.addEventListener('click', restoreDefaultsInPlace);
    avMixSlider.addEventListener('input', () => {
      state.config.audioVideoMix = parseInt(avMixSlider.value, 10);
      avMixValue.textContent = `${avMixSlider.value}%`;
      scheduleLiveRestyle();
    });
  }

  function toggleSettingsSidebar() {
    const isOpen = appEl.classList.toggle('sidebar-open');
    btnSettings.classList.toggle('active', isOpen);
  }

  // Audio / Video Mix only makes sense for video files with an audio
  // track — an audio-only file (or nothing loaded yet) has no video
  // component to mix with at all. Disables and visually pins the slider
  // display to "Audio only" in that case, WITHOUT touching the underlying
  // stored preference (state.config.audioVideoMix) — so a mix set while
  // viewing a video file is still remembered if a video is opened again
  // later in the same session, rather than being reset just from having
  // viewed an audio file in between. Called whenever the loaded file's
  // media kind might have changed (see applyAnalysisResult() /
  // loadFromSidecar()) — the sidebar can stay open continuously now, so
  // this needs to stay in sync with whatever file is currently loaded,
  // not just refreshed when the sidebar happens to open.
  function updateAvMixControl() {
    const isVideo = state.mediaKind === 'video';
    avMixSlider.disabled = !isVideo;
    avMixRow.classList.toggle('disabled', !isVideo);
    if (isVideo) {
      avMixSlider.value = state.config.audioVideoMix;
      avMixValue.textContent = `${state.config.audioVideoMix}%`;
    } else {
      avMixSlider.value = 0;
      avMixValue.textContent = '0%';
    }
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
        if (state.config.stylingMap[sentiment] === styling) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        state.config.stylingMap[sentiment] = select.value;
        scheduleLiveRestyle();
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
      slider.value = state.config.sensitivity[sentiment];
      const valueLabel = document.createElement('span');
      valueLabel.className = 'sensitivity-value';
      valueLabel.textContent = Number(slider.value).toFixed(2);
      slider.addEventListener('input', () => {
        state.config.sensitivity[sentiment] = parseFloat(slider.value);
        valueLabel.textContent = Number(slider.value).toFixed(2);
        scheduleLiveRestyle();
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
    state.config = {
      stylingMap: Object.assign({}, S.default_styling_map),
      sensitivity: Object.fromEntries(S.SENTIMENTS.map((s) => [s, S.default_sensitivity])),
      audioVideoMix: S.default_audio_video_mix
    };
    updateAvMixControl();
    renderSettingsTable();
    // A discrete click, not a rapid-fire drag — apply immediately rather
    // than through the debounce, which exists specifically to smooth out
    // dozens-of-events-per-second slider dragging.
    if (state.analysis && state.analysis.segments) {
      state.normalizationStats = computeNormalizationStats(state.analysis.segments);
      restyleTranscriptInPlace();
    }
  }

  // ---------------------------------------------------------------------
  // Save / load senticscript files
  //
  // A senticscript is one plain-text .senticscript.md file: a one-line HTML
  // comment, the readable transcript (so that's the first real thing a
  // person sees whether they use Transentic, a plain text editor, or a
  // Markdown viewer), then a fenced ```json block at the bottom carrying
  // everything needed to reload it (timings, sentiment data, the styling
  // config active when it was saved, and a link back to the source media).
  // The double extension (.senticscript.md) is deliberate: every OS's
  // file-type association looks only at the final extension, so this opens
  // in whichever Markdown/text editor is already the person's default,
  // with zero setup — while still being clearly labeled by sight.
  // ---------------------------------------------------------------------
  const SENTICSCRIPT_COMMENT =
    '<!-- Word-by-word sentiment data in JSON format immediately follows the transcription below. -->';

  async function saveTranscript(forceDialog) {
    if (!state.analysis) return;

    // crypto.randomUUID() here is the browser's built-in WebCrypto API
    // (available in any Chromium renderer regardless of Node/sandbox
    // settings) — not Node's crypto module, which the renderer can't
    // access directly.
    if (!state.guid) state.guid = crypto.randomUUID();

    const sidecar = {
      guid: state.guid,
      sourceFilePath: state.filePath,
      mediaKind: state.mediaKind,
      metadata: state.analysis.metadata || {},
      durationSec: state.analysis.durationSec,
      segments: state.analysis.segments
      // Sentiment Styling config deliberately NOT saved here — it's a
      // session-level preference (see loadFromSidecar()'s matching
      // comment), not something tied to any particular file. An earlier
      // version saved/restored it per-file, which meant opening an old
      // senticscript would silently overwrite your current styling setup
      // with whatever was active back when that file was saved.
    };

    const fileContent = buildSenticscriptFile(state.analysis.segments || [], sidecar);
    const suggestedName = (state.filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'transcript') + '.senticscript.md';

    const result = await window.electronAPI.saveTranscript({
      fileContent, suggestedName, forceDialog, currentSavedPath: state.savedPath
    });
    if (!result.canceled) {
      state.savedPath = result.filePath;
    }
  }

  function buildSenticscriptFile(segments, sidecar) {
    const markdown = buildMarkdown(segments);
    const jsonBlock = JSON.stringify(sidecar, null, 2);
    return [
      SENTICSCRIPT_COMMENT,
      '',
      markdown,
      '',
      '```json',
      jsonBlock,
      '```',
      ''
    ].join('\n');
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

  function loadFromSidecar(filePath, sidecar) {
    closeSearchBar(); // genuinely new content — an old search's matches/query wouldn't make sense here
    state.guid = sidecar.guid;
    state.savedPath = filePath;
    state.filePath = sidecar.sourceFilePath;
    state.mediaKind = sidecar.mediaKind;
    // state.config is deliberately left untouched here — Sentiment Styling
    // is a session-level preference, not something a file should carry or
    // override. Opening an old senticscript (possibly saved before a
    // styling was renamed/retired, or from manual experimentation) should
    // never silently change your current styling setup underneath you.
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

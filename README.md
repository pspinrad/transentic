# Transentic: Transcription with Feeling

A desktop app (Electron) that transcribes an audio or video file and renders
the transcript with per-word text styling driven by clause-level sentiment/
expression analysis, run entirely locally.

## Architecture

```
transentic/
├── config/settings.json     # single source of truth for every tunable constant
├── main.js                  # Electron main process: window, File menu, IPC, save/load
├── preload.js                # exposes a safe IPC + settings surface to the renderer
├── renderer/
│   ├── index.html            # Source pane + Transcript pane + Settings sidebar
│   ├── styles.css
│   ├── renderer.js            # player controls, transcript render, settings, sentiment pipeline, search
│   └── styling-engine.js      # pure fn: sentiment vector + user config -> CSS per word
└── backend/
    ├── analyze.py             # transcription + audio/video sentiment pipeline
    └── requirements.txt
```

The Electron main process spawns `backend/analyze.py` as a child process per
file and reads progress + a final JSON blob back — the frontend never talks
to Python directly, which keeps the door open to swapping the backend for a
different language or a remote service later without touching the UI.

## Setup

```bash
# Frontend
npm install

# Backend (use a virtualenv)
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
# also requires ffmpeg/ffprobe on PATH — see requirements.txt for install commands

# Run
cd ..
npm start
```

Font setup is a separate manual step — see "Fonts" below.

## Senticscript file format (.senticscript.md)

Save writes a single file with a double extension: a readable Markdown
transcript, followed by a fenced ` ```json ` block containing the GUID,
source file path, media kind, duration, and per-word/segment sentiment data.
The OS sees the final `.md` extension and opens it in whatever the user's
default Markdown editor is; `main.js` extracts the JSON block back out via
regex when re-opening a senticscript. There is no separate sidecar file —
everything lives in the one `.md` file.

**Styling config (stylingMap/sensitivity/audioVideoMix) is deliberately NOT
saved into the file.** It's a session-level preference, not tied to any
particular senticscript — see `state.config` and `loadFromSidecar()` /
`saveTranscript()` in `renderer.js`. Opening an old file never overrides your
current styling setup.

## The sentiment pipeline, end to end

This is the part most likely to need explaining to someone picking this up
fresh — it went through several iterations and the current shape reflects
real, sometimes counterintuitive lessons learned along the way.

### 1. Clause-level chunking, not per-word (backend)

`analyze.py`'s `build_segments()` does NOT run the audio/video sentiment
models once per word. Whisper's own segment boundaries (natural acoustic
pauses) are used as the base "clause" unit — one sentiment analysis pass per
clause, and every word within it shares that single result. A clause longer
than `max_chunk_sec` (currently 6s) gets split further, always at word
boundaries, via `split_into_chunks()`.

Why: sentiment expressed through tone/expression operates at clause/sentence
granularity in practice, not word-by-word — per-word analysis produced
noisy, flickering values that didn't track well with what a viewer actually
perceives. Clause-level analysis also gives the audio model real multi-second
signal instead of sub-second clips, and lets video frame-sampling average
across many more frames per chunk.

**Known trade-off, actively being investigated as of the last session:** a
clause can span several seconds, and every word in it shares one value
reflecting the *whole* clause — so a word early in a clause can show styling
that's really influenced by something that happens later in that same
clause. This shows up as a perceived "lag" of roughly a second between when
a viewer notices an emotional shift and when the transcript visibly reflects
it. `max_chunk_sec` is the tuning knob if this needs to be tightened at the
cost of some of the noise-reduction benefit.

### 2. Separate audio/video components, blended at DISPLAY time (backend writes, frontend blends)

For video files, each word's JSON entry has `audioSentiment` and
`videoSentiment` as two separate objects — NOT a single pre-blended
`sentiment` field (that was tried and removed; it was redundant, always
derivable as a weighted average of the two, and baking in a fixed ratio at
analysis time would have made the mix un-adjustable after the fact). Audio-
only files have only `audioSentiment` (named that way purely for schema
consistency, even though there's no video counterpart).

The frontend's `blendAudioVideoSentiment()` in `renderer.js` mixes these at
whatever ratio the Settings sidebar's Audio / Video Mix slider is currently
set to (`state.config.audioVideoMix`, 0=audio only, 100=video only),
re-computed live as the slider moves — no re-analysis needed to change the
mix. Falls back to a single available field (whichever of `audioSentiment`/
`sentiment` exists) when there's nothing to blend — audio-only files, silence
samples (video-only by design), or files saved before this schema existed.

**Also actively being investigated:** whether the two underlying models'
raw output scales are directly comparable. DeepFace (7-class Ekman softmax)
and the wav2vec2 SER model (8-class) weren't built together and may have
different typical spreads — meaning "100% Video" could generically look
weaker than "0% Audio" even with correct mixing, simply because one model's
raw values clear the styling gate less often than the other's. Not yet
confirmed either way — see `sentiment_calibration_multipliers` below, which
is the existing mechanism for this exact kind of cross-model/cross-sentiment
scale correction if it turns out to be needed for a whole model, not just
one sentiment.

### 3. Three-stage normalization (frontend, `renderer.js`)

Applied unconditionally (not an optional mode) to every senticscript,
recomputed whenever the audio/video mix changes (since that changes the
underlying blended values), via `computeNormalizationStats()` +
`normalizeSentimentVector()`:

1. **Adaptive per-sentiment elevated threshold.** Some speakers show one
   sentiment (originally noticed: Sad) elevated across most of a file
   regardless of content — a facial-structure or vocal-delivery bias, not
   real per-word signal. Each sentiment's own median + `k × MAD` (median
   absolute deviation) sets its own "elevated" bar for that file — a
   standard robust-outlier statistic, floored at
   `normalization_elevated_threshold` so a sentiment that's genuinely flat
   throughout a file never has tiny noise misread as elevated.
   `normalization_mad_multiplier` is `k`; no hard ceiling, but past the
   point where `median + k×MAD` exceeds 1.0, it's practically inert since
   nothing can exceed an unreachable threshold.
2. **Frequency-based dampening.** How often a sentiment crosses its
   (adaptive) threshold determines a single multiplier: `1 - frequency`.
   Elevated most of the time → strongly suppressed; rarely elevated → left
   alone. (An earlier percentile-rescale approach was tried and abandoned —
   it backfired badly for genuinely sparse sentiments; see the comment
   above `computeNormalizationStats()` for the full story if this ever
   needs revisiting.)
3. **Hard gate, no rescale.** Anything below `normalized_min_style_threshold`
   is zeroed out — no styling at all. Anything above passes through at its
   own dampened value, NOT rescaled back to the full 0-1 range — a
   gate-then-rescale variant was tried first and made typical (non-extreme)
   outliers look weaker, not stronger, since rescaling compresses everything
   short of a near-1.0 value. Currently 0.25 (started at 0.5, found too
   aggressive — see `normalizeSentimentVector()`'s comment for the reasoning
   behind picking a compromise value).

### 4. Cross-file calibration (frontend)

`sentiment_calibration_multipliers` in settings.json — a fixed per-sentiment
multiplier applied before anything else, for a bias that shows up
consistently across many different files/speakers rather than being
specific to one file (which the adaptive normalization above already
handles). Currently only Sad is discounted (0.6) — both underlying models
have a documented reason to over-trigger it specifically; see the comment
above `applyCalibration()` in `renderer.js`.

## Live styling updates (Settings sidebar)

The Settings pane is a persistent, collapsible sidebar (not a modal) —
toggle via the gear icon or the × inside the sidebar. Every control applies
live, no Save button: `scheduleLiveRestyle()` debounces (120ms, same pattern
as the search input) so a dragged slider doesn't trigger dozens of expensive
updates per second, and `restyleTranscriptInPlace()` updates existing DOM
elements' styles directly rather than tearing down and rebuilding the whole
transcript — safe because `computeWordStyle()` always returns a fully
exhaustive style object (every property explicitly set every call), so
there's no risk of a stale property surviving from a previous styling.

## Transcript search (Cmd/Ctrl+F)

Custom-built, not Electron's `findInPage` API — matches phrases across word
boundaries (not just within one word span) by joining all words into one
searchable string with position tracking, so "great guy" finds an actual
adjacent occurrence rather than requiring both words in one span. A null
character separates words across a silence gap so a phrase can't falsely
match by bridging across one. See `buildSearchIndex()` in `renderer.js`.

## Fonts: Roboto Flex, bundled locally

The app uses [Roboto Flex](https://fonts.google.com/specimen/Roboto+Flex), a
variable font with `wght` (weight), `wdth` (width), and `slnt` (slant) axes —
all three are used directly by the styling engine (Weight, Space-letters/
Crowd-letters, and Forward-slant respectively).

**Setup step required:** the variable font file itself isn't included in
this repo/zip — binary font files can't be generated by an AI coding
assistant, only referenced by path. Download it yourself and place it at
`renderer/assets/fonts/RobotoFlex-Variable.woff2`:

- Run `npm install @fontsource-variable/roboto-flex`, then find
  **`roboto-flex-latin-standard-normal.woff2`** inside
  `node_modules/@fontsource-variable/roboto-flex/files/` — specifically
  the `standard` variant, not `wght`. The plain `wght` file only has the
  weight axis — `font-stretch` and `font-style: oblique` would silently do
  nothing with it.
- Or download directly from Google Fonts' Roboto Flex page — its "Download
  family" button gives a single variable file with every axis (typically a
  `.ttf`; if you go this route, name it `RobotoFlex-Variable.ttf` and update
  the `.woff2`/`woff2-variations` references in `styles.css`'s `@font-face`
  rule to `.ttf`/`truetype-variations` to match).

Licensed under the SIL Open Font License 1.1 (free, including commercial use).

### Forward-slant uses the font's real `slnt` axis, not a CSS transform

`transform: skewX()` doesn't reflow layout, which caused real hit-testing
bugs (clicks landing on the wrong word near a slanted one). `font-style:
oblique <angle>deg` reshapes glyphs within their normal metrics instead. Per
the OpenType spec, `slnt` only ever implements a right lean in real fonts —
the original "Backward-slant" styling was retired for this reason and
replaced with **Space-letters**/**Crowd-letters** (letter-spacing +
font-stretch together), which have none of `transform`'s hit-testing risk.

## Video file timestamp normalization

`analyze.py`'s `normalize_timestamps()` re-muxes every input file (fast,
lossless, no re-encoding) with `-avoid_negative_ts make_zero` before any
other processing, and everything downstream (duration, audio extraction,
video frame reading) uses that normalized copy rather than the original
path. This fixes a real, verified issue: some source files have a
mismatched/negative start timestamp between their audio and video streams,
which caused visible audio/video playback drift in Chromium-based players
(including this app's own `<video>` element) — and would have *also*
silently misaligned this pipeline's own audio-vs-video sentiment sampling,
since word timestamps come from a separately-extracted audio track while
video frames are read from the original file. Adds a small, real processing
cost to every file in exchange for not needing to trust that any given
source's timestamps are clean.

## Video frame downscaling

`MAX_FRAME_DIMENSION` in `analyze.py` downscales every video frame to at
most 720px on its longer side before facial-expression analysis (never
upscales a smaller source). DeepFace's cost scales with pixel count — this
was the fix for a real, measured performance issue (a 2880×2160 source
originally took ~3000ms per facial-analysis call; after downscaling, ~400ms,
matching native-720p sources). Video seeking (`SequentialVideoReader`, a
hybrid sequential-read/seek strategy) was also optimized along the way but
turned out to be a much smaller factor once resolution was the real lever.

## Processing time (measured, not estimated)

For video with a visible face, at source resolutions at or under 720p:

| Stage | Measured cost per chunk |
|---|---|
| Audio sentiment (wav2vec2 SER) | ~50–90ms |
| Facial expression (DeepFace, sampled frames) | ~370–430ms |
| **Total** | **~400–500ms per clause chunk** |

Audio-only files (no facial analysis at all) are correspondingly much
faster. Since analysis is now per-clause rather than per-word, total
processing time for a given file is lower than these per-unit numbers might
suggest — fewer chunks than there were words.

## UI details worth knowing

- **App name / menu labels**: `app.setName('Transentic')` + an explicit
  `role: 'appMenu'` entry in `main.js`'s menu template, since Electron
  defaults to "Electron" in unpackaged dev mode otherwise. Menu items say
  "Senticscript" throughout (Save/Save As/Open), not "Transcript."
- **Non-speech markers**: rendered as □ (U+25A1 WHITE SQUARE), not a dash —
  chosen because a dash barely shows slant/weight/other shape-based
  stylings, while a square has real width/height for them to act on.
- **Open dialogs remember their last directory** — tracked separately per
  operation (Open Media vs. Open Senticscript), in-memory only (resets each
  app launch, not persisted to disk).
- **stderr from the Python subprocess is forwarded live** to the terminal
  running `npm start` (see `main.js`) — previously silently swallowed unless
  the process crashed.

## Known limitations

- **Per-clause audio-emotion inference is still not a calibrated
  instrument** — better than the original per-word noise, but the
  underlying SER model quality is the piece most likely to need swapping
  out after more real-world use. Current model:
  `ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition` (RAVDESS-
  trained), loaded with a manual classification-head weight remap — see
  `load_audio_emotion_pipeline()`'s docstring for why that's necessary
  (several community wav2vec2 SER checkpoints silently produce untrained/
  random predictions without it).
- **DeepFace's default emotion model** is a compact CNN over the 7 Ekman
  expressions — not a specialized state-of-the-art model, so subtle
  expressions are a likely accuracy shortfall, and its output scale may not
  directly match the audio model's (see "Separate audio/video components"
  above).
- **Multiple speakers / off-camera speakers** aren't handled — takes the
  largest detected face per frame, assumes one on-camera speaker.
- **The clause-chunking timing lag** described above — not yet resolved,
  `max_chunk_sec` is the tuning knob if it needs addressing.

## Full settings.json reference

| Key | Purpose |
|---|---|
| `SENTIMENTS`, `STYLINGS` | The fixed lists driving both the Settings table and the styling engine |
| `min/max_font_size`, `min/max_font_weight`, `min/max_underline_gray`, `max_forward_slant`, `min/max_letter_spacing_*_em`, `max_wdth_*_delta`, `max_baseline_bounce_em`, `min/max_text_channel`, `min/max_bkgnd_channel` | Per-styling min/max ranges the styling engine interpolates between |
| `wordless_sample_rate_sec` | Cadence of □ markers / facial-expression sampling during silence (video only) |
| `skip_interval_sec` | Step size when scanning forward through long low-confidence/silent stretches to find where processable speech resumes (`mark_unprocessable_segments()`) — not a full-file sampling interval |
| `max_chunk_sec` | Clause-chunking cap — see pipeline section above |
| `default_sensitivity`, `sensitivity_gain_multiplier`, `response_curve_k` | Sensitivity slider math — gain + a log response curve boosting visibility near baseline |
| `default_audio_video_mix` | Default position (0-100) of the Audio/Video Mix slider |
| `normalization_elevated_threshold`, `normalization_mad_multiplier`, `normalized_min_style_threshold` | The three-stage normalization pipeline — see above |
| `sentiment_calibration_multipliers` | Fixed cross-file per-sentiment bias correction — see above |
| `default_styling_map` | Default Sentiment → Styling assignment |
| `seek_step_sec`, `playback_speeds`, `default_speed` | Source pane playback controls |
| `error_fully_unprocessable`, `error_partial_gap_inline` | User-facing error copy for unprocessable audio |

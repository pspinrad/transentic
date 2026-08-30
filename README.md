# Enhanced Transcript

A desktop app (Electron) that transcribes an audio or video file and renders
the transcript with per-word text styling driven by moment-by-moment
sentiment/expression analysis, run entirely locally.

## Architecture

```
enhanced-transcript-app/
├── config/settings.json     # single source of truth for every tunable constant
├── main.js                  # Electron main process: window, File menu, IPC, save/load
├── preload.js                # exposes a safe IPC + settings surface to the renderer
├── renderer/
│   ├── index.html            # Source pane + Transcript pane + Settings modal
│   ├── styles.css
│   ├── renderer.js            # player controls, transcript render, settings modal, sync
│   └── styling-engine.js      # pure fn: sentiment vector + user config -> CSS per word
└── backend/
    ├── analyze.py             # transcription + audio/video sentiment pipeline
    └── requirements.txt
```

The Electron main process spawns `backend/analyze.py` as a child process per
file and reads one JSON blob from its stdout — the frontend never talks to
Python directly, which keeps the door open to swapping the backend for a
different language or a remote service later without touching the UI.

## Setup

```bash
cd ~/workspace/transentic

# Frontend
npm install

# Backend (use a virtualenv)
cd backend
rm -rf venv
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
# also requires ffmpeg/ffprobe on PATH — see requirements.txt for install commands

# Run
cd ..
npm start
```

I wasn't able to actually run `npm install` / `pip install` / a live model
download in this environment (no network access), so this is an
architecturally-complete but not yet end-to-end-execution-tested build.
Expect some amount of debugging on first run — model download sizes,
package version pins, and OS-specific ffmpeg quirks are the likeliest
friction points.

## Design decisions made per your answers

- **Platform:** Electron desktop app with a local Python backend, spawned
  per file via `child_process.spawn`.
- **Duplicate styling conflicts:** if two Sentiments are assigned the same
  Styling, their effective (post-sensitivity) values are **averaged**, not
  maxed. See `styling-engine.js` → `computeWordStyle`.
- **Sensitivity sliders are a gain, not a threshold:** `effective = clamp(raw
  * slider * 2, 0, 1)`. At 0.5 (default) this is a neutral 1:1 passthrough;
  at 0 every styling goes flat/neutral (plain-text transcript, per spec); at
  1.0 it doubles the raw signal, clamped at full intensity.
- **Non-speech sentiment (pauses/applause):** audio-only files render plain
  neutral dashes — no speech-emotion model runs on non-speech audio. Video
  files instead sample DeepFace's facial expression across each gap, since
  that reads perfectly well whether or not someone is talking; only the
  audio side of "no sentiment during silence" ever applied.
- **Face briefly out of frame:** falls back to audio-only sentiment for that
  word/window rather than flagging it as an unprocessable gap; transcription
  continues uninterrupted.
- **Save format:** Markdown transcript (plain, readable) + a `.sentiment.json`
  sidecar carrying the GUID, word timings, sentiment vectors, and the styling
  config active when saved. `Save`/`Save As` write both files together with
  matching base filenames; `File → Open Saved Transcript…` reads the sidecar
  back in (including the path to the original source media, so playback sync
  still works without re-running analysis).

## Underline: grayscale, not thickness

Implemented as you suggested: the underline color ranges from a pale,
near-invisible gray at low sentiment to solid black at maximum, rather than
varying line thickness. `min_underline_gray`/`max_underline_gray` in
`config/settings.json` control the range.

## Forward/backward slant: the one fragile styling

`skewX()` on an inline word span doesn't reflow layout, so at high skew
angles neighboring words can visually crowd or overlap. `styling-engine.js`
compensates with proportional horizontal padding on skewed words, but this
is the styling most likely to need visual tuning once you see it rendered
against real transcript text — if it still looks cramped, dropping
`max_forward_slant`/`max_backwards_slant` from 20° to something like 10–12°
in `settings.json` is the quickest fix.

## Processing time (estimate, not yet benchmarked)

For 30 seconds of well-lit, well-recorded speaking video on a modern
CPU-only laptop:

| Stage | Rough estimate |
|---|---|
| Transcription (faster-whisper, `small`) | 15–60 sec |
| Audio sentiment (wav2vec2 SER, per word) | 5–20 sec |
| Facial expression (FER, sampled ~2 fps) | 10–40 sec |
| **Total** | **~1–3 min per 30 sec of source** |

That's roughly 2–6x real time — well under the one-hour-per-30-seconds
threshold you were checking against. A discrete GPU would speed this up
further, but isn't required for a proof-of-concept.

## Known limitations / things to sanity-check on first real run

- **Per-word audio-emotion inference is inherently noisy.** Speech-emotion
  models are typically trained on multi-second clips, not single words.
  `audio_sentiment_for_window()` widens each word's window by ±0.5s for
  stability, but expect some jitter — this is a reasonable proof-of-concept
  starting point, not a calibrated instrument.
- **The chosen SER model's label set** (`r-f/wav2vec-english-speech-emotion-recognition`,
  trained RAVDESS-style) is one of the few local/open models whose 8 classes
  actually cover all six of your Sentiments (plus neutral/calm, which are
  dropped). Verify it downloads and performs as expected — SER model quality
  varies more than ASR quality does, and this is the piece most likely to
  need swapping out after you see real output.
- **`fer`'s underlying TensorFlow model** is a few years old at this point;
  it's still reasonable for a proof-of-concept but is the weakest link on
  accuracy if the speaker's expressions are subtle.
- **Multiple speakers / off-camera speakers** aren't handled — the pipeline
  assumes one on-camera speaker and takes the largest detected face per
  frame. Multi-speaker diarization would be a natural next step, not
  currently in scope per the spec as written.

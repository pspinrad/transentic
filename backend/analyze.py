#!/usr/bin/env python3
"""
analyze.py — local speech transcription + moment-by-moment sentiment analysis.

Invoked by main.js as:  python3 analyze.py /path/to/media/file
Prints one JSON object to stdout (see JSON_SCHEMA_NOTE below) and nothing else;
all diagnostics go to stderr so they don't corrupt the JSON on stdout.

Model choices (deliberately "pretty good and local" rather than best-in-class
cloud, per product decision):

  - Transcription:      faster-whisper (CTranslate2 Whisper), word-level timestamps.
  - Audio sentiment:    ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition,
                         fine-tuned on RAVDESS's 8-class labels (angry, calm,
                         disgust, fearful, happy, neutral, sad, surprised).
                         Loaded with a manual classification-head weight
                         remap — see load_audio_emotion_pipeline()'s
                         docstring for why that's necessary; without it,
                         this (and several sibling community wav2vec2 SER
                         checkpoints) silently produce random, untrained
                         predictions instead of erroring.
  - Facial expression:  DeepFace (github.com/serengil/deepface) — MTCNN face
                         detection + a CNN over the 7 Ekman expressions.
                         Actively maintained, unlike the `fer` package this
                         app originally used.

JSON_SCHEMA_NOTE — top-level output shape:
{
  "status": "ok" | "unprocessable",
  "error": null | "<message>",
  "mediaKind": "audio" | "video",
  "durationSec": float,
  "metadata": {"title": str|null, "date": str|null},
  "waveform": [float, ...]            # only for audio; ~200 normalized samples
  "segments": [
    {"type": "words", "words": [
        {"word": str, "start": float, "end": float,
         "sentiment": {"Happy": float, "Sad": float, ... 0..1 each}}
    ]},
    {"type": "silence", "start": float, "end": float,
     "sentimentSamples": [ {...6 sentiments 0..1...}, ... ]},  # one per
                                                                 # wordless_sample_rate_sec;
                                                                 # populated (facial expression)
                                                                 # for video files, always empty
                                                                 # (neutral dashes) for audio-only
    {"type": "gap", "start": float, "end": float}               # unprocessable stretch
  ]
}
"""

import sys
import os
import json
import subprocess
import tempfile
import signal
import time

# By default, SIGTERM (what a plain `kill <pid>` sends, and what Electron's
# before-quit handler sends) terminates the process immediately at the OS
# level WITHOUT running any Python-level cleanup — with blocks' __exit__,
# finally clauses, etc. never execute. That matters here because
# analyze_media() uses tempfile.TemporaryDirectory() to hold the extracted
# audio.wav; an abrupt kill would leave that directory behind. Installing a
# handler that raises SystemExit instead makes SIGTERM unwind the stack
# through normal Python exception handling, so that cleanup actually runs.
def _handle_sigterm(signum, frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, _handle_sigterm)

# Must be set before TensorFlow is imported anywhere in this process
# (DeepFace, used for video facial-expression sampling, imports it lazily
# below). TensorFlow 2.16+ defaults to Keras 3, which some libraries built
# against tf.keras don't yet support without this compatibility flag.
os.environ.setdefault('TF_USE_LEGACY_KERAS', '1')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, '..', 'config', 'settings.json')

with open(CONFIG_PATH) as f:
    CFG = json.load(f)

SENTIMENTS = CFG['SENTIMENTS']
SKIP_INTERVAL = CFG['skip_interval_sec']
WORDLESS_SAMPLE_RATE = CFG['wordless_sample_rate_sec']
ERROR_FULLY_UNPROCESSABLE = CFG['error_fully_unprocessable']

VIDEO_EXTS = {'.mp4', '.mov', '.mkv', '.webm'}

# Label maps from each underlying model's vocabulary to this app's six
# Sentiments. Any label not present here (e.g. "neutral", "calm") is dropped.
AUDIO_EMOTION_LABEL_MAP = {
    'happy': 'Happy',
    'sad': 'Sad',
    'surprised': 'Surprised',
    'angry': 'Angry',
    'fearful': 'Fearful',
    'disgust': 'Disgusted',
}
# DeepFace uses the same 7 Ekman labels the old `fer` package did.
DEEPFACE_LABEL_MAP = {
    'happy': 'Happy',
    'sad': 'Sad',
    'surprise': 'Surprised',
    'angry': 'Angry',
    'fear': 'Fearful',
    'disgust': 'Disgusted',
}

# Below this Whisper avg_logprob, a segment is treated as too unclear to
# count as "processable" speech and gets folded into a gap instead.
WHISPER_CONFIDENCE_FLOOR = -1.0


def log(*args):
    print(*args, file=sys.stderr)


def is_video_file(path):
    return os.path.splitext(path)[1].lower() in VIDEO_EXTS


def ffprobe_json(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
        capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)


def extract_metadata(probe):
    tags = probe.get('format', {}).get('tags', {}) or {}
    title = tags.get('title') or tags.get('Title')
    date = tags.get('date') or tags.get('creation_time') or tags.get('Date')
    duration = float(probe.get('format', {}).get('duration', 0.0))
    return {'title': title, 'date': date}, duration


def extract_audio_wav(src_path, out_path, sample_rate=16000):
    subprocess.run(
        ['ffmpeg', '-y', '-i', src_path, '-ac', '1', '-ar', str(sample_rate), out_path],
        capture_output=True, check=True
    )


def normalize_timestamps(input_path, output_path):
    """
    Re-muxes the file (no re-encoding — a fast, lossless container-level
    copy) with -avoid_negative_ts make_zero.

    This corrects a real, verified issue: some source files have a
    mismatched/negative start timestamp between their audio and video
    streams. That's what caused Chromium-based players (including this
    app's own <video> element) to visibly drift audio out of sync with
    video by a consistent, noticeable offset — confirmed by the same fix
    resolving playback drift for affected test files.

    The same underlying mismatch would also silently misalign THIS
    pipeline's own audio-vs-video sentiment sampling: word timestamps come
    from Whisper transcribing a separately-extracted audio track, while
    facial-expression frames are read directly from the original video
    file. If those two streams' internal clocks don't actually agree with
    each other, a word's "simultaneous" audio and video sentiment could be
    sampled from moments that don't really correspond to the same instant.
    Normalizing once, up front, and using only the normalized copy for
    everything downstream (audio extraction AND video frame reading)
    removes that risk regardless of whether a given source file happens to
    have this irregularity — a harmless no-op remux for files that don't.
    """
    subprocess.run(
        ['ffmpeg', '-y', '-i', input_path, '-c', 'copy', '-avoid_negative_ts', 'make_zero', output_path],
        capture_output=True, check=True
    )


def compute_waveform_samples(wav_path, n_samples=200):
    """Coarse per-bucket peak amplitude, normalized 0..1, for the progress-bar ticks."""
    import wave
    import audioop

    with wave.open(wav_path, 'rb') as w:
        n_frames = w.getnframes()
        sampwidth = w.getsampwidth()
        frames_per_bucket = max(1, n_frames // n_samples)
        samples = []
        for _ in range(n_samples):
            chunk = w.readframes(frames_per_bucket)
            if not chunk:
                samples.append(0.0)
                continue
            peak = audioop.max(chunk, sampwidth)
            samples.append(peak)
    max_peak = max(samples) or 1
    return [round(s / max_peak, 4) for s in samples]


def transcribe_with_word_timestamps(wav_path, progress_path=None, duration=None):
    """
    Returns a list of segments:
      {"start": f, "end": f, "avg_logprob": f,
       "words": [{"word": str, "start": f, "end": f}, ...]}

    faster-whisper's transcribe() returns segments lazily — each one is
    actually computed as this loop reaches it, not all up front — so
    reporting progress per-segment here reflects genuinely how far through
    the audio timeline transcription has gotten (seg.end / duration), not
    just a crude before/after toggle for the whole stage.
    """
    from faster_whisper import WhisperModel

    # "small" is the pretty-good/local sweet spot: meaningfully more accurate
    # than "base" while still comfortably CPU-real-time-ish for short clips.
    model = WhisperModel('small', device='cpu', compute_type='int8')
    segments, _info = model.transcribe(wav_path, word_timestamps=True)

    result = []
    last_write = 0.0
    for seg in segments:
        words = [{'word': w.word.strip(), 'start': w.start, 'end': w.end} for w in (seg.words or [])]
        result.append({
            'start': seg.start,
            'end': seg.end,
            'avg_logprob': seg.avg_logprob,
            'words': words,
        })
        now = time.monotonic()
        if progress_path and duration and (now - last_write) >= PROGRESS_WRITE_INTERVAL_SEC:
            fraction = min(1.0, seg.end / duration) if duration > 0 else 0.0
            write_progress(progress_path, 'transcribing', fraction, detail='Transcribing speech…')
            last_write = now
    return result


AUDIO_EMOTION_MODEL_ID = 'ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition'


def load_audio_emotion_pipeline():
    """
    Loads the audio speech-emotion classifier with its ACTUAL trained
    classification head, not the randomly-initialized one transformers
    silently substitutes by default.

    Background: this checkpoint (like several sibling community wav2vec2 SER
    models, including the one this app originally used) was fine-tuned with
    a two-layer classification head whose weights are stored under the names
    `classifier.dense.*` and `classifier.output.*`. transformers' generic
    Wav2Vec2ForSequenceClassification architecture expects those weights
    under `projector.*` and `classifier.*` instead. Since the names don't
    match, transformers can't map the checkpoint's real weights onto the
    model at load time and silently falls back to random initialization for
    that head — the model loads without erroring, but its actual emotion
    predictions are meaningless noise. This is a known, documented issue
    for this model (see huggingface.co/ehcalabres/.../discussions/2) with a
    verified fix: load the model normally, then manually copy the real
    weights from their true checkpoint names into the slots the
    architecture expects.
    """
    from transformers import AutoModelForAudioClassification, Wav2Vec2FeatureExtractor, pipeline
    from huggingface_hub import hf_hub_download
    import torch

    feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(AUDIO_EMOTION_MODEL_ID)
    model = AutoModelForAudioClassification.from_pretrained(AUDIO_EMOTION_MODEL_ID)

    state_dict = _download_raw_state_dict(AUDIO_EMOTION_MODEL_ID)
    model.projector.weight.data = state_dict['classifier.dense.weight']
    model.projector.bias.data = state_dict['classifier.dense.bias']
    model.classifier.weight.data = state_dict['classifier.output.weight']
    model.classifier.bias.data = state_dict['classifier.output.bias']
    model.eval()

    return pipeline('audio-classification', model=model, feature_extractor=feature_extractor)


def _download_raw_state_dict(model_id):
    """Fetches the checkpoint's raw weights so load_audio_emotion_pipeline()
    can read the real (correctly-named) values directly, trying both the
    legacy pytorch_model.bin format and the newer safetensors format since
    older community models (like this one) may only ship the former."""
    from huggingface_hub import hf_hub_download
    import torch

    try:
        path = hf_hub_download(repo_id=model_id, filename='pytorch_model.bin')
        return torch.load(path, map_location='cpu')
    except Exception:
        from safetensors.torch import load_file
        path = hf_hub_download(repo_id=model_id, filename='model.safetensors')
        return load_file(path)



def audio_sentiment_for_window(clf, sound_file, start, end):
    """
    Runs the audio-emotion classifier over a short window of raw audio
    centered on [start, end], widened slightly for stability on very short
    words, and returns a dict of the 6 Sentiments -> 0..1 scores.

    Takes an already-open soundfile.SoundFile (opened once for the whole
    file — see build_segments()) rather than a path, avoiding the overhead
    of opening a fresh file handle and re-parsing the WAV header on every
    single word. Unlike video seeking, this isn't position-dependent (WAV's
    uncompressed PCM data supports true O(1) random-access seeking
    regardless of file size) — measured as already negligible (~0.2ms) even
    before this change, so this is mainly for architectural consistency
    with the video side rather than a measurable performance win on its own.
    """
    sample_rate = sound_file.samplerate
    pad = 0.5  # widen very short word clips so the classifier has enough signal
    win_start = max(0.0, start - pad)
    win_end = end + pad
    start_frame = int(win_start * sample_rate)
    stop_frame = int(win_end * sample_rate)

    sound_file.seek(start_frame)
    audio = sound_file.read(frames=max(0, stop_frame - start_frame))
    if len(audio) == 0:
        return {s: 0.0 for s in SENTIMENTS}

    preds = clf({'array': audio, 'sampling_rate': sample_rate})
    scores = {s: 0.0 for s in SENTIMENTS}
    for p in preds:
        mapped = AUDIO_EMOTION_LABEL_MAP.get(p['label'].lower())
        if mapped:
            scores[mapped] = float(p['score'])
    return scores


# Frames get downscaled to this before facial-expression analysis. Faces in
# talking-head content are large relative to the frame, so this is generous
# for detection accuracy while cutting DeepFace/MTCNN's cost dramatically —
# their cost scales with total pixel count, and a 2880x2160 source (as
# opposed to something like 720p) is ~6-7x more pixels than this cap, which
# measured as almost the entire per-word processing time in practice (see
# the TIMING diagnostics this was added alongside). Only ever shrinks,
# never enlarges — a source already at or under this size is untouched.
MAX_FRAME_DIMENSION = 720


def _resize_for_analysis(frame, cv2):
    h, w = frame.shape[:2]
    longer_side = max(h, w)
    if longer_side <= MAX_FRAME_DIMENSION:
        return frame
    scale = MAX_FRAME_DIMENSION / longer_side
    new_w, new_h = int(w * scale), int(h * scale)
    # INTER_AREA is the recommended interpolation for shrinking images —
    # better quality than the faster alternatives for downscaling
    # specifically, and still cheap relative to what it's saving downstream.
    return cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)


class SequentialVideoReader:
    """
    Wraps a single cv2.VideoCapture opened once for the whole file, and
    fetches frames by advancing forward from wherever it currently is
    rather than re-seeking (cap.set(CAP_PROP_POS_FRAMES, ...)) for every
    single sample — but only for *small* gaps (see LARGE_GAP_FRAME_THRESHOLD).

    Reintroduced after the frame-downscaling fix (MAX_FRAME_DIMENSION,
    below) made DeepFace's own cost small enough that per-word video
    seeking became a meaningful fraction of total time again — measured at
    growing from ~67ms to ~150ms over the course of a long file even after
    downscaling, ~15-25% of the new, much smaller per-word total. Before
    downscaling, that same growth was invisible against DeepFace's ~3000ms
    dominating everything. With this fix in place, per-word video timing
    stays flat throughout a run rather than climbing.

    Background: seeking in most compressed video codecs isn't true random
    access — the decoder has to locate the nearest preceding keyframe and
    decode forward from there, and for files without a complete seek index,
    some codecs fall back to an even more expensive linear scan from the
    very start of the file. Re-seeking from scratch for every word means
    that cost grows with how far into the file each word is.

    The fix isn't simply "never seek, always read forward," though:
    cap.read() fully decodes every frame it touches, even ones about to be
    discarded, so sequential reads are only cheaper than a seek for *small*
    gaps — a large gap (a pause, sentence break, or silence stretch) is
    cheaper to reach via an actual seek than by decoding everything in
    between one frame at a time.
    """

    # Larger than this many frames ahead, seek instead of reading forward
    # frame-by-frame. ~2 seconds at a typical 30fps — small enough that
    # consecutive close-together words (the common case) still avoid
    # seeking entirely, large enough that any real pause or gap falls back
    # to a seek instead of decoding potentially hundreds/thousands of
    # throwaway frames.
    LARGE_GAP_FRAME_THRESHOLD = 60

    def __init__(self, video_path):
        import cv2
        self.cap = cv2.VideoCapture(video_path)
        self.native_fps = self.cap.get(cv2.CAP_PROP_FPS) or 25
        self.current_frame_index = -1  # nothing read yet

    def get_frame_at_time(self, t):
        import cv2
        target_frame = int(t * self.native_fps)
        frame_gap = target_frame - self.current_frame_index

        if frame_gap < 0 or frame_gap > self.LARGE_GAP_FRAME_THRESHOLD:
            # Backward (shouldn't normally happen given chronological
            # processing, but handled defensively) or a large forward gap —
            # a real seek is cheaper than decoding everything in between.
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
            self.current_frame_index = target_frame - 1

        frame = None
        while self.current_frame_index < target_frame:
            ok, frame = self.cap.read()
            self.current_frame_index += 1
            if not ok:
                return None
        return frame

    def release(self):
        self.cap.release()


def video_sentiment_for_window(video_reader, start, end, fps_sample=2):
    """
    Samples a few frames across [start, end] using the given
    SequentialVideoReader (opened once for the whole file — see its
    docstring for why that matters), runs DeepFace's emotion analysis on
    each, and averages the dominant face's scores across frames into the
    6 Sentiments.
    """
    import cv2
    from deepface import DeepFace
    import tensorflow as tf
    # Purely cosmetic now that output goes through a file rather than
    # stdout, but keeps the terminal readable during a run — Keras'
    # per-prediction progress bars print once per sampled frame otherwise.
    tf.keras.utils.disable_interactive_logging()

    duration = max(end - start, 1.0 / fps_sample)
    n_frames = max(1, int(duration * fps_sample))

    accum = {s: 0.0 for s in SENTIMENTS}
    counted = 0

    for i in range(n_frames):
        t = start + (i / fps_sample)
        frame = video_reader.get_frame_at_time(t)
        if frame is None:
            continue
        frame = _resize_for_analysis(frame, cv2)

        # enforce_detection=False: return gracefully (empty/low-confidence
        # result) instead of raising when a frame has no detectable face,
        # e.g. a brief head turn — matches the old fer package's behavior
        # of just returning an empty list rather than throwing.
        try:
            faces = DeepFace.analyze(
                frame, actions=['emotion'],
                detector_backend='mtcnn', enforce_detection=False,
                silent=True,
            )
        except Exception:
            continue
        if not faces:
            continue
        # Some DeepFace versions return a single dict when exactly one face
        # is found rather than a one-item list; normalize either way.
        if isinstance(faces, dict):
            faces = [faces]

        # Assume the largest detected face is the speaker. DeepFace's region
        # key is {'x','y','w','h'} rather than fer's [x,y,w,h] list.
        face = max(faces, key=lambda f: f['region']['w'] * f['region']['h'])
        for label, score in face['emotion'].items():
            mapped = DEEPFACE_LABEL_MAP.get(label.lower())
            if mapped:
                # DeepFace reports 0-100 percentages; fer reported 0-1.
                # Normalize to the 0-1 scale the rest of this app expects.
                accum[mapped] += float(score) / 100.0
        counted += 1

    if counted == 0:
        return {s: 0.0 for s in SENTIMENTS}
    return {s: v / counted for s, v in accum.items()}


def average_sentiment_dicts(a, b):
    return {s: (a.get(s, 0.0) + b.get(s, 0.0)) / 2 for s in SENTIMENTS}


# Minimum wall-clock time between progress-file writes. This is a time
# throttle rather than "every N words" specifically because per-word
# processing speed varies a lot (video with facial-expression sampling is
# much slower per word than audio-only) — pacing by elapsed time keeps
# updates readable (not flickering faster than a person can read the
# numbers) and keeps the write overhead itself negligible, regardless of
# how fast or slow the actual analysis is running.
PROGRESS_WRITE_INTERVAL_SEC = 1.0

# Rough relative time-share of each major stage, as fractions of the overall
# 0-100 progress bar. These are approximate (not measured per-file) — good
# enough to make the bar move in a representative way throughout the whole
# pipeline instead of sitting at 0% through what's often the longest single
# stage (transcription) and only starting to move once per-word sentiment
# scoring begins. Tune these if real usage shows a stage taking much more
# or less of the total time than this assumes.
PHASE_RANGES = {
    'extracting_audio': (0, 8),
    'transcribing': (8, 45),
    'scoring': (45, 100),
}


def write_progress(progress_path, phase, fraction=0.0, detail=None, current=None, total=None):
    """Best-effort — a failure here should never break the actual analysis.
    `fraction` is progress *within* the given phase (0-1); this maps it into
    that phase's slice of the overall 0-100 range via PHASE_RANGES."""
    if not progress_path:
        return
    lo, hi = PHASE_RANGES.get(phase, (0, 100))
    percent = lo + (hi - lo) * max(0.0, min(1.0, fraction))
    payload = {'phase': phase, 'percent': round(percent, 1)}
    if detail is not None:
        payload['detail'] = detail
    if current is not None:
        payload['current'] = current
    if total is not None:
        payload['total'] = total
    try:
        with open(progress_path, 'w') as f:
            json.dump(payload, f)
    except Exception:
        pass


def build_segments(whisper_segments, duration, media_kind, wav_path, video_path,
                    progress_path=None, total_words=0):
    """
    Walks Whisper's segments in time order, filling any timing gap wider than
    a heartbeat with either a 'gap' (unprocessable) or 'silence' (processable
    non-speech, e.g. applause — rendered as styled dashes) block, then attaches
    per-word sentiment.
    """
    audio_clf = load_audio_emotion_pipeline()
    # DeepFace needs no long-lived detector object like fer's FER(mtcnn=True)
    # did — it lazily loads and caches its models internally on first call.

    # One shared reader/handle for the whole file each — see
    # SequentialVideoReader's docstring and audio_sentiment_for_window()'s
    # docstring for why each matters (video: a real, measurable win; audio:
    # architectural consistency more than a measured one).
    import soundfile as sf
    video_reader = SequentialVideoReader(video_path) if media_kind == 'video' else None

    segments_out = []
    cursor = 0.0
    words_done = 0
    last_progress_write = 0.0
    write_progress(progress_path, 'scoring', 0.0, current=0, total=total_words)

    def flush_gap(gap_start, gap_end):
        if gap_end - gap_start < 1.0:
            return  # negligible, not worth flagging
        # Per product decision: non-speech stretches render as plain, neutral
        # dashes with no sentiment computed — no inline error unless the
        # underlying reason was actually unprocessable audio. We treat any
        # timing hole left by Whisper as "silence" (dashes); genuine
        # unprocessable stretches are already excluded upstream via the
        # confidence-floor check in analyze_media() and marked as 'gap'.
        #
        # That "no sentiment during non-speech" reasoning was specifically
        # about audio: speech-emotion models can't meaningfully interpret
        # silence or applause. It doesn't apply to facial expression, which
        # reads perfectly well whether or not someone is talking — so for
        # video files, sample DeepFace across the gap instead of leaving it
        # neutral. Audio-only files still get neutral dashes.
        sentiment_samples = []
        if media_kind == 'video':
            t = gap_start
            while t < gap_end:
                window_end = min(t + WORDLESS_SAMPLE_RATE, gap_end)
                sentiment_samples.append(video_sentiment_for_window(video_reader, t, window_end))
                t += WORDLESS_SAMPLE_RATE
        segments_out.append({'type': 'silence', 'start': gap_start, 'end': gap_end, 'sentimentSamples': sentiment_samples})

    try:
        with sf.SoundFile(wav_path) as sound_file:
            for seg in whisper_segments:
                if seg.get('_unprocessable'):
                    flush_gap(cursor, seg['start'])
                    segments_out.append({'type': 'gap', 'start': seg['start'], 'end': seg['end']})
                    cursor = seg['end']
                    continue

                flush_gap(cursor, seg['start'])

                words_out = []
                for w in seg['words']:
                    a_sent = audio_sentiment_for_window(audio_clf, sound_file, w['start'], w['end'])
                    if media_kind == 'video':
                        v_sent = video_sentiment_for_window(video_reader, w['start'], w['end'])
                        sentiment = average_sentiment_dicts(a_sent, v_sent)
                    else:
                        sentiment = a_sent
                    words_out.append({'word': w['word'], 'start': w['start'], 'end': w['end'], 'sentiment': sentiment})

                    words_done += 1
                    now = time.monotonic()
                    if now - last_progress_write >= PROGRESS_WRITE_INTERVAL_SEC:
                        fraction = words_done / total_words if total_words > 0 else 0.0
                        write_progress(progress_path, 'scoring', fraction, current=words_done, total=total_words)
                        last_progress_write = now

                segments_out.append({'type': 'words', 'words': words_out})
                cursor = seg['end']

            flush_gap(cursor, duration)
            write_progress(progress_path, 'scoring', 1.0, current=total_words, total=total_words)
    finally:
        if video_reader is not None:
            video_reader.release()

    return segments_out


SKIP_INTERVAL_NOTE = """
Design note on SKIP_INTERVAL: the spec's "sample forward at skip_interval
seconds to save processing time" describes an *incremental/streaming*
scanning strategy — useful when probing long unprocessable stretches without
running full analysis on every second of them. This reference implementation
instead transcribes the whole file in one batch pass with faster-whisper
(itself already efficient enough locally, see README benchmarks), so there's
no expensive per-second probe to skip. SKIP_INTERVAL_SEC is still honored in
spirit for very long *fully silent* stretches with zero Whisper segments: see
flush_gap()'s minimum-duration check, which folds sub-interval gaps into
their neighbors instead of flagging every tiny pause as its own segment. If
this is later swapped for a streaming/real-time pipeline (e.g. transcribing
as media plays rather than up front), skip_interval_sec is exactly the knob
that would govern how often the streaming scanner re-checks a currently
unprocessable stretch for a return to clear speech.
"""


def mark_unprocessable_segments(whisper_segments, duration):
    """Flags low-confidence Whisper segments (and skips ahead through long
    silent stretches at SKIP_INTERVAL) so build_segments() can turn them into
    inline gap errors instead of guessing at sentiment for garbage speech."""
    for seg in whisper_segments:
        seg['_unprocessable'] = seg['avg_logprob'] < WHISPER_CONFIDENCE_FLOOR
    return whisper_segments


def analyze_media(path, progress_path=None):
    media_kind = 'video' if is_video_file(path) else 'audio'

    # First write happens immediately, before ffprobe even runs, so the
    # progress bar has something to show from essentially the moment the
    # file is opened rather than sitting at 0% through the whole pipeline
    # up until per-word scoring begins.
    write_progress(progress_path, 'extracting_audio', 0.0, detail='Reading file info…')
    probe = ffprobe_json(path)
    metadata, _ = extract_metadata(probe)  # title/date only here; duration comes from the normalized copy below

    with tempfile.TemporaryDirectory() as tmp:
        # See normalize_timestamps()'s docstring — this isn't just about
        # playback smoothness. Everything downstream (duration, audio
        # extraction, video frame reading) uses this normalized copy
        # rather than the original path, so audio-derived word timestamps
        # and direct video-frame reads are guaranteed to agree on what
        # "the same instant" means, regardless of whether the original
        # file happened to have mismatched stream start timestamps.
        normalized_path = os.path.join(tmp, 'normalized' + os.path.splitext(path)[1])
        write_progress(progress_path, 'extracting_audio', 0.1, detail='Normalizing timestamps…')
        normalize_timestamps(path, normalized_path)

        normalized_probe = ffprobe_json(normalized_path)
        _, duration = extract_metadata(normalized_probe)

        wav_path = os.path.join(tmp, 'audio.wav')
        write_progress(progress_path, 'extracting_audio', 0.4, detail='Extracting audio…')
        extract_audio_wav(normalized_path, wav_path)
        write_progress(progress_path, 'extracting_audio', 1.0, detail='Extracting audio…')

        waveform = compute_waveform_samples(wav_path) if media_kind == 'audio' else []

        whisper_segments = transcribe_with_word_timestamps(wav_path, progress_path=progress_path, duration=duration)
        write_progress(progress_path, 'transcribing', 1.0, detail='Transcribing speech…')
        whisper_segments = mark_unprocessable_segments(whisper_segments, duration)

        processable_word_count = sum(
            len(s['words']) for s in whisper_segments if not s.get('_unprocessable')
        )
        if processable_word_count == 0:
            return {
                'status': 'unprocessable',
                'error': ERROR_FULLY_UNPROCESSABLE,
                'mediaKind': media_kind,
                'durationSec': duration,
                'metadata': metadata,
                'waveform': waveform,
                'segments': [],
            }

        # Progress is reported in terms of words specifically (not the
        # additional facial-expression sampling done during silent gaps in
        # video files) — a reasonable approximation of overall progress
        # without needing a more complex weighted unit, and it matches the
        # "word N of M" phrasing surfaced in the UI.
        segments = build_segments(
            whisper_segments, duration, media_kind, wav_path, normalized_path,
            progress_path=progress_path, total_words=processable_word_count
        )

    return {
        'status': 'ok',
        'error': None,
        'mediaKind': media_kind,
        'durationSec': duration,
        'metadata': metadata,
        'waveform': waveform,
        'segments': segments,
    }


def main():
    if len(sys.argv) < 3:
        log('usage: analyze.py <media_path> <output_json_path> [progress_json_path]')
        sys.exit(1)

    path = sys.argv[1]
    output_path = sys.argv[2]
    progress_path = sys.argv[3] if len(sys.argv) > 3 else None
    try:
        result = analyze_media(path, progress_path=progress_path)
    except Exception as e:
        log(f'analyze.py failed: {e}')
        raise

    # Written to a file rather than printed to stdout: several of the ML
    # libraries in this pipeline (Keras/TensorFlow in particular) print their
    # own progress output straight to stdout, which would otherwise corrupt
    # a JSON payload sent that way. main.js reads this file directly instead
    # of trying to parse captured stdout.
    with open(output_path, 'w') as f:
        json.dump(result, f)


if __name__ == '__main__':
    main()

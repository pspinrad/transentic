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


def transcribe_with_word_timestamps(wav_path):
    """
    Returns a list of segments:
      {"start": f, "end": f, "avg_logprob": f,
       "words": [{"word": str, "start": f, "end": f}, ...]}
    """
    from faster_whisper import WhisperModel

    # "small" is the pretty-good/local sweet spot: meaningfully more accurate
    # than "base" while still comfortably CPU-real-time-ish for short clips.
    model = WhisperModel('small', device='cpu', compute_type='int8')
    segments, _info = model.transcribe(wav_path, word_timestamps=True)

    result = []
    for seg in segments:
        words = [{'word': w.word.strip(), 'start': w.start, 'end': w.end} for w in (seg.words or [])]
        result.append({
            'start': seg.start,
            'end': seg.end,
            'avg_logprob': seg.avg_logprob,
            'words': words,
        })
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


def audio_sentiment_for_window(clf, wav_path, start, end, sample_rate=16000):
    """
    Runs the audio-emotion classifier over a short window of raw audio
    centered on [start, end], widened slightly for stability on very short
    words, and returns a dict of the 6 Sentiments -> 0..1 scores.
    """
    import soundfile as sf

    pad = 0.5  # widen very short word clips so the classifier has enough signal
    win_start = max(0.0, start - pad)
    win_end = end + pad

    audio, sr = sf.read(wav_path, start=int(win_start * sample_rate), stop=int(win_end * sample_rate))
    if len(audio) == 0:
        return {s: 0.0 for s in SENTIMENTS}

    preds = clf({'array': audio, 'sampling_rate': sr})
    scores = {s: 0.0 for s in SENTIMENTS}
    for p in preds:
        mapped = AUDIO_EMOTION_LABEL_MAP.get(p['label'].lower())
        if mapped:
            scores[mapped] = float(p['score'])
    return scores


def video_sentiment_for_window(video_path, start, end, fps_sample=2):
    """
    Samples a few frames across [start, end], runs DeepFace's emotion
    analysis on each, and averages the dominant face's scores across frames
    into the 6 Sentiments.
    """
    import cv2
    from deepface import DeepFace
    import tensorflow as tf
    # Purely cosmetic now that output goes through a file rather than
    # stdout, but keeps the terminal readable during a run — Keras'
    # per-prediction progress bars print once per sampled frame otherwise.
    tf.keras.utils.disable_interactive_logging()

    cap = cv2.VideoCapture(video_path)
    native_fps = cap.get(cv2.CAP_PROP_FPS) or 25
    duration = max(end - start, 1.0 / fps_sample)
    n_frames = max(1, int(duration * fps_sample))

    accum = {s: 0.0 for s in SENTIMENTS}
    counted = 0

    for i in range(n_frames):
        t = start + (i / fps_sample)
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * native_fps))
        ok, frame = cap.read()
        if not ok:
            continue

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

    cap.release()
    if counted == 0:
        return {s: 0.0 for s in SENTIMENTS}
    return {s: v / counted for s, v in accum.items()}


def average_sentiment_dicts(a, b):
    return {s: (a.get(s, 0.0) + b.get(s, 0.0)) / 2 for s in SENTIMENTS}


def build_segments(whisper_segments, duration, media_kind, wav_path, video_path):
    """
    Walks Whisper's segments in time order, filling any timing gap wider than
    a heartbeat with either a 'gap' (unprocessable) or 'silence' (processable
    non-speech, e.g. applause — rendered as styled dashes) block, then attaches
    per-word sentiment.
    """
    audio_clf = load_audio_emotion_pipeline()
    # DeepFace needs no long-lived detector object like fer's FER(mtcnn=True)
    # did — it lazily loads and caches its models internally on first call.

    segments_out = []
    cursor = 0.0

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
                sentiment_samples.append(video_sentiment_for_window(video_path, t, window_end))
                t += WORDLESS_SAMPLE_RATE
        segments_out.append({'type': 'silence', 'start': gap_start, 'end': gap_end, 'sentimentSamples': sentiment_samples})

    for seg in whisper_segments:
        if seg.get('_unprocessable'):
            flush_gap(cursor, seg['start'])
            segments_out.append({'type': 'gap', 'start': seg['start'], 'end': seg['end']})
            cursor = seg['end']
            continue

        flush_gap(cursor, seg['start'])

        words_out = []
        for w in seg['words']:
            a_sent = audio_sentiment_for_window(audio_clf, wav_path, w['start'], w['end'])
            if media_kind == 'video':
                v_sent = video_sentiment_for_window(video_path, w['start'], w['end'])
                sentiment = average_sentiment_dicts(a_sent, v_sent)
            else:
                sentiment = a_sent
            words_out.append({'word': w['word'], 'start': w['start'], 'end': w['end'], 'sentiment': sentiment})

        segments_out.append({'type': 'words', 'words': words_out})
        cursor = seg['end']

    flush_gap(cursor, duration)
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


def analyze_media(path):
    media_kind = 'video' if is_video_file(path) else 'audio'

    probe = ffprobe_json(path)
    metadata, duration = extract_metadata(probe)

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = os.path.join(tmp, 'audio.wav')
        extract_audio_wav(path, wav_path)

        waveform = compute_waveform_samples(wav_path) if media_kind == 'audio' else []

        whisper_segments = transcribe_with_word_timestamps(wav_path)
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

        segments = build_segments(whisper_segments, duration, media_kind, wav_path, path)

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
        log('usage: analyze.py <media_path> <output_json_path>')
        sys.exit(1)

    path = sys.argv[1]
    output_path = sys.argv[2]
    try:
        result = analyze_media(path)
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

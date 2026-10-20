"""음 추출 — Spotify Basic Pitch (맥에서는 CoreML 모델 사용)."""
from __future__ import annotations

import contextlib
import io
import os
import warnings
from pathlib import Path

from .model import Note


def transcribe(wav_path: str | Path, onset_threshold: float = 0.5, frame_threshold: float = 0.3,
               min_note_ms: float = 60.0, min_freq: float = 70.0, max_freq: float = 1500.0,
               midi_out: str | Path | None = None) -> tuple[list[Note], str]:
    """wav → Note 목록. 두 번째 반환값은 사용한 모델 백엔드 설명."""
    warnings.filterwarnings("ignore")
    import logging
    logging.getLogger().setLevel(logging.ERROR)
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    backend = Path(str(ICASSP_2022_MODEL_PATH)).suffix.lstrip(".") or "unknown"
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):   # coreml 디버그 출력 숨김
        _, midi_data, events = predict(
            str(wav_path), ICASSP_2022_MODEL_PATH,
            onset_threshold=onset_threshold, frame_threshold=frame_threshold,
            minimum_note_length=min_note_ms, minimum_frequency=min_freq, maximum_frequency=max_freq,
            multiple_pitch_bends=False, melodia_trick=True,
        )
    if midi_out:
        midi_data.write(str(midi_out))
    notes = [Note(start=float(s), end=float(e), midi=int(p), conf=float(a)) for s, e, p, a, _ in events]
    notes.sort(key=lambda n: (n.start, -n.midi))
    return notes, f"basic-pitch {backend}"
